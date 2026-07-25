import type { GameSession } from "./store";

/** Soft first hellos when AI eventually breaks the ice. */
const HELLO_LINES = ["嗨", "哈喽", "在吗", "嘿", "hi", "有人吗", "哈喽？"];

/**
 * Follow-ups while waiting for a reply after already chatting.
 */
const NUDGE_LINES = [
  "在吗",
  "？",
  "人呢",
  "哈？",
  "还在吗",
  "喂",
  "咋不说话",
  "？？",
  "嘿",
];

function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Schedule a possible nudge after the AI just spoke and is waiting. */
export function scheduleProactiveNudge(
  session: GameSession,
  opts?: { firstContact?: boolean },
): void {
  if (session.mode !== "ai") return;
  if (session.finished || session.myGuess || session.aiJudgedAt) {
    session.nextNudgeAt = null;
    return;
  }
  if (session.nudgeCount >= 2) {
    session.nextNudgeAt = null;
    return;
  }
  const first = opts?.firstContact || session.opponentCount === 0;
  // First contact: wait a bit longer; follow-ups are snappier.
  const delay = first
    ? 5_000 + Math.random() * 14_000
    : session.nudgeCount === 0
      ? 6_000 + Math.random() * 12_000
      : 10_000 + Math.random() * 12_000;
  session.nextNudgeAt = Date.now() + delay;
}

/** Player spoke — cancel delayed opener / pending nudge. */
export function onPlayerActivity(session: GameSession): void {
  session.lastPlayerActivityAt = Date.now();
  session.nextNudgeAt = null;
  // Player opened first — drop the held greeting.
  if (session.pendingOpener) {
    session.pendingOpener = null;
    session.delayedOpenerAt = null;
  }
}

export function afterAiReply(session: GameSession): void {
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount = 0;
  scheduleProactiveNudge(session);
}

/**
 * Match connected but AI stays quiet — wait for player, maybe say hi later.
 */
export function beginSilentMatch(session: GameSession): void {
  session.lastPlayerActivityAt = 0;
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount = 0;
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  scheduleProactiveNudge(session, { firstContact: true });
}

/** Hold an opener to deliver after a beat (client shows typing before reveal). */
export function holdDelayedOpener(
  session: GameSession,
  opener: string,
  delayMs?: number,
): void {
  session.pendingOpener = opener;
  session.delayedOpenerAt =
    Date.now() + (delayMs ?? 2_500 + Math.random() * 9_000);
  session.lastPlayerActivityAt = 0;
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount = 0;
  session.nextNudgeAt = null;
}

function flushDelayedOpener(session: GameSession): string[] {
  if (!session.pendingOpener || !session.delayedOpenerAt) return [];
  if (Date.now() < session.delayedOpenerAt) return [];
  // Player already spoke — opener cancelled in onPlayerActivity; belt-and-suspenders:
  if (session.lastPlayerActivityAt > 0) {
    session.pendingOpener = null;
    session.delayedOpenerAt = null;
    return [];
  }

  const line = session.pendingOpener;
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  session.history.push({ role: "assistant", content: line });
  session.opponentCount += 1;
  session.lastOpponentActivityAt = Date.now();
  session.pendingNudges.push(line);
  session.nudgeCount = 0;
  scheduleProactiveNudge(session);
  return drainPendingNudges(session);
}

/**
 * Deliver delayed openers / silence nudges. Call from pulse.
 */
export function maybeProactiveNudge(session: GameSession): string[] {
  if (session.mode !== "ai") return [];
  if (session.finished || session.myGuess || session.aiJudgedAt || session.settled) {
    return [];
  }

  const delayed = flushDelayedOpener(session);
  if (delayed.length) return delayed;

  if (!session.nextNudgeAt || Date.now() < session.nextNudgeAt) return [];

  // Still holding a delayed opener — let that fire instead of a nudge.
  if (session.pendingOpener) {
    session.nextNudgeAt = null;
    return [];
  }

  // After AI already spoke: only poke if player hasn't replied since.
  // At match start (opponentCount===0): both silent is fine — first hello.
  if (
    session.opponentCount > 0 &&
    session.lastPlayerActivityAt >= session.lastOpponentActivityAt
  ) {
    session.nextNudgeAt = null;
    return [];
  }

  if (session.nudgeCount >= 2) {
    session.nextNudgeAt = null;
    return [];
  }

  if (Math.random() < 0.18) {
    scheduleProactiveNudge(session, {
      firstContact: session.opponentCount === 0,
    });
    return [];
  }

  const firstContact = session.opponentCount === 0;
  const line = pick(firstContact ? HELLO_LINES : NUDGE_LINES);
  session.history.push({ role: "assistant", content: line });
  session.opponentCount += 1;
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount += 1;
  session.pendingNudges.push(line);

  if (session.nudgeCount < 2 && Math.random() < 0.45) {
    scheduleProactiveNudge(session);
  } else {
    session.nextNudgeAt = null;
  }

  return drainPendingNudges(session);
}

export function drainPendingNudges(session: GameSession): string[] {
  if (!session.pendingNudges.length) return [];
  const lines = session.pendingNudges.slice();
  session.pendingNudges = [];
  return lines;
}
