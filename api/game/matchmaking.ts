import { randomUUID } from "node:crypto";
import { MAX_PLAYER_MESSAGES, TIME_LIMIT_SEC } from "@contracts/types";
import type { MatchStatus, OpponentSource, Persona } from "@contracts/types";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
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

/**
 * Shared reveal cohorts — every ticket in a cohort reveals at the same
 * absolute boundary, whether the opponent is human or AI.
 */
const COHORT_MS = 4_000;
const COHORT_MIN_LEAD_MS = 800;

type TicketStatus = "searching" | "resolving" | "matched" | "cancelled";

interface Ticket {
  id: string;
  joinedAt: number;
  /** Shared cohort boundary for this ticket. */
  revealAt: number;
  status: TicketStatus;
  gameId?: string;
  claimedAt?: number;
  /** Server-only; never sent in matched payload. */
  opponentSource?: OpponentSource;
}

const tickets = new Map<string, Ticket>();

export function calculateCohortRevealAt(joinedAt: number): number {
  return Math.ceil((joinedAt + COHORT_MIN_LEAD_MS) / COHORT_MS) * COHORT_MS;
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
  const windowMs = Math.max(
    1_000,
    ticket.revealAt - ticket.joinedAt,
  );
  return {
    status: "searching",
    elapsedMs: Math.min(windowMs, Math.max(0, now - ticket.joinedAt)),
    matchWindowSec: Math.max(1, Math.ceil(windowMs / 1000)),
  };
}

export function joinMatch(): { ticketId: string; joinedAt: number } {
  pruneTickets();
  const joinedAt = Date.now();
  const revealAt = calculateCohortRevealAt(joinedAt);
  const ticket: Ticket = {
    id: randomUUID(),
    joinedAt,
    revealAt,
    status: "searching",
  };
  tickets.set(ticket.id, ticket);
  tryPairHumans(ticket);
  return { ticketId: ticket.id, joinedAt };
}

async function markGamesCancelled(ids: string[]): Promise<void> {
  if (!ids.length) return;
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
  other.gameId = undefined;
  other.opponentSource = undefined;
  other.status = "searching";
  other.claimedAt = undefined;
  other.revealAt = calculateCohortRevealAt(Date.now());
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
        if (!peer.localNotices.some((n) => n.includes("对方已离开"))) {
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
          room.responseDeadline =
            Date.now() + JUDGE_RESPONSE_SEC * 1000;
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
  persona: "human" | "machine",
): Promise<void> {
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
  if (Date.now() < t.revealAt) return false;

  const session = getSession(gameId);
  if (!session) return false;

  t.claimedAt = Date.now();
  bindChatClock(session, t.revealAt);

  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    if (room) room.claims[session.seat] = true;
  }

  void persistGameOnClaim(
    gameId,
    session.opponentSource === "llm" ? "machine" : "human",
  );
  startClaimedOpening(session);
  return true;
}

/** First events/chat acts as claim if acceptMatch was lost on the wire. */
export function ensureClaimedByGameId(gameId: string): void {
  const t = findTicketByGameId(gameId);
  if (!t || t.claimedAt || t.status !== "matched") return;
  if (Date.now() < t.revealAt) return;
  acceptMatch(t.id, gameId);
}

function findPartner(self: Ticket): Ticket | undefined {
  for (const other of tickets.values()) {
    if (other.id === self.id) continue;
    if (!isPairable(other)) continue;
    // Same cohort only — keeps reveal time identity-blind.
    if (other.revealAt !== self.revealAt) continue;
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
  const { sessionA, sessionB, room } = createPvpPair(gameIdA, gameIdB);

  // Shared cohort boundary for both seats.
  const activateAt = self.revealAt;
  bindChatClock(sessionA, activateAt);
  bindChatClock(sessionB, activateAt);
  room.chatStartedAt = activateAt;
  room.chatDeadlineAt = activateAt + TIME_LIMIT_SEC * 1000;

  // DB rows are inserted on accept — avoids active orphans from cancel.
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
 * Commit AI at cohort boundary — never await LLM inside pollMatch.
 */
function startAiGame(ticket: Ticket): void {
  if (ticket.status !== "searching" || ticket.gameId) return;

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
  bindChatClock(session, ticket.revealAt);

  finalizeMatched(
    ticket,
    { gameId, opponentSource: "llm" },
    ticket.revealAt,
  );

  // Defer LLM/opening until acceptMatch — avoids unclaimed opener cost.
  const roll = Math.random();
  session.pendingOpenStyle =
    roll < 0.4 ? "immediate" : roll < 0.7 ? "delayed" : "wait";
}

export async function pollMatch(ticketId: string): Promise<MatchStatus> {
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.status === "cancelled") {
    return { status: "cancelled" };
  }

  const now = Date.now();

  // Pair humans in the same cohort as early as possible (still hidden).
  if (ticket.status === "searching") {
    tryPairHumans(ticket);
  }

  if (ticket.status === "matched" && ticket.gameId) {
    if (now < ticket.revealAt) return searchingPayload(ticket, now);
    return matchedPayload(ticket);
  }

  // At cohort boundary: pair or fall back to AI — same reveal instant.
  if (ticket.status === "searching" && now >= ticket.revealAt) {
    if (!tryPairHumans(ticket)) {
      startAiGame(ticket);
    }
    if (ticket.gameId) {
      if (now < ticket.revealAt) return searchingPayload(ticket, now);
      return matchedPayload(ticket);
    }
  }

  return searchingPayload(ticket, now);
}

function matchedPayload(ticket: Ticket): MatchStatus {
  const chatStartedAt = ticket.revealAt;
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
    revealAt: t.revealAt,
    hasGame: !!t.gameId,
    claimed: !!t.claimedAt,
  };
}

/** Test-only: clear in-memory matchmaking state. */
export function __resetMatchmakingForTests() {
  tickets.clear();
}
