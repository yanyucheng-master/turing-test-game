import type { GuessChoice, OpponentSource, Persona } from "@contracts/types";
import type { ConversationEvent } from "@contracts/types";
import type { ChaosLevel, ReplyPace } from "./personas";
import type { LlmHistoryItem } from "./llm";
import { defaultEmotion, type EmotionalState } from "./emotion";
import { pickSocialPersona } from "./socialPersonas";
import { INITIAL_CONFIG } from "./config";

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
  seats: Record<Seat, string>;
  messages: PvpMessage[];
  startedAt: number;
  left: Partial<Record<Seat, boolean>>;
  verdicts: Partial<Record<Seat, SeatVerdict>>;
  firstFinisher: Seat | null;
  responseDeadline: number | null;
  revealed: boolean;
  notices: { to: Seat | "both"; text: string; at: number }[];
}

export interface WorkingMemory {
  userFacts: Array<{
    key: string;
    value: string;
    confidence: number;
    turn: number;
  }>;
  selfFacts: Record<string, string>;
  recentTopics: string[];
  emotionalState: EmotionalState;
  usedReplyIds: string[];
  recentTurnActions: string[];
  accusationCount: number;
  strongChaosTurns: number;
  metaTurns: number;
}

export interface OutboxItem {
  seq: number;
  type: "message" | "system";
  from: "opponent" | "system";
  text: string;
  deliverAt: number;
}

export interface GameSession {
  id: string;
  mode: "ai" | "pvp";
  persona: Persona;
  opponentSource: OpponentSource;
  /** Structured social persona id (AI only). */
  socialPersonaId: string | null;
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

  myGuess: GuessChoice | null;
  timedOut: boolean;
  waitingForOpponent: boolean;
  settled: boolean;
  aiJudgment: GuessChoice | null;
  aiJudgedAt: number | null;
  aiEarlyJudgeAt: number | null;
  aiReplyAt: number | null;
  responseDeadline: number | null;
  noticeCursor: number;
  localNotices: string[];

  lastPlayerActivityAt: number;
  lastOpponentActivityAt: number;
  nextNudgeAt: number | null;
  nudgeCount: number;
  pendingNudges: string[];
  pendingOpener: string | null;
  delayedOpenerAt: number | null;

  /** Unified delivery queue (AI + PvP peer messages). */
  outbox: OutboxItem[];
  outboxSeq: number;
  /** Prevent overlapping AI generations. */
  aiJobPending: boolean;
  /** Player lines waiting for AI turn generation. */
  aiReplyQueue: string[];
  memory: WorkingMemory;
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

function emptyMemory(): WorkingMemory {
  return {
    userFacts: [],
    selfFacts: {},
    recentTopics: [],
    emotionalState: defaultEmotion(),
    usedReplyIds: [],
    recentTurnActions: [],
    accusationCount: 0,
    strongChaosTurns: 0,
    metaTurns: 0,
  };
}

/** Early-judge only after enough chat; ~45% of AI games. */
function rollAiEarlyJudgeAt(startedAt: number): number | null {
  if (Math.random() > 0.45) return null;
  const delay =
    INITIAL_CONFIG.earlyJudgeMinElapsedMs + Math.random() * 70_000;
  return startedAt + delay;
}

export function enqueueEvent(
  session: GameSession,
  item: Omit<OutboxItem, "seq">,
): OutboxItem {
  session.outboxSeq += 1;
  const row: OutboxItem = { ...item, seq: session.outboxSeq };
  session.outbox.push(row);
  return row;
}

export function enqueueOpponentMessage(
  session: GameSession,
  text: string,
  deliverAt: number,
): void {
  enqueueEvent(session, {
    type: "message",
    from: "opponent",
    text,
    deliverAt,
  });
}

export function enqueueSystemMessage(
  session: GameSession,
  text: string,
  deliverAt = Date.now(),
): void {
  enqueueEvent(session, {
    type: "system",
    from: "system",
    text,
    deliverAt,
  });
}

/** Pull due events after cursor; advances nothing — caller sets cursor. */
export function peekDueEvents(
  session: GameSession,
  cursor: number,
): ConversationEvent[] {
  const now = Date.now();
  return session.outbox
    .filter((e) => e.seq > cursor && e.deliverAt <= now)
    .map((e) => ({
      seq: e.seq,
      type: e.type,
      from: e.from,
      text: e.text,
      deliverAt: e.deliverAt,
    }));
}

export function createAiSession(
  id: string,
  persona: Persona,
  card: string | null,
  replyPace: ReplyPace = "normal",
  chaos: ChaosLevel = "sane",
  socialPersonaId?: string | null,
): GameSession {
  prune();
  const startedAt = Date.now();
  const social = socialPersonaId
    ? { id: socialPersonaId }
    : pickSocialPersona();
  const session: GameSession = {
    id,
    mode: "ai",
    persona,
    opponentSource: "llm",
    socialPersonaId: social.id,
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
    outbox: [],
    outboxSeq: 0,
    aiJobPending: false,
    aiReplyQueue: [],
    memory: emptyMemory(),
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
    socialPersonaId: null as string | null,
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
    outbox: [] as OutboxItem[],
    outboxSeq: 0,
    aiJobPending: false,
    aiReplyQueue: [] as string[],
    memory: emptyMemory(),
  };

  const sessionA: GameSession = {
    ...base,
    id: gameIdA,
    seat: "a",
    memory: emptyMemory(),
    outbox: [],
    aiReplyQueue: [],
  };
  const sessionB: GameSession = {
    ...base,
    id: gameIdB,
    seat: "b",
    memory: emptyMemory(),
    outbox: [],
    aiReplyQueue: [],
  };
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
