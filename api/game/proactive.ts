import type { GameSession } from "./store";
import {
  isChatClosed,
  schedulePendingAssistant,
} from "./store";
import { scrubReply } from "./personas";
import { getSocialPersona } from "./socialPersonas";
import { INITIAL_CONFIG } from "./config";
import { calculateReplyDelay } from "./timing";
import { buildTurnPlan } from "./turnPolicy";
import { decideKnowledgeBoundary } from "./knowledgeBoundary";
import { contextualNudgeLine } from "./memory";

const HELLO_LINES = ["嗨", "哈喽", "在吗", "嘿", "hi", "有人吗"];

function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function scheduleProactiveNudge(
  session: GameSession,
  opts?: { firstContact?: boolean },
): void {
  if (session.mode !== "ai") return;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) {
    session.nextNudgeAt = null;
    return;
  }

  const persona = getSocialPersona(session.socialPersonaId);
  const maxNudge = persona.tempo.followUpMax;
  if (maxNudge <= 0) {
    session.nextNudgeAt = null;
    return;
  }
  if (session.nudgeCount >= maxNudge) {
    session.nextNudgeAt = null;
    return;
  }

  const first = opts?.firstContact || session.opponentCount === 0;
  const minSilence = INITIAL_CONFIG.proactiveMinSilenceMs;
  const delay = first
    ? minSilence + Math.random() * 13_000
    : minSilence + Math.random() * 10_000;
  session.nextNudgeAt = Date.now() + delay;
}

export function onPlayerActivity(session: GameSession): void {
  session.lastPlayerActivityAt = Date.now();
  session.nextNudgeAt = null;
  if (session.pendingOpener) {
    session.pendingOpener = null;
    session.delayedOpenerAt = null;
  }
}

export function afterAiReply(session: GameSession): void {
  session.lastOpponentActivityAt = Date.now();
  // Do NOT reset nudgeCount — followUpMax is per-match, not per-reply.
  scheduleProactiveNudge(session);
}

export function beginSilentMatch(session: GameSession): void {
  session.lastPlayerActivityAt = 0;
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount = 0;
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  scheduleProactiveNudge(session, { firstContact: true });
}

export function holdDelayedOpener(
  session: GameSession,
  opener: string,
  delayMs?: number,
): void {
  const cleaned = scrubReply(opener) || opener;
  session.pendingOpener = cleaned;
  session.delayedOpenerAt =
    Date.now() + (delayMs ?? 2_500 + Math.random() * 6_000);
  session.lastPlayerActivityAt = 0;
  session.lastOpponentActivityAt = Date.now();
  session.nudgeCount = 0;
  session.nextNudgeAt = null;
}

function flushDelayedOpener(session: GameSession): void {
  if (!session.pendingOpener || !session.delayedOpenerAt) return;
  if (isChatClosed(session)) {
    session.pendingOpener = null;
    session.delayedOpenerAt = null;
    return;
  }
  if (Date.now() < session.delayedOpenerAt) return;
  if (session.lastPlayerActivityAt > 0) {
    session.pendingOpener = null;
    session.delayedOpenerAt = null;
    return;
  }

  const line = session.pendingOpener;
  session.pendingOpener = null;
  session.delayedOpenerAt = null;
  schedulePendingAssistant(session, line, Date.now(), session.inputRevision);
  scheduleProactiveNudge(session);
}

/**
 * Deliver delayed openers / silence nudges into outbox.
 */
export function maybeProactiveNudge(session: GameSession): void {
  if (session.mode !== "ai") return;
  if (
    isChatClosed(session) ||
    session.myGuess ||
    session.aiJudgedAt ||
    session.settled
  ) {
    return;
  }

  flushDelayedOpener(session);

  if (!session.nextNudgeAt || Date.now() < session.nextNudgeAt) return;
  if (session.pendingOpener) {
    session.nextNudgeAt = null;
    return;
  }

  const persona = getSocialPersona(session.socialPersonaId);
  if (session.nudgeCount >= persona.tempo.followUpMax) {
    session.nextNudgeAt = null;
    return;
  }

  if (
    session.opponentCount > 0 &&
    session.lastPlayerActivityAt >= session.lastOpponentActivityAt
  ) {
    session.nextNudgeAt = null;
    return;
  }

  // Player short-reply boredom: less likely to chase
  if (session.memory.emotionalState.mood === "bored" && Math.random() < 0.6) {
    session.nextNudgeAt = null;
    return;
  }

  if (Math.random() < 0.18) {
    scheduleProactiveNudge(session, {
      firstContact: session.opponentCount === 0,
    });
    return;
  }

  const firstContact = session.opponentCount === 0;
  let line: string;
  if (firstContact) {
    line = scrubReply(pick(HELLO_LINES)) || "嗨";
  } else {
    const contextual = contextualNudgeLine(session);
    if (contextual && Math.random() < 0.6) {
      line = scrubReply(contextual) || contextual;
    } else {
      line = scrubReply(pick(["还在吗", "？", "嘿"])) || "？";
    }
  }

  // Avoid repeating
  const id = line.slice(0, 24);
  if (session.memory.usedReplyIds.includes(id)) {
    line = "？";
  } else {
    session.memory.usedReplyIds.push(id);
  }

  const knowledge = decideKnowledgeBoundary(persona, line);
  const analysis = {
    primaryAct: "short_reaction" as const,
    oddness: 0,
    ambiguity: 0,
    playfulness: 0.2,
    hostility: 0,
    identityProbe: 0,
    personalIntrusion: 0,
    emotionalDisclosure: 0,
    confidence: 0.9,
  };
  const plan = buildTurnPlan({
    session,
    userAct: "short_reaction",
    analysis,
    knowledge,
  });
  const delay = calculateReplyDelay({
    text: line,
    persona,
    act: "short_reaction",
    plan,
    analysis,
    session,
  });

  session.nudgeCount += 1;
  schedulePendingAssistant(
    session,
    line,
    Date.now() + Math.min(delay, 2000),
    session.inputRevision,
  );

  if (session.nudgeCount < persona.tempo.followUpMax && Math.random() < 0.35) {
    scheduleProactiveNudge(session);
  } else {
    session.nextNudgeAt = null;
  }
}

/** @deprecated pending nudges now go to outbox directly */
export function drainPendingNudges(session: GameSession): string[] {
  if (!session.pendingNudges.length) return [];
  const lines = session.pendingNudges.slice();
  session.pendingNudges = [];
  return lines;
}
