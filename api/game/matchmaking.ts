import { randomUUID } from "node:crypto";
import {
  MATCH_WINDOW_SEC,
  MAX_PLAYER_MESSAGES,
  TIME_LIMIT_SEC,
} from "@contracts/types";
import type { MatchStatus, OpponentSource, Persona } from "@contracts/types";
import { getDb } from "../queries/connection";
import { games } from "@db/schema";
import { callLLM } from "./llm";
import {
  pickPersonaCard,
  buildSystemPrompt,
  fallbackOpener,
  scrubReply,
  chaosOpener,
  OPENER_INSTRUCTION,
} from "./personas";
import { createAiSession, createPvpPair } from "./store";
import { beginSilentMatch, holdDelayedOpener } from "./proactive";

const MATCH_WINDOW_MS = MATCH_WINDOW_SEC * 1000;

type TicketStatus = "searching" | "resolving" | "matched" | "cancelled";

interface Ticket {
  id: string;
  joinedAt: number;
  /** Absolute timestamp when AI would join if no human appears first. */
  aiArriveAt: number;
  status: TicketStatus;
  gameId?: string;
  opener?: string;
  opponentSource?: OpponentSource;
}

const tickets = new Map<string, Ticket>();

/** Random AI arrival inside the 10s window (min 200ms so humans can snatch). */
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

/** Still in queue and not committed to a game — human can claim. */
function isPairable(t: Ticket): boolean {
  return (
    !t.gameId &&
    (t.status === "searching" || t.status === "resolving")
  );
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

/**
 * Human-priority pairing. Wins over a pending AI join as long as the AI
 * game has not been committed yet (even mid-opener generation).
 */
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

  finalizeMatched(self, {
    gameId: gameIdA,
    opener: "",
    opponentSource: "player",
  });
  finalizeMatched(partner, {
    gameId: gameIdB,
    opener: "",
    opponentSource: "player",
  });
  return true;
}

function finalizeMatched(
  ticket: Ticket,
  info: {
    gameId: string;
    opener: string;
    opponentSource: OpponentSource;
  },
) {
  ticket.status = "matched";
  ticket.gameId = info.gameId;
  ticket.opener = info.opener;
  ticket.opponentSource = info.opponentSource;
}

async function startAiGame(ticket: Ticket): Promise<void> {
  if (ticket.status !== "searching" || ticket.gameId) return;
  ticket.status = "resolving";

  // Last human check before spending LLM tokens.
  if (tryPairHumans(ticket)) return;

  const persona: Persona = Math.random() < 0.5 ? "human" : "machine";
  const card = pickPersonaCard(persona);
  const chaos = card.chaos ?? "sane";
  const gameId = randomUUID();
  const session = createAiSession(
    gameId,
    persona,
    card.blurb,
    card.pace,
    chaos,
  );

  // Who speaks first — vary like real strangers.
  // immediate ~40% | delayed ~30% | wait for player ~30%
  const roll = Math.random();
  const openStyle: "immediate" | "delayed" | "wait" =
    roll < 0.4 ? "immediate" : roll < 0.7 ? "delayed" : "wait";

  // Never put opener in the match payload — client should see typing first.
  const clientOpener = "";

  if (openStyle !== "wait") {
    const system = buildSystemPrompt(persona, card.blurb, chaos);
    const forcedChaosOpener = chaosOpener(chaos);
    let opener: string;
    if (forcedChaosOpener) {
      opener = forcedChaosOpener;
    } else {
      const rawOpener = await callLLM(
        system,
        [{ role: "user", content: OPENER_INSTRUCTION }],
        { maxTokens: 24, temperature: 1.05 },
      );
      opener = scrubReply(rawOpener ?? "") || fallbackOpener(persona);
    }

    // Human may have stolen the ticket while the opener was generating.
    if (
      ticket.gameId ||
      ticket.status === "matched" ||
      ticket.status === "cancelled"
    ) {
      return;
    }

    // immediate: short beat then typing; delayed: linger before speaking
    const noticeMs =
      openStyle === "immediate"
        ? 400 + Math.random() * 1_200
        : undefined;
    holdDelayedOpener(session, opener, noticeMs);
  } else {
    beginSilentMatch(session);
  }

  try {
    // DB persona marks opponent kind for stats (machine = LLM).
    // Session.persona stays as the speech disguise (human/machine style).
    await getDb().insert(games).values({ id: gameId, persona: "machine" });
  } catch (err) {
    console.error("[match] ai db insert failed:", err);
  }

  // Final human check after DB write, before commit.
  if (tryPairHumans(ticket)) return;
  if (ticket.gameId || ticket.status === "cancelled") return;

  finalizeMatched(ticket, {
    gameId,
    opener: clientOpener,
    opponentSource: "llm",
  });
}

/**
 * Resolve ticket state.
 * Priority: real human partner → AI at rolled arrive time → AI at 10s hard cap.
 */
export async function pollMatch(ticketId: string): Promise<MatchStatus> {
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.status === "cancelled") {
    return { status: "cancelled" };
  }

  if (ticket.status === "matched" && ticket.gameId) {
    return matchedPayload(ticket);
  }

  // 1) Human always wins if another pairable player exists.
  if (tryPairHumans(ticket)) {
    return matchedPayload(ticket);
  }

  const now = Date.now();

  // 2) AI arrives at random time (or hard 10s cap).
  if (
    ticket.status === "searching" &&
    (now >= ticket.aiArriveAt || now >= ticket.joinedAt + MATCH_WINDOW_MS)
  ) {
    await startAiGame(ticket);
    if (ticket.status === "matched" && ticket.gameId) {
      return matchedPayload(ticket);
    }
    if (ticket.status === "cancelled") {
      return { status: "cancelled" };
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
    opener: ticket.opener ?? "",
    timeLimitSec: TIME_LIMIT_SEC,
    maxPlayerMessages: MAX_PLAYER_MESSAGES,
    opponentSource: ticket.opponentSource ?? "llm",
  };
}
