import { randomUUID } from "node:crypto";
import {
  MATCH_WINDOW_SEC,
  MAX_PLAYER_MESSAGES,
  TIME_LIMIT_SEC,
} from "@contracts/types";
import type { MatchStatus, OpponentSource, Persona } from "@contracts/types";
import { getDb } from "../queries/connection";
import { games } from "@db/schema";
import {
  createAiSession,
  createPvpPair,
  deleteSession,
  getRoom,
  getSession,
} from "./store";
import { beginSilentMatch } from "./proactive";
import { pickSocialPersona } from "./socialPersonas";
import { queueOpeningTurn } from "./aiWorker";

const MATCH_WINDOW_MS = MATCH_WINDOW_SEC * 1000;
/** Identity-blind reveal delay shared by human and AI matches. */
const MATCH_MASK_MIN_MS = 800;
const MATCH_MASK_SPAN_MS = 2_200;

type TicketStatus = "searching" | "resolving" | "matched" | "cancelled";

interface Ticket {
  id: string;
  joinedAt: number;
  /** Earliest time this ticket may show matched (set at join). */
  visibleMatchedAt: number;
  /** Actual reveal time (PVP partners share max of both). */
  revealAt: number;
  status: TicketStatus;
  gameId?: string;
  claimedAt?: number;
  /** Server-only; never sent in matched payload. */
  opponentSource?: OpponentSource;
}

const tickets = new Map<string, Ticket>();

function rollVisibleMatchedAt(joinedAt: number): number {
  return joinedAt + MATCH_MASK_MIN_MS + Math.random() * MATCH_MASK_SPAN_MS;
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

function searchingPayload(ticket: Ticket, now: number): MatchStatus {
  return {
    status: "searching",
    elapsedMs: Math.min(MATCH_WINDOW_MS, now - ticket.joinedAt),
    matchWindowSec: MATCH_WINDOW_SEC,
  };
}

export function joinMatch(): { ticketId: string; joinedAt: number } {
  pruneTickets();
  const joinedAt = Date.now();
  const visibleMatchedAt = rollVisibleMatchedAt(joinedAt);
  const ticket: Ticket = {
    id: randomUUID(),
    joinedAt,
    visibleMatchedAt,
    revealAt: visibleMatchedAt,
    status: "searching",
  };
  tickets.set(ticket.id, ticket);
  tryPairHumans(ticket);
  return { ticketId: ticket.id, joinedAt };
}

function cleanupUnclaimedGame(ticket: Ticket): void {
  if (!ticket.gameId || ticket.claimedAt) return;
  const session = getSession(ticket.gameId);
  if (!session) {
    ticket.gameId = undefined;
    ticket.opponentSource = undefined;
    return;
  }

  if (session.mode === "ai") {
    deleteSession(ticket.gameId);
  } else if (session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    const otherSeat = session.seat === "a" ? "b" : "a";
    const peerId = room?.seats[otherSeat];
    deleteSession(ticket.gameId);
    if (peerId) deleteSession(peerId);
    for (const other of tickets.values()) {
      if (other.id === ticket.id) continue;
      if (other.gameId !== peerId || other.claimedAt) continue;
      other.gameId = undefined;
      other.opponentSource = undefined;
      other.status = "searching";
      other.visibleMatchedAt = rollVisibleMatchedAt(Date.now());
      other.revealAt = other.visibleMatchedAt;
    }
  }

  ticket.gameId = undefined;
  ticket.opponentSource = undefined;
}

export function cancelMatch(ticketId: string): void {
  const t = tickets.get(ticketId);
  if (!t) return;
  if (t.claimedAt) return;
  if (t.gameId) cleanupUnclaimedGame(t);
  t.status = "cancelled";
}

/** Client handshake after receiving matched — prevents cancel orphans. */
export function acceptMatch(ticketId: string, gameId: string): boolean {
  const t = tickets.get(ticketId);
  if (!t || t.status === "cancelled") return false;
  if (t.gameId !== gameId || t.status !== "matched") return false;
  if (Date.now() < t.revealAt) return false;
  t.claimedAt = Date.now();
  return true;
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

  const activateAt = Math.max(self.visibleMatchedAt, partner.visibleMatchedAt);
  finalizeMatched(self, { gameId: gameIdA, opponentSource: "player" }, activateAt);
  finalizeMatched(
    partner,
    { gameId: gameIdB, opponentSource: "player" },
    activateAt,
  );
  return true;
}

function finalizeMatched(
  ticket: Ticket,
  info: { gameId: string; opponentSource: OpponentSource },
  revealAt: number,
) {
  ticket.status = "matched";
  ticket.gameId = info.gameId;
  ticket.opponentSource = info.opponentSource;
  ticket.revealAt = revealAt;
}

/**
 * Commit AI match immediately — never await LLM or DB inside pollMatch.
 * Opening line is generated asynchronously into the outbox.
 * Reveal to client still waits for ticket.revealAt (identity-blind mask).
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

  finalizeMatched(
    ticket,
    { gameId, opponentSource: "llm" },
    ticket.visibleMatchedAt,
  );

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

  const now = Date.now();

  if (ticket.status === "matched" && ticket.gameId) {
    if (now < ticket.revealAt) return searchingPayload(ticket, now);
    return matchedPayload(ticket);
  }

  if (tryPairHumans(ticket)) {
    if (now < ticket.revealAt) return searchingPayload(ticket, now);
    return matchedPayload(ticket);
  }

  // Same decision window for AI as the visible mask — no late 0–10s AI tell.
  if (
    ticket.status === "searching" &&
    (now >= ticket.visibleMatchedAt || now >= ticket.joinedAt + MATCH_WINDOW_MS)
  ) {
    startAiGame(ticket);
    if (ticket.gameId) {
      if (now < ticket.revealAt) return searchingPayload(ticket, now);
      return matchedPayload(ticket);
    }
  }

  return searchingPayload(ticket, now);
}

function matchedPayload(ticket: Ticket): MatchStatus {
  return {
    status: "matched",
    gameId: ticket.gameId!,
    timeLimitSec: TIME_LIMIT_SEC,
    maxPlayerMessages: MAX_PLAYER_MESSAGES,
  };
}

/** Test helper — inspect ticket reveal scheduling without exposing identity. */
export function __debugTicket(ticketId: string) {
  const t = tickets.get(ticketId);
  if (!t) return null;
  return {
    status: t.status,
    joinedAt: t.joinedAt,
    visibleMatchedAt: t.visibleMatchedAt,
    revealAt: t.revealAt,
    hasGame: !!t.gameId,
    claimed: !!t.claimedAt,
  };
}

/** Test-only: clear in-memory matchmaking state. */
export function __resetMatchmakingForTests() {
  tickets.clear();
}
