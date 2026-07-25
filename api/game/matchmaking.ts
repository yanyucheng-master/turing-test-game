import { randomUUID } from "node:crypto";
import {
  MATCH_WINDOW_SEC,
  MAX_PLAYER_MESSAGES,
  TIME_LIMIT_SEC,
} from "@contracts/types";
import type { MatchStatus, OpponentSource, Persona } from "@contracts/types";
import { getDb } from "../queries/connection";
import { games } from "@db/schema";
import { createAiSession, createPvpPair } from "./store";
import { beginSilentMatch } from "./proactive";
import { pickSocialPersona } from "./socialPersonas";
import { queueOpeningTurn } from "./aiWorker";

const MATCH_WINDOW_MS = MATCH_WINDOW_SEC * 1000;

type TicketStatus = "searching" | "resolving" | "matched" | "cancelled";

interface Ticket {
  id: string;
  joinedAt: number;
  aiArriveAt: number;
  status: TicketStatus;
  gameId?: string;
  /** Server-only; never sent in matched payload. */
  opponentSource?: OpponentSource;
}

const tickets = new Map<string, Ticket>();

function rollAiArriveAt(joinedAt: number): number {
  const delay = Math.random() * MATCH_WINDOW_MS;
  return joinedAt + Math.max(200, delay);
}

function pruneTickets() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, t] of tickets) {
    if (t.joinedAt < cutoff) tickets.delete(id);
  }
}

/** Only searching tickets without a committed game can pair. */
function isPairable(t: Ticket): boolean {
  return !t.gameId && t.status === "searching";
}

export function joinMatch(): { ticketId: string; joinedAt: number } {
  pruneTickets();
  const joinedAt = Date.now();
  const ticket: Ticket = {
    id: randomUUID(),
    joinedAt,
    aiArriveAt: rollAiArriveAt(joinedAt),
    status: "searching",
  };
  tickets.set(ticket.id, ticket);
  tryPairHumans(ticket);
  return { ticketId: ticket.id, joinedAt };
}

export function cancelMatch(ticketId: string): void {
  const t = tickets.get(ticketId);
  if (!t || t.gameId) return;
  if (t.status === "searching" || t.status === "resolving") {
    t.status = "cancelled";
  }
}

function findPartner(self: Ticket): Ticket | undefined {
  for (const other of tickets.values()) {
    if (other.id === self.id) continue;
    if (!isPairable(other)) continue;
    return other;
  }
  return undefined;
}

function tryPairHumans(self: Ticket): boolean {
  if (!isPairable(self)) return false;
  const partner = findPartner(self);
  if (!partner) return false;

  self.status = "resolving";
  partner.status = "resolving";

  const gameIdA = randomUUID();
  const gameIdB = randomUUID();
  createPvpPair(gameIdA, gameIdB);

  void getDb()
    .insert(games)
    .values([
      { id: gameIdA, persona: "human" },
      { id: gameIdB, persona: "human" },
    ])
    .catch((err) => console.error("[match] pvp db insert failed:", err));

  finalizeMatched(self, { gameId: gameIdA, opponentSource: "player" });
  finalizeMatched(partner, { gameId: gameIdB, opponentSource: "player" });
  return true;
}

function finalizeMatched(
  ticket: Ticket,
  info: { gameId: string; opponentSource: OpponentSource },
) {
  ticket.status = "matched";
  ticket.gameId = info.gameId;
  ticket.opponentSource = info.opponentSource;
}

/**
 * Commit AI match immediately — never await LLM or DB inside pollMatch.
 * Opening line is generated asynchronously into the outbox.
 */
function startAiGame(ticket: Ticket): void {
  if (ticket.status !== "searching" || ticket.gameId) return;

  // Last human check before committing AI.
  if (tryPairHumans(ticket)) return;

  ticket.status = "resolving";
  if (tryPairHumans(ticket)) return;

  const social = pickSocialPersona();
  const persona: Persona = Math.random() < 0.5 ? "human" : "machine";
  const chaos = social.chaos === "troll" ? "troll" : social.chaos;
  const gameId = randomUUID();
  const session = createAiSession(
    gameId,
    persona,
    social.identity.blurb,
    social.tempo.pace,
    chaos,
    social.id,
  );

  // Atomic commit — pollMatch can return matched without waiting.
  finalizeMatched(ticket, { gameId, opponentSource: "llm" });

  void getDb()
    .insert(games)
    .values({ id: gameId, persona: "machine" })
    .catch((err) => console.error("[match] ai db insert failed:", err));

  const roll = Math.random();
  const openStyle: "immediate" | "delayed" | "wait" =
    roll < 0.4 ? "immediate" : roll < 0.7 ? "delayed" : "wait";

  if (openStyle === "wait") {
    beginSilentMatch(session);
  } else {
    queueOpeningTurn(session, openStyle);
  }
}

export async function pollMatch(ticketId: string): Promise<MatchStatus> {
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.status === "cancelled") {
    return { status: "cancelled" };
  }

  if (ticket.status === "matched" && ticket.gameId) {
    return matchedPayload(ticket);
  }

  if (tryPairHumans(ticket)) {
    return matchedPayload(ticket);
  }

  const now = Date.now();

  if (
    ticket.status === "searching" &&
    (now >= ticket.aiArriveAt || now >= ticket.joinedAt + MATCH_WINDOW_MS)
  ) {
    startAiGame(ticket);
    if (ticket.gameId) {
      return matchedPayload(ticket);
    }
  }

  return {
    status: "searching",
    elapsedMs: now - ticket.joinedAt,
    matchWindowSec: MATCH_WINDOW_SEC,
  };
}

function matchedPayload(ticket: Ticket): MatchStatus {
  return {
    status: "matched",
    gameId: ticket.gameId!,
    timeLimitSec: TIME_LIMIT_SEC,
    maxPlayerMessages: MAX_PLAYER_MESSAGES,
  };
}
