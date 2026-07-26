import {
  JUDGE_RESPONSE_SEC,
  type GuessChoice,
  type GuessResult,
  type GlobalStats,
  type OpponentSource,
  type Persona,
} from "@contracts/types";
import { getDb } from "../queries/connection";
import { hasDatabase } from "../lib/env";
import { games } from "@db/schema";
import {
  closeChat,
  closeConversation,
  deleteSession,
  enqueueImmediateSystemMessage,
  getRoom,
  getSession,
  isChatClosed,
  type GameSession,
  type Seat,
} from "./store";
import { INITIAL_CONFIG } from "./config";
import { flavorJudgePlayer } from "./aiJudgment";

const JUDGE_MS = JUDGE_RESPONSE_SEC * 1000;

/** Short-lived cache so both clients can fetch the reveal after sessions are dropped. */
const settledResults = new Map<string, GuessResult>();

export function getSettledResult(gameId: string): GuessResult | undefined {
  return settledResults.get(gameId);
}

function cacheResult(gameId: string, result: GuessResult) {
  settledResults.set(gameId, result);
  // Drop after 10 minutes.
  setTimeout(() => settledResults.delete(gameId), 10 * 60 * 1000);
}

/**
 * Scoring truth = who the opponent actually is.
 * Persona (human/machine) only affects LLM speaking style, not the answer.
 */
export function truthOf(
  _persona: Persona,
  opponentSource: OpponentSource,
): GuessChoice {
  return opponentSource === "player" ? "human" : "ai";
}

export async function computeStats(): Promise<GlobalStats> {
  if (!hasDatabase()) {
    return { totalGames: 0, correctRate: 0, aiShare: 0 };
  }
  try {
    const rows = await getDb()
      .select({ persona: games.persona, correct: games.correct })
      .from(games);
    const finished = rows.filter((r) => r.correct !== null);
    const totalGames = finished.length;
    const correctCount = finished.filter((r) => r.correct === true).length;
    const aiCount = finished.filter((r) => r.persona === "machine").length;
    return {
      totalGames,
      correctRate:
        totalGames > 0
          ? Math.round((correctCount / totalGames) * 1000) / 10
          : 0,
      aiShare:
        totalGames > 0 ? Math.round((aiCount / totalGames) * 1000) / 10 : 0,
    };
  } catch (err) {
    console.error("[settle] stats failed:", err);
    return { totalGames: 0, correctRate: 0, aiShare: 0 };
  }
}

function pushNotice(session: GameSession, text: string) {
  if (session.localNotices.some((n) => n === text)) return;
  enqueueImmediateSystemMessage(session, text);
  session.localNotices.push(text);
}

function roomNotice(
  roomId: string,
  to: Seat | "both",
  text: string,
) {
  const room = getRoom(roomId);
  if (!room) return;
  room.notices.push({ to, text, at: Date.now() });
  const targets: Seat[] =
    to === "both" ? ["a", "b"] : [to];
  for (const seat of targets) {
    const sid = room.seats[seat];
    const s = getSession(sid);
    if (s) pushNotice(s, text);
  }
}

function drainNotices(session: GameSession): { from: "system"; text: string }[] {
  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    if (!room) return [];
    const fresh = room.notices.slice(session.noticeCursor);
    session.noticeCursor = room.notices.length;
    return fresh
      .filter((n) => n.to === "both" || n.to === session.seat)
      .map((n) => ({ from: "system" as const, text: n.text }));
  }
  const fresh = session.localNotices.slice(session.noticeCursor);
  session.noticeCursor = session.localNotices.length;
  return fresh.map((text) => ({ from: "system" as const, text }));
}

function opponentMessageCount(session: GameSession): number {
  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    if (!room) return 0;
    return room.messages.filter((m) => m.seat !== session.seat).length;
  }
  return session.opponentCount;
}

async function persistPlayer(
  session: GameSession,
  guess: GuessChoice | null,
  correct: boolean,
) {
  const persona =
    session.opponentSource === "llm" ? ("machine" as const) : ("human" as const);
  const row = {
    id: session.id,
    persona,
    status: "finished" as const,
    guess,
    correct,
    playerMessages: session.playerCount,
    opponentMessages: opponentMessageCount(session),
    finishedAt: new Date(),
  };
  if (!hasDatabase()) return;
  try {
    await getDb()
      .insert(games)
      .values(row)
      .onDuplicateKeyUpdate({
        set: {
          status: row.status,
          guess: row.guess,
          correct: row.correct,
          playerMessages: row.playerMessages,
          opponentMessages: row.opponentMessages,
          finishedAt: row.finishedAt,
        },
      });
  } catch (err) {
    console.error("[settle] persist failed:", err);
  }
}

/** Trigger AI early-judge if the rolled time has come. */
export function maybeTriggerAiEarlyJudge(session: GameSession): void {
  if (session.mode !== "ai" || session.settled) return;
  if (session.myGuess || session.aiJudgedAt) return;
  if (!session.aiEarlyJudgeAt) return;
  if (Date.now() < session.aiEarlyJudgeAt) return;

  const elapsed = Date.now() - session.chatStartedAt;
  const totalMsgs = session.playerCount + session.opponentCount;
  if (
    elapsed < INITIAL_CONFIG.earlyJudgeMinElapsedMs ||
    session.playerCount < INITIAL_CONFIG.earlyJudgeMinPlayerMessages ||
    totalMsgs < INITIAL_CONFIG.earlyJudgeMinTotalMessages
  ) {
    // Defer until thresholds met.
    session.aiEarlyJudgeAt = Date.now() + 8_000;
    return;
  }

  session.aiJudgedAt = Date.now();
  session.aiJudgment = flavorJudgePlayer(session);
  session.responseDeadline = Date.now() + JUDGE_MS;
  closeChat(session, "opponent_judged");
  pushNotice(
    session,
    `对方已提交判断，请在 ${JUDGE_RESPONSE_SEC} 秒内做出你的判断`,
  );
}

/** After player judges first, AI eventually "answers" (flavor, not scored). */
export function maybeResolveAiReply(session: GameSession): boolean {
  if (session.mode !== "ai" || session.settled) return false;
  if (!session.waitingForOpponent || !session.aiReplyAt) return false;
  if (Date.now() < session.aiReplyAt) return false;

  session.aiJudgment = flavorJudgePlayer(session);
  session.aiJudgedAt = Date.now();
  return true;
}

/** Timeout the player who must answer after opponent judged. */
export function maybeTimeoutResponder(session: GameSession): boolean {
  if (session.settled) return false;
  if (session.myGuess || session.timedOut) return false;
  if (!session.responseDeadline) return false;
  if (Date.now() < session.responseDeadline) return false;

  session.timedOut = true;
  session.finished = true;
  return true;
}

export async function buildGuessResult(
  session: GameSession,
): Promise<GuessResult> {
  const truth = truthOf(session.persona, session.opponentSource);
  const timedOut = session.timedOut;
  const myGuess = session.myGuess;
  const correct = timedOut ? false : myGuess === truth;

  let opponentGuess: GuessChoice | null = null;
  let opponentTimedOut = false;

  if (session.mode === "ai") {
    opponentGuess = session.aiJudgment;
    opponentTimedOut = false;
  } else if (session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    const other: Seat = session.seat === "a" ? "b" : "a";
    const ov = room?.verdicts[other];
    opponentGuess = ov?.guess ?? null;
    opponentTimedOut = !!ov?.timedOut;
  }

  const stats = await computeStats();
  return {
    correct,
    timedOut,
    truth,
    myGuess,
    opponentGuess,
    opponentTimedOut,
    opponentSource: session.opponentSource,
    playerMessages: session.playerCount,
    opponentMessages: opponentMessageCount(session),
    stats,
  };
}

function markPvpTimeout(roomId: string, seat: Seat) {
  const room = getRoom(roomId);
  if (!room || room.verdicts[seat]) return;
  room.verdicts[seat] = {
    guess: null,
    timedOut: true,
    at: Date.now(),
  };
  const gameId = room.seats[seat];
  const s = getSession(gameId);
  if (s) {
    s.timedOut = true;
    s.finished = true;
  }
}

function pvpBothReady(roomId: string): boolean {
  const room = getRoom(roomId);
  if (!room) return false;
  return !!(room.verdicts.a && room.verdicts.b);
}

async function commitReveal(session: GameSession): Promise<GuessResult> {
  const result = await buildGuessResult(session);
  await persistPlayer(session, session.myGuess, result.correct);
  session.settled = true;
  session.finished = true;
  cacheResult(session.id, result);
  deleteSession(session.id);
  return result;
}

/**
 * Apply judgment-grace timeouts and write PVP verdicts.
 * Must only run inside revealIfReady so timeout + settle stay atomic.
 */
function applyJudgmentTimeouts(session: GameSession): void {
  if (session.mode === "ai") {
    if (session.settled || session.myGuess || session.timedOut) return;
    if (!session.judgmentDeadlineAt) return;
    if (Date.now() < session.judgmentDeadlineAt) return;
    session.timedOut = true;
    session.finished = true;
    if (!session.chatClosedAt) closeChat(session, "time_limit");
    return;
  }

  if (!session.roomId) return;
  const room = getRoom(session.roomId);
  if (!room) return;

  for (const seat of ["a", "b"] as const) {
    if (room.verdicts[seat]) continue;
    const s = getSession(room.seats[seat]);
    if (!s || s.myGuess || s.timedOut) continue;
    if (!s.judgmentDeadlineAt || Date.now() < s.judgmentDeadlineAt) continue;
    markPvpTimeout(session.roomId, seat);
  }
}

export async function revealIfReady(
  session: GameSession,
): Promise<GuessResult | null> {
  const cached = getSettledResult(session.id);
  if (cached) return cached;
  if (session.settled) return buildGuessResult(session);

  // Timeouts are applied here only — never in the router alone.
  applyJudgmentTimeouts(session);

  if (session.mode === "ai") {
    maybeTriggerAiEarlyJudge(session);

    // Both sides done (player answered after AI, or AI replied after player).
    if (session.myGuess && session.aiJudgment) {
      return commitReveal(session);
    }

    if (session.waitingForOpponent && maybeResolveAiReply(session)) {
      return commitReveal(session);
    }

    if (maybeTimeoutResponder(session)) {
      if (!session.aiJudgment) session.aiJudgment = flavorJudgePlayer(session);
      return commitReveal(session);
    }

    if (session.timedOut) {
      if (!session.aiJudgment) session.aiJudgment = flavorJudgePlayer(session);
      return commitReveal(session);
    }

    return null;
  }

  if (!session.roomId || !session.seat) return null;
  const room = getRoom(session.roomId);
  if (!room) return null;

  if (
    room.responseDeadline &&
    room.firstFinisher &&
    Date.now() >= room.responseDeadline
  ) {
    const other: Seat = room.firstFinisher === "a" ? "b" : "a";
    if (!room.verdicts[other]) {
      markPvpTimeout(session.roomId, other);
      roomNotice(session.roomId, other, "判断超时，本局你已判负");
    }
  }

  if (!pvpBothReady(session.roomId)) return null;

  room.revealed = true;
  const other: Seat = session.seat === "a" ? "b" : "a";
  const otherSession = getSession(room.seats[other]);

  const myResult = await buildGuessResult(session);
  await persistPlayer(session, session.myGuess, myResult.correct);
  session.settled = true;
  cacheResult(session.id, myResult);

  if (otherSession && !otherSession.settled) {
    const otherResult = await buildGuessResult(otherSession);
    await persistPlayer(
      otherSession,
      otherSession.myGuess,
      otherResult.correct,
    );
    otherSession.settled = true;
    cacheResult(otherSession.id, otherResult);
    deleteSession(otherSession.id);
  }

  deleteSession(session.id);
  return myResult;
}

export type FinishResolution =
  | { phase: "revealed"; result: GuessResult }
  | { phase: "waiting"; deadlineAt: number; message: string }
  | { phase: "lost"; message: string };

/**
 * Server-authoritative finish: apply judgment deadlines before accepting a guess.
 * Must not depend on the client having polled `events`.
 */
export async function resolveFinish(
  session: GameSession,
  guess: GuessChoice,
): Promise<FinishResolution> {
  const pre = await revealIfReady(session);
  if (pre) return { phase: "revealed", result: pre };

  const live = getSession(session.id);
  if (!live) {
    const cached = getSettledResult(session.id);
    if (cached) return { phase: "revealed", result: cached };
    return {
      phase: "lost",
      message: "对局已失效，请重新开始（不会伪造对方身份）",
    };
  }

  if (live.timedOut || live.settled) {
    const again = await revealIfReady(live);
    if (again) return { phase: "revealed", result: again };
    const cached = getSettledResult(live.id);
    if (cached) return { phase: "revealed", result: cached };
    return { phase: "lost", message: "对局已超时结束" };
  }

  if (live.myGuess && live.waitingForOpponent) {
    return {
      phase: "waiting",
      deadlineAt: waitingDeadline(live),
      message: waitingMessage(),
    };
  }

  if (live.myGuess) {
    const result = await revealIfReady(live);
    if (result) return { phase: "revealed", result };
    return { phase: "lost", message: "结算状态异常，请重新开始" };
  }

  maybeTriggerAiEarlyJudge(live);
  const phase = submitPlayerGuess(live, guess);

  if (phase === "waiting") {
    return {
      phase: "waiting",
      deadlineAt: waitingDeadline(live),
      message: waitingMessage(),
    };
  }

  const result = await revealIfReady(live);
  if (result) return { phase: "revealed", result };

  if (live.waitingForOpponent) {
    return {
      phase: "waiting",
      deadlineAt: waitingDeadline(live),
      message: waitingMessage(),
    };
  }

  return { phase: "lost", message: "结算状态异常，请重新开始" };
}

export function submitPlayerGuess(
  session: GameSession,
  guess: GuessChoice,
): "waiting" | "revealed" {
  if (session.settled) return "revealed";
  if (session.timedOut) return "revealed";
  if (session.myGuess) {
    return session.waitingForOpponent ? "waiting" : "revealed";
  }

  session.myGuess = guess;
  session.responseDeadline = null;
  closeChat(session, "player_judged");

  if (session.mode === "ai") {
    if (session.aiJudgedAt && session.aiJudgment) {
      session.waitingForOpponent = false;
      return "revealed";
    }
    // Player first — wait for AI flavor judgment.
    session.waitingForOpponent = true;
    // Match human 0–20s judgment window (incl. rare near-timeout).
    session.aiReplyAt = Date.now() + Math.random() * JUDGE_MS;
    return "waiting";
  }

  // PvP
  if (!session.roomId || !session.seat) return "revealed";
  const room = getRoom(session.roomId);
  if (!room) return "revealed";

  room.verdicts[session.seat] = {
    guess,
    timedOut: false,
    at: Date.now(),
  };

  if (!room.firstFinisher) {
    room.firstFinisher = session.seat;
    room.responseDeadline = Date.now() + JUDGE_MS;
    session.waitingForOpponent = true;
    const other: Seat = session.seat === "a" ? "b" : "a";
    const peer = getSession(room.seats[other]);
    if (peer) closeChat(peer, "opponent_judged");
    roomNotice(
      session.roomId,
      other,
      `对方已提交判断，请在 ${JUDGE_RESPONSE_SEC} 秒内做出你的判断`,
    );
    return "waiting";
  }

  // Second finisher — ready to reveal.
  session.waitingForOpponent = false;
  return "revealed";
}

export function chatLocked(session: GameSession): boolean {
  if (isChatClosed(session) || session.finished || session.myGuess || session.timedOut) {
    return true;
  }
  if (session.mode === "ai" && session.aiJudgedAt) return true;
  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    if (room?.firstFinisher && room.firstFinisher !== session.seat) {
      return true;
    }
    if (room?.verdicts[session.seat]) return true;
  }
  return false;
}

/** Close chat when the absolute deadline is reached (idempotent, both seats). */
export function closeChatIfExpired(session: GameSession): boolean {
  if (isChatClosed(session)) {
    return session.chatCloseReason === "time_limit";
  }
  if (session.myGuess || session.aiJudgedAt) return false;
  // Small network skew only — not a multi-second gameplay extension.
  if (Date.now() < session.chatDeadlineAt + 300) return false;
  closeConversation(session, "time_limit");
  return true;
}

/**
 * @deprecated Timeouts are applied inside revealIfReady only.
 * Kept as a no-op so accidental router calls cannot mark timedOut without settle.
 */
export function maybeJudgmentTimeout(_session: GameSession): boolean {
  return false;
}

export function mustJudge(session: GameSession): boolean {
  if (session.myGuess || session.timedOut || session.settled) return false;
  if (session.mode === "ai") {
    return !!session.aiJudgedAt && !!session.responseDeadline;
  }
  if (session.mode === "pvp" && session.roomId && session.seat) {
    const room = getRoom(session.roomId);
    return (
      !!room?.firstFinisher &&
      room.firstFinisher !== session.seat &&
      !room.verdicts[session.seat]
    );
  }
  return false;
}

export function judgeDeadlineAt(session: GameSession): number | null {
  if (session.mode === "ai") return session.responseDeadline;
  if (session.mode === "pvp" && session.roomId) {
    return getRoom(session.roomId)?.responseDeadline ?? null;
  }
  return null;
}

export function takeSystemMessages(session: GameSession) {
  return drainNotices(session);
}

export function waitingMessage(): string {
  return "对方正在做出判断，请稍候…";
}

export function waitingDeadline(session: GameSession): number {
  if (session.mode === "ai" && session.aiReplyAt) return session.aiReplyAt;
  if (session.mode === "pvp" && session.roomId) {
    return getRoom(session.roomId)?.responseDeadline ?? Date.now() + JUDGE_MS;
  }
  return Date.now() + JUDGE_MS;
}
