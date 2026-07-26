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
  /** Links AI outbox rows to pending transcript events. */
  transcriptId?: string;
}

export type ChatCloseReason =
  | "time_limit"
  | "message_limit"
  | "player_judged"
  | "opponent_judged"
  | "opponent_left"
  | "server_error";

/** Timed conversation log — model history uses only visible events. */
export interface TranscriptEvent {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** user accept time, or assistant planned deliverAt */
  occurredAt: number;
  state: "pending" | "visible" | "cancelled";
  outboxSeq?: number;
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
  /** Derived cache of visible transcript (role/content only). */
  history: LlmHistoryItem[];
  /** Source-of-truth timed events for model context ordering. */
  transcript: TranscriptEvent[];
  /** Bumped on every accepted player line; invalidates in-flight AI work. */
  inputRevision: number;
  startedAt: number;
  /** Absolute chat clock bound at match reveal / accept. */
  chatStartedAt: number;
  chatDeadlineAt: number;
  /** After chat freeze, force a judgment within this deadline. */
  judgmentDeadlineAt: number | null;
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
  /** Opening style chosen at match commit; generated only after claim. */
  pendingOpenStyle: "immediate" | "delayed" | "wait" | null;
  openerStarted: boolean;

  /** Unified delivery queue (AI + PvP peer messages). */
  outbox: OutboxItem[];
  outboxSeq: number;
  /** Monotonic floor so later messages cannot overtake earlier ones. */
  lastScheduledDeliveryAt: number;
  /** Prevent overlapping AI generations. */
  aiJobPending: boolean;
  /** AbortController for the in-flight LLM call. */
  llmAbort: AbortController | null;
  /** Per-game LLM call budget. */
  llmCallsUsed: number;
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

export const JUDGMENT_GRACE_MS = 30_000;
export const MAX_LLM_CALLS_PER_GAME = 40;

export function rebuildHistory(session: GameSession): void {
  session.history = session.transcript
    .filter((e) => e.state === "visible")
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt || a.id.localeCompare(b.id),
    )
    .map((e) => ({ role: e.role, content: e.text }));
  session.opponentCount = session.transcript.filter(
    (e) => e.role === "assistant" && e.state === "visible",
  ).length;
}

export function appendUserTranscript(
  session: GameSession,
  text: string,
  occurredAt = Date.now(),
): void {
  session.transcript.push({
    id: cryptoRandom(),
    role: "user",
    text,
    occurredAt,
    state: "visible",
  });
  session.inputRevision += 1;
  rebuildHistory(session);
}

/** Drop undelivered AI lines and abort in-flight generation. */
export function cancelPendingAssistant(session: GameSession): void {
  const now = Date.now();
  const cancelledIds = new Set<string>();
  for (const e of session.transcript) {
    if (e.role === "assistant" && e.state === "pending") {
      e.state = "cancelled";
      cancelledIds.add(e.id);
    }
  }
  // Remove by transcriptId — including due-but-not-yet-pulled rows.
  session.outbox = session.outbox.filter(
    (o) => !(o.transcriptId && cancelledIds.has(o.transcriptId)),
  );
  // Drop the typing-delay floor so a cancelled long delay cannot push the next line.
  session.lastScheduledDeliveryAt = now;
  if (session.llmAbort) {
    try {
      session.llmAbort.abort();
    } catch {
      /* ignore */
    }
    session.llmAbort = null;
  }
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  rebuildHistory(session);
}

function promoteTranscriptByOutbox(
  session: GameSession,
  item: OutboxItem,
): boolean {
  if (item.from !== "opponent" || !item.transcriptId) return true;
  const ev = session.transcript.find((e) => e.id === item.transcriptId);
  if (!ev) return true;
  if (ev.state === "cancelled") return false;
  if (ev.state !== "pending") return true;
  ev.state = "visible";
  ev.occurredAt = item.deliverAt;
  rebuildHistory(session);
  session.lastOpponentActivityAt = Date.now();
  return true;
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
  cancelPendingAssistant(session);
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  session.nextNudgeAt = null;
  session.outbox = session.outbox.filter((e) => e.deliverAt <= now);
  session.lastScheduledDeliveryAt = now;
  if (
    !session.judgmentDeadlineAt &&
    (reason === "time_limit" ||
      reason === "message_limit" ||
      reason === "opponent_left")
  ) {
    session.judgmentDeadlineAt = now + JUDGMENT_GRACE_MS;
  }
}

function closeNoticeFor(reason: ChatCloseReason): string | null {
  if (reason === "time_limit") return "时间到，请做出你的判断";
  if (reason === "message_limit") return "对话已结束，请做出你的判断";
  if (reason === "opponent_left") return "对方已离开，请做出你的判断";
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
  transcriptId?: string,
): OutboxItem {
  return enqueueEvent(session, {
    type: "message",
    from: "opponent",
    text,
    deliverAt: scheduleDeliverAt(session, deliverAt),
    transcriptId,
  });
}

/** Human peer messages — no simulated typing delay. */
export function enqueueImmediateOpponentMessage(
  session: GameSession,
  text: string,
): OutboxItem {
  const now = Date.now();
  const row = enqueueEvent(session, {
    type: "message",
    from: "opponent",
    text,
    deliverAt: now,
  });
  session.lastScheduledDeliveryAt = Math.max(
    session.lastScheduledDeliveryAt,
    now,
  );
  return row;
}

/**
 * Schedule an AI line for later delivery without putting it in model history yet.
 * Returns false if the input revision already moved on.
 */
export function schedulePendingAssistant(
  session: GameSession,
  text: string,
  deliverAt: number,
  revision: number,
): boolean {
  if (revision !== session.inputRevision) return false;
  if (isChatClosed(session)) return false;
  const id = cryptoRandom();
  const row = enqueueOpponentMessage(session, text, deliverAt, id);
  session.transcript.push({
    id,
    role: "assistant",
    text,
    occurredAt: row.deliverAt,
    state: "pending",
    outboxSeq: row.seq,
  });
  return true;
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
    // Skip cancelled AI lines and purge them so they cannot block the cursor.
    if (!promoteTranscriptByOutbox(session, e)) {
      session.outbox = session.outbox.filter((o) => o.seq !== e.seq);
      continue;
    }
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
    transcript: [],
    inputRevision: 0,
    startedAt,
    chatStartedAt: startedAt,
    chatDeadlineAt: startedAt + TIME_LIMIT_SEC * 1000,
    judgmentDeadlineAt: null,
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
    pendingOpenStyle: null,
    openerStarted: false,
    outbox: [],
    outboxSeq: 0,
    lastScheduledDeliveryAt: 0,
    aiJobPending: false,
    llmAbort: null,
    llmCallsUsed: 0,
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
    transcript: [] as TranscriptEvent[],
    inputRevision: 0,
    startedAt,
    chatStartedAt: startedAt,
    chatDeadlineAt: startedAt + TIME_LIMIT_SEC * 1000,
    judgmentDeadlineAt: null as number | null,
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
    pendingOpenStyle: null as "immediate" | "delayed" | "wait" | null,
    openerStarted: false,
    outbox: [] as OutboxItem[],
    outboxSeq: 0,
    lastScheduledDeliveryAt: 0,
    aiJobPending: false,
    llmAbort: null as AbortController | null,
    llmCallsUsed: 0,
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
