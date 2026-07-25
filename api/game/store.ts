import type { GuessChoice, OpponentSource, Persona } from "@contracts/types";
import type { ConversationEvent } from "@contracts/types";
import { TIME_LIMIT_SEC } from "@contracts/types";
import type { ChaosLevel, ReplyPace } from "./personas";
import type { LlmHistoryItem } from "./llm";
import { defaultEmotion, type EmotionalState } from "./emotion";
import { getSocialPersona, pickSocialPersona } from "./socialPersonas";
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
  chatStartedAt: number;
  chatDeadlineAt: number;
  claims: Record<Seat, boolean>;
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

export type ChatCloseReason =
  | "time_limit"
  | "message_limit"
  | "player_judged"
  | "opponent_judged";

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
  /** Absolute chat clock bound at match reveal / accept. */
  chatStartedAt: number;
  chatDeadlineAt: number;
  playerCount: number;
  opponentCount: number;
  finished: boolean;
  /** Unified chat freeze — stops AI work and undelivered outbox. */
  chatClosedAt: number | null;
  chatCloseReason: ChatCloseReason | null;

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
  /** Monotonic floor so later messages cannot overtake earlier ones. */
  lastScheduledDeliveryAt: number;
  /** Prevent overlapping AI generations. */
  aiJobPending: boolean;
  /**
   * Combined player text waiting for one AI turn.
   * User lines are already written to history at accept time.
   */
  aiReplyQueue: string[];
  /** Rapid player lines coalesced into one AI turn. */
  pendingPlayerBurst: string[];
  burstTimer: ReturnType<typeof setTimeout> | null;
  memory: WorkingMemory;
}

/** Freeze chat: no more AI jobs, nudges, or undelivered future outbox. */
export function closeChat(
  session: GameSession,
  reason: ChatCloseReason,
): void {
  if (session.chatClosedAt) return;
  const now = Date.now();
  session.chatClosedAt = now;
  session.chatCloseReason = reason;
  session.finished = true;
  session.aiReplyQueue = [];
  session.pendingPlayerBurst = [];
  if (session.burstTimer) {
    clearTimeout(session.burstTimer);
    session.burstTimer = null;
  }
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  session.nextNudgeAt = null;
  session.outbox = session.outbox.filter((e) => e.deliverAt <= now);
  session.lastScheduledDeliveryAt = now;
}

function closeNoticeFor(reason: ChatCloseReason): string | null {
  if (reason === "time_limit") return "时间到，请做出你的判断";
  if (reason === "message_limit") return "对话已结束，请做出你的判断";
  return null;
}

/**
 * Close AI session, or both seats in a PVP room.
 * Use for message limit, time limit, and leave — so neither side chats into void.
 */
export function closeConversation(
  session: GameSession,
  reason: ChatCloseReason,
): void {
  if (session.mode === "ai") {
    closeChat(session, reason);
    const tip = closeNoticeFor(reason);
    if (tip && !session.localNotices.some((n) => n === tip)) {
      enqueueImmediateSystemMessage(session, tip);
      session.localNotices.push(tip);
    }
    return;
  }

  const room = session.roomId ? rooms.get(session.roomId) : undefined;
  if (!room) {
    closeChat(session, reason);
    return;
  }

  const tip = closeNoticeFor(reason);
  for (const seat of ["a", "b"] as const) {
    const peer = sessions.get(room.seats[seat]);
    if (!peer) continue;
    const already = !!peer.chatClosedAt;
    closeChat(peer, reason);
    if (!already && tip && !peer.localNotices.some((n) => n === tip)) {
      enqueueImmediateSystemMessage(peer, tip);
      peer.localNotices.push(tip);
    }
  }
}

export function isChatClosed(session: GameSession): boolean {
  return !!session.chatClosedAt;
}

/** Bind absolute chat clock (identity-blind reveal instant). */
export function bindChatClock(session: GameSession, chatStartedAt: number): void {
  session.chatStartedAt = chatStartedAt;
  session.chatDeadlineAt = chatStartedAt + TIME_LIMIT_SEC * 1000;
  session.startedAt = chatStartedAt;
  if (session.mode === "ai") {
    session.aiEarlyJudgeAt = rollAiEarlyJudgeAt(chatStartedAt);
  }
  if (session.mode === "pvp" && session.roomId) {
    const room = rooms.get(session.roomId);
    if (room) {
      room.chatStartedAt = chatStartedAt;
      room.chatDeadlineAt = session.chatDeadlineAt;
      room.startedAt = chatStartedAt;
    }
  }
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

function scheduleDeliverAt(session: GameSession, requestedAt: number): number {
  const floor = Math.max(session.lastScheduledDeliveryAt || 0, Date.now());
  const deliverAt = Math.max(requestedAt, floor + 350);
  session.lastScheduledDeliveryAt = deliverAt;
  return deliverAt;
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
    deliverAt: scheduleDeliverAt(session, deliverAt),
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
    deliverAt: scheduleDeliverAt(session, deliverAt),
  });
}

/** System notices must not inherit typing-delay floors from opponent messages. */
export function enqueueImmediateSystemMessage(
  session: GameSession,
  text: string,
): void {
  const now = Date.now();
  enqueueEvent(session, {
    type: "system",
    from: "system",
    text,
    deliverAt: now,
  });
  session.lastScheduledDeliveryAt = Math.max(
    session.lastScheduledDeliveryAt,
    now,
  );
}

/** Make all pending outbox items visible now (e.g. when chat locks). */
export function flushOutbox(session: GameSession): void {
  const now = Date.now();
  for (const e of session.outbox) {
    if (e.deliverAt > now) e.deliverAt = now;
  }
  session.lastScheduledDeliveryAt = Math.max(
    session.lastScheduledDeliveryAt,
    now,
  );
}

/**
 * Pull contiguous due events after cursor.
 * Stops at the first not-yet-due item so a later short-delay message
 * cannot advance the cursor past an earlier delayed message.
 */
export function peekDueEvents(
  session: GameSession,
  cursor: number,
): ConversationEvent[] {
  const now = Date.now();
  const pending = session.outbox
    .filter((e) => e.seq > cursor)
    .sort((a, b) => a.seq - b.seq);

  const result: ConversationEvent[] = [];
  for (const e of pending) {
    if (e.deliverAt > now) break;
    result.push({
      seq: e.seq,
      type: e.type,
      from: e.from,
      text: e.text,
      deliverAt: e.deliverAt,
    });
  }
  return result;
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
    chatStartedAt: startedAt,
    chatDeadlineAt: startedAt + TIME_LIMIT_SEC * 1000,
    playerCount: 0,
    opponentCount: 0,
    finished: false,
    chatClosedAt: null,
    chatCloseReason: null,
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
    lastScheduledDeliveryAt: 0,
    aiJobPending: false,
    aiReplyQueue: [],
    pendingPlayerBurst: [],
    burstTimer: null,
    memory: emptyMemory(),
  };
  if (session.socialPersonaId) {
    const sp = getSocialPersona(session.socialPersonaId);
    session.memory.selfFacts.ageRange = sp.identity.ageRange;
    session.memory.selfFacts.occupation = sp.identity.occupation;
    session.memory.selfFacts.situation = sp.identity.currentSituation;
  }
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
    chatStartedAt: startedAt,
    chatDeadlineAt: startedAt + TIME_LIMIT_SEC * 1000,
    claims: { a: false, b: false },
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
    chatStartedAt: startedAt,
    chatDeadlineAt: startedAt + TIME_LIMIT_SEC * 1000,
    playerCount: 0,
    opponentCount: 0,
    finished: false,
    chatClosedAt: null as number | null,
    chatCloseReason: null as ChatCloseReason | null,
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
    lastScheduledDeliveryAt: 0,
    aiJobPending: false,
    aiReplyQueue: [] as string[],
    pendingPlayerBurst: [] as string[],
    burstTimer: null as ReturnType<typeof setTimeout> | null,
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
