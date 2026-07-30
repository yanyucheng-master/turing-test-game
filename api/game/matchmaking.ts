import { randomUUID } from "node:crypto";
import { MAX_PLAYER_MESSAGES, TIME_LIMIT_SEC } from "@contracts/types";
import type { MatchStatus, OpponentSource, Persona } from "@contracts/types";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { hasDatabase } from "../lib/env";
import { games } from "@db/schema";
import { JUDGE_RESPONSE_SEC } from "@contracts/types";
import {
  JUDGMENT_GRACE_MS,
  bindChatClock,
  closeChat,
  createAiSession,
  createPvpPair,
  deleteSession,
  enqueueImmediateSystemMessage,
  getRoom,
  getSession,
} from "./store";
import { pickSocialPersona } from "./socialPersonas";
import { startClaimedOpening } from "./aiWorker";

/** Independent AI-entry deadline ceiling. */
export const MATCH_MAX_MS = 7_000;
/** Independent human-match cold window ceiling. */
export const COLD_MATCH_MAX_MS = 2_000;

type TicketStatus = "searching" | "resolving" | "matched" | "cancelled";

interface Ticket {
  id: string;
  joinedAt: number;
  /** Immutable personal AI deadline. AI wins at this exact instant. */
  aiEntryAt: number;
  /** Until this instant, this ticket cannot match a human. */
  coldUntil: number;
  /** FIFO tie-breaker for players entering the human pool together. */
  queueSeq: number;
  status: TicketStatus;
  gameId?: string;
  /** Shared chat start / result-ready time after a match is committed. */
  matchedAt?: number;
  claimedAt?: number;
  /** Server-only; never sent in matched payload. */
  opponentSource?: OpponentSource;
}

const tickets = new Map<string, Ticket>();
let nextTicketSeq = 0;

/** Test hooks — null restores random scheduling. */
let coldMatchMsOverride: number | null = null;
let aiEntryMsOverride: number | null = null;

export function __setColdMatchMsForTests(ms: number | null): void {
  coldMatchMsOverride = ms;
}

export function __setAiEntryMsForTests(ms: number | null): void {
  aiEntryMsOverride = ms;
}

/** @deprecated Test compatibility alias. */
export function __setTotalMatchMsForTests(ms: number | null): void {
  __setAiEntryMsForTests(ms);
}

/**
 * Two independent clocks:
 * - cold ∈ [0, 2s]: human pairing is forbidden before it ends;
 * - AI entry ∈ [0, 7s]: AI is committed at this instant, including ties.
 *
 * AI entry may be earlier than coldUntil. Such a ticket has no human window.
 */
function rollMatchSchedule(joinedAt: number): {
  coldUntil: number;
  aiEntryAt: number;
} {
  const coldMs =
    coldMatchMsOverride !== null
      ? Math.min(Math.max(0, coldMatchMsOverride), COLD_MATCH_MAX_MS)
      : Math.floor(Math.random() * (COLD_MATCH_MAX_MS + 1));
  const aiEntryMs =
    aiEntryMsOverride !== null
      ? Math.min(Math.max(0, aiEntryMsOverride), MATCH_MAX_MS)
      : Math.floor(Math.random() * (MATCH_MAX_MS + 1));

  return {
    coldUntil: joinedAt + coldMs,
    aiEntryAt: joinedAt + aiEntryMs,
  };
}

/** @deprecated Use rollMatchSchedule — kept for older test names. */
export function calculateCohortRevealAt(joinedAt: number): number {
  return joinedAt + MATCH_MAX_MS;
}

function pruneTickets() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, t] of tickets) {
    if (t.joinedAt < cutoff) tickets.delete(id);
  }
}

/** Human interval is [coldUntil, aiEntryAt); AI wins the right boundary. */
function isPairableAt(t: Ticket, at: number): boolean {
  return (
    !t.gameId &&
    t.status === "searching" &&
    t.coldUntil <= at &&
    at < t.aiEntryAt
  );
}

function searchingPayload(ticket: Ticket, now: number): MatchStatus {
  return {
    status: "searching",
    // UI shows elapsed only — ceiling is not displayed.
    elapsedMs: Math.max(0, now - ticket.joinedAt),
    matchWindowSec: Math.ceil(MATCH_MAX_MS / 1000),
  };
}

export function joinMatch(): { ticketId: string; joinedAt: number } {
  pruneTickets();
  const joinedAt = Date.now();
  const { coldUntil, aiEntryAt } = rollMatchSchedule(joinedAt);
  const ticket: Ticket = {
    id: randomUUID(),
    joinedAt,
    aiEntryAt,
    coldUntil,
    queueSeq: nextTicketSeq++,
    status: "searching",
  };
  tickets.set(ticket.id, ticket);
  resolveQueue(joinedAt);
  return { ticketId: ticket.id, joinedAt };
}

async function markGamesCancelled(ids: string[]): Promise<void> {
  if (!ids.length || !hasDatabase()) return;
  try {
    const db = getDb();
    for (const id of ids) {
      await db
        .update(games)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(games.id, id));
    }
  } catch (err) {
    console.error("[match] cancel db update failed:", err);
  }
}

function findTicketByGameId(gameId: string): Ticket | undefined {
  for (const t of tickets.values()) {
    if (t.gameId === gameId) return t;
  }
  return undefined;
}

function requeueTicket(other: Ticket): void {
  const now = Date.now();
  other.gameId = undefined;
  other.matchedAt = undefined;
  other.opponentSource = undefined;
  other.status = "searching";
  other.claimedAt = undefined;
  other.joinedAt = now;
  other.queueSeq = nextTicketSeq++;
  const sched = rollMatchSchedule(now);
  other.aiEntryAt = sched.aiEntryAt;
  other.coldUntil = sched.coldUntil;
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
    const id = ticket.gameId;
    deleteSession(id);
    void markGamesCancelled([id]);
  } else if (session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    const otherSeat = session.seat === "a" ? "b" : "a";
    const peerId = room?.seats[otherSeat];
    const peerTicket = peerId ? findTicketByGameId(peerId) : undefined;
    const peerClaimed = !!peerTicket?.claimedAt || !!room?.claims[otherSeat];

    if (peerClaimed && peerId) {
      // Peer already in chat — do NOT delete their session.
      if (room) room.left[session.seat] = true;
      deleteSession(ticket.gameId);
      void markGamesCancelled([ticket.gameId]);
      const peer = getSession(peerId);
      if (peer) {
        closeChat(peer, "opponent_left");
        if (!peer.localNotices.some(n => n.includes("对方已离开"))) {
          enqueueImmediateSystemMessage(peer, "对方已离开，请做出你的判断");
          peer.localNotices.push("对方已离开，请做出你的判断");
        }
        // Leaver times out; remaining player gets a normal judgment window.
        if (room && !room.verdicts[session.seat]) {
          room.verdicts[session.seat] = {
            guess: null,
            timedOut: true,
            at: Date.now(),
          };
          if (!room.firstFinisher) {
            room.firstFinisher = session.seat;
          }
          room.responseDeadline = Date.now() + JUDGE_RESPONSE_SEC * 1000;
        }
        if (!peer.judgmentDeadlineAt) {
          peer.judgmentDeadlineAt = Date.now() + JUDGMENT_GRACE_MS;
        }
      }
    } else {
      // Neither side claimed — tear down room and requeue peer.
      const ids = [ticket.gameId, peerId].filter(Boolean) as string[];
      deleteSession(ticket.gameId);
      if (peerId) deleteSession(peerId);
      void markGamesCancelled(ids);
      if (peerTicket && peerTicket.id !== ticket.id) {
        requeueTicket(peerTicket);
      }
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

async function persistGameOnClaim(
  gameId: string,
  persona: "human" | "machine"
): Promise<void> {
  if (!hasDatabase()) return;
  try {
    await getDb().insert(games).values({ id: gameId, persona });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("Duplicate") && !msg.includes("ER_DUP_ENTRY")) {
      console.error("[match] claim db insert failed:", err);
    }
  }
}

/** Client handshake after receiving matched — also persists DB row. */
export function acceptMatch(ticketId: string, gameId: string): boolean {
  const t = tickets.get(ticketId);
  if (!t || t.status === "cancelled") return false;
  if (t.gameId !== gameId || t.status !== "matched") return false;
  if (t.matchedAt === undefined || Date.now() < t.matchedAt) return false;

  const session = getSession(gameId);
  if (!session) return false;

  t.claimedAt = Date.now();
  bindChatClock(session, t.matchedAt);

  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    if (room) room.claims[session.seat] = true;
  }

  void persistGameOnClaim(
    gameId,
    session.opponentSource === "llm" ? "machine" : "human"
  );
  startClaimedOpening(session);
  return true;
}

/** First events/chat acts as claim if acceptMatch was lost on the wire. */
export function ensureClaimedByGameId(gameId: string): void {
  const t = findTicketByGameId(gameId);
  if (!t || t.claimedAt || t.status !== "matched") return;
  if (t.matchedAt === undefined || Date.now() < t.matchedAt) return;
  acceptMatch(t.id, gameId);
}

function compareFifo(a: Ticket, b: Ticket): number {
  return (
    a.coldUntil - b.coldUntil ||
    a.joinedAt - b.joinedAt ||
    a.queueSeq - b.queueSeq
  );
}

function pairNextHumansAt(at: number): boolean {
  const pair = [...tickets.values()]
    .filter(ticket => isPairableAt(ticket, at))
    .sort(compareFifo)
    .slice(0, 2);
  if (pair.length < 2) return false;
  const [first, second] = pair;

  first.status = "resolving";
  second.status = "resolving";

  const gameIdA = randomUUID();
  const gameIdB = randomUUID();
  const { sessionA, sessionB, room } = createPvpPair(gameIdA, gameIdB);

  // Both human windows first overlap at `at`; chat starts immediately there.
  bindChatClock(sessionA, at);
  bindChatClock(sessionB, at);
  room.chatStartedAt = at;
  room.chatDeadlineAt = at + TIME_LIMIT_SEC * 1000;

  // DB rows are inserted on accept — avoids active orphans from cancel.
  finalizeMatched(first, { gameId: gameIdA, opponentSource: "player" }, at);
  finalizeMatched(second, { gameId: gameIdB, opponentSource: "player" }, at);
  return true;
}

function finalizeMatched(
  ticket: Ticket,
  info: { gameId: string; opponentSource: OpponentSource },
  matchedAt: number
) {
  ticket.status = "matched";
  ticket.gameId = info.gameId;
  ticket.opponentSource = info.opponentSource;
  ticket.matchedAt = matchedAt;
}

/**
 * Commit AI at the immutable personal deadline. Human matching is not retried:
 * resolveQueue already processed every earlier human-window event.
 */
function startAiGame(ticket: Ticket, at: number): void {
  if (ticket.status !== "searching" || ticket.gameId) return;
  ticket.status = "resolving";

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
    social.id
  );
  bindChatClock(session, at);

  finalizeMatched(ticket, { gameId, opponentSource: "llm" }, at);

  // Opening: usually wait for the player; rarely speak first.
  // immediate ~12% · delayed ~18% · wait ~70%
  const roll = Math.random();
  session.pendingOpenStyle =
    roll < 0.12 ? "immediate" : roll < 0.3 ? "delayed" : "wait";
  // Among wait matches, often never initiate (silence forever until player talks).
  // Also a small chance on delayed openers to abort into silent wait.
  session.neverSpeakFirst =
    session.pendingOpenStyle === "wait"
      ? Math.random() < 0.4
      : session.pendingOpenStyle === "delayed" && Math.random() < 0.15;
  if (session.neverSpeakFirst && session.pendingOpenStyle === "delayed") {
    session.pendingOpenStyle = "wait";
  }
  // May ignore the player's first message with no reaction.
  session.ignoreFirstPlayerMsg = Math.random() < 0.32;
}

/**
 * Resolve due matchmaking events in chronological order. This makes the
 * outcome independent of the clients' 400ms poll cadence:
 * - AI deadlines are processed before human pairing at the same timestamp;
 * - after expirations, every eligible human pair is committed FIFO.
 */
function resolveQueue(now = Date.now()): void {
  const dueTimes = new Set<number>();
  for (const ticket of tickets.values()) {
    if (ticket.status !== "searching" || ticket.gameId) continue;
    if (ticket.aiEntryAt <= now) dueTimes.add(ticket.aiEntryAt);
    if (ticket.coldUntil <= now) dueTimes.add(ticket.coldUntil);
  }

  const orderedTimes = [...dueTimes].sort((a, b) => a - b);
  for (const at of orderedTimes) {
    const aiDue = [...tickets.values()]
      .filter(
        ticket =>
          ticket.status === "searching" &&
          !ticket.gameId &&
          ticket.aiEntryAt <= at
      )
      .sort((a, b) => a.aiEntryAt - b.aiEntryAt || compareFifo(a, b));
    for (const ticket of aiDue) {
      startAiGame(ticket, ticket.aiEntryAt);
    }

    while (pairNextHumansAt(at)) {
      // Pair all currently eligible tickets at this event time.
    }
  }
}

export async function pollMatch(ticketId: string): Promise<MatchStatus> {
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.status === "cancelled") {
    return { status: "cancelled" };
  }

  const now = Date.now();
  resolveQueue(now);

  if (ticket.status === "matched" && ticket.gameId) {
    return matchedPayload(ticket);
  }

  return searchingPayload(ticket, now);
}

function matchedPayload(ticket: Ticket): MatchStatus {
  const chatStartedAt = ticket.matchedAt!;
  return {
    status: "matched",
    gameId: ticket.gameId!,
    timeLimitSec: TIME_LIMIT_SEC,
    maxPlayerMessages: MAX_PLAYER_MESSAGES,
    chatStartedAt,
    chatDeadlineAt: chatStartedAt + TIME_LIMIT_SEC * 1000,
  };
}

/** Test helper — inspect ticket reveal scheduling without exposing identity. */
export function __debugTicket(ticketId: string) {
  const t = tickets.get(ticketId);
  if (!t) return null;
  return {
    status: t.status,
    joinedAt: t.joinedAt,
    /** Compatibility alias: AI deadline before commit, match time after. */
    revealAt: t.matchedAt ?? t.aiEntryAt,
    aiEntryAt: t.aiEntryAt,
    matchedAt: t.matchedAt,
    coldUntil: t.coldUntil,
    hasGame: !!t.gameId,
    claimed: !!t.claimedAt,
  };
}

/** Test-only: clear in-memory matchmaking state. */
export function __resetMatchmakingForTests() {
  tickets.clear();
  nextTicketSeq = 0;
  coldMatchMsOverride = null;
  aiEntryMsOverride = null;
}
