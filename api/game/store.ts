import type { GuessChoice, OpponentSource, Persona } from "@contracts/types";
import type { ChaosLevel, ReplyPace } from "./personas";
import type { LlmHistoryItem } from "./llm";

export type Seat = "a" | "b";

export interface PvpMessage {
  seat: Seat;
  text: string;
  at: number;
}

export interface SeatVerdict {
  guess: GuessChoice | null;
  timedOut: boolean;
  at: number;
}

export interface PvpRoom {
  id: string;
  seats: Record<Seat, string>; // gameId per seat
  messages: PvpMessage[];
  startedAt: number;
  left: Partial<Record<Seat, boolean>>;
  verdicts: Partial<Record<Seat, SeatVerdict>>;
  firstFinisher: Seat | null;
  responseDeadline: number | null;
  revealed: boolean;
  /** System lines delivered per seat (cursor by index). */
  notices: { to: Seat | "both"; text: string; at: number }[];
}

export interface GameSession {
  id: string;
  mode: "ai" | "pvp";
  persona: Persona;
  opponentSource: OpponentSource;
  card: string | null;
  replyPace: ReplyPace;
  chaos: ChaosLevel;
  roomId: string | null;
  seat: Seat | null;
  history: LlmHistoryItem[];
  startedAt: number;
  playerCount: number;
  opponentCount: number;
  finished: boolean;

  // ── Dual-judge settlement ──
  myGuess: GuessChoice | null;
  timedOut: boolean;
  waitingForOpponent: boolean;
  settled: boolean;
  /** AI flavor judgment of the player (not scored). */
  aiJudgment: GuessChoice | null;
  aiJudgedAt: number | null;
  /** Random time when AI may early-judge; null = AI never early-judges. */
  aiEarlyJudgeAt: number | null;
  /** After player judges first, AI reveals after this timestamp. */
  aiReplyAt: number | null;
  /** Deadline for the player to answer after AI / peer judged. */
  responseDeadline: number | null;
  /** Notices already pushed to this client via pulse. */
  noticeCursor: number;
  localNotices: string[];

  // ── Proactive AI nudges while player is silent ──
  lastPlayerActivityAt: number;
  lastOpponentActivityAt: number;
  nextNudgeAt: number | null;
  nudgeCount: number;
  pendingNudges: string[];
  /** Held opener when AI does not speak immediately at match. */
  pendingOpener: string | null;
  delayedOpenerAt: number | null;
}

const sessions = new Map<string, GameSession>();
const rooms = new Map<string, PvpRoom>();

const SESSION_TTL_MS = 60 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startedAt > SESSION_TTL_MS) {
      if (s.roomId) rooms.delete(s.roomId);
      sessions.delete(id);
    }
  }
}

/** ~55% of AI games early-judge at a random moment during the chat window. */
function rollAiEarlyJudgeAt(startedAt: number): number | null {
  if (Math.random() > 0.55) return null;
  // Between ~12s and ~100s into the chat.
  const delay = 12_000 + Math.random() * 88_000;
  return startedAt + delay;
}

export function createAiSession(
  id: string,
  persona: Persona,
  card: string | null,
  replyPace: ReplyPace = "normal",
  chaos: ChaosLevel = "sane",
): GameSession {
  prune();
  const startedAt = Date.now();
  const session: GameSession = {
    id,
    mode: "ai",
    persona,
    opponentSource: "llm",
    card,
    replyPace,
    chaos,
    roomId: null,
    seat: null,
    history: [],
    startedAt,
    playerCount: 0,
    opponentCount: 0,
    finished: false,
    myGuess: null,
    timedOut: false,
    waitingForOpponent: false,
    settled: false,
    aiJudgment: null,
    aiJudgedAt: null,
    aiEarlyJudgeAt: rollAiEarlyJudgeAt(startedAt),
    aiReplyAt: null,
    responseDeadline: null,
    noticeCursor: 0,
    localNotices: [],
    lastPlayerActivityAt: 0,
    lastOpponentActivityAt: startedAt,
    nextNudgeAt: null,
    nudgeCount: 0,
    pendingNudges: [],
    pendingOpener: null,
    delayedOpenerAt: null,
  };
  sessions.set(id, session);
  return session;
}

export function createPvpPair(
  gameIdA: string,
  gameIdB: string,
): { room: PvpRoom; sessionA: GameSession; sessionB: GameSession } {
  prune();
  const roomId = cryptoRandom();
  const startedAt = Date.now();
  const room: PvpRoom = {
    id: roomId,
    seats: { a: gameIdA, b: gameIdB },
    messages: [],
    startedAt,
    left: {},
    verdicts: {},
    firstFinisher: null,
    responseDeadline: null,
    revealed: false,
    notices: [],
  };
  rooms.set(roomId, room);

  const base = {
    mode: "pvp" as const,
    persona: "human" as const,
    opponentSource: "player" as const,
    card: null,
    replyPace: "normal" as const,
    chaos: "sane" as const,
    roomId,
    history: [] as LlmHistoryItem[],
    startedAt,
    playerCount: 0,
    opponentCount: 0,
    finished: false,
    myGuess: null,
    timedOut: false,
    waitingForOpponent: false,
    settled: false,
    aiJudgment: null,
    aiJudgedAt: null,
    aiEarlyJudgeAt: null,
    aiReplyAt: null,
    responseDeadline: null,
    noticeCursor: 0,
    localNotices: [] as string[],
    lastPlayerActivityAt: startedAt,
    lastOpponentActivityAt: startedAt,
    nextNudgeAt: null as number | null,
    nudgeCount: 0,
    pendingNudges: [] as string[],
    pendingOpener: null as string | null,
    delayedOpenerAt: null as number | null,
  };

  const sessionA: GameSession = { ...base, id: gameIdA, seat: "a" };
  const sessionB: GameSession = { ...base, id: gameIdB, seat: "b" };
  sessions.set(gameIdA, sessionA);
  sessions.set(gameIdB, sessionB);
  return { room, sessionA, sessionB };
}

function cryptoRandom(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `room_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

export function getSession(id: string): GameSession | undefined {
  return sessions.get(id);
}

export function getRoom(roomId: string): PvpRoom | undefined {
  return rooms.get(roomId);
}

export function deleteSession(id: string): void {
  const s = sessions.get(id);
  if (s?.roomId) {
    const room = rooms.get(s.roomId);
    if (room && s.seat) {
      room.left[s.seat] = true;
      if (room.left.a && room.left.b) rooms.delete(s.roomId);
    }
  }
  sessions.delete(id);
}

export function createSession(
  id: string,
  persona: Persona,
  card: string | null,
  replyPace: ReplyPace = "normal",
  chaos: ChaosLevel = "sane",
): GameSession {
  return createAiSession(id, persona, card, replyPace, chaos);
}
