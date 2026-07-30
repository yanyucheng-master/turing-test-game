import type { GameSession } from "./store";
import {
  MAX_LLM_CALLS_PER_GAME,
  appendUserTranscript,
  cancelPendingAssistant,
  getSession,
  isChatClosed,
  schedulePendingAssistant,
} from "./store";
import { generateOpponentTurn, pickOpeningLine } from "./generateTurn";
import { afterAiReply, beginSilentMatch, holdDelayedOpener } from "./proactive";
import { fallbackOpener } from "./personas";
import { nextRng } from "./rng";
import {
  clearReplySkipState,
  decideReplyToPlayer,
  hasPendingAssistant,
  onSkipReply,
  unansweredPlayerText,
} from "./replyGate";

const BURST_MS = 350;

function snapshotMemory(session: GameSession) {
  return structuredClone(session.memory);
}

function restoreMemory(
  session: GameSession,
  memory: ReturnType<typeof snapshotMemory>,
): void {
  // Keep llmCallsUsed — cancelled calls still consumed budget / slots.
  session.memory = memory;
}

function pumpQueue(gameId: string): void {
  const session = getSession(gameId);
  if (!session || session.mode !== "ai") return;
  if (session.aiJobPending) return;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) {
    session.aiReplyQueue = [];
    return;
  }
  const next = session.aiReplyQueue.shift();
  if (!next) return;

  const revision = session.inputRevision;
  session.aiJobPending = true;
  const abort = new AbortController();
  session.llmAbort = abort;
  const memorySnap = snapshotMemory(session);

  void (async () => {
    let committed = false;
    try {
      const live = getSession(gameId);
      if (!live || isChatClosed(live) || live.myGuess || live.aiJudgedAt) return;
      if (live.inputRevision !== revision) return;
      if (live.llmCallsUsed >= MAX_LLM_CALLS_PER_GAME) return;

      const turn = await generateOpponentTurn(live, next, {
        signal: abort.signal,
      });
      const again = getSession(gameId);
      if (!again || isChatClosed(again) || again.myGuess || again.aiJudgedAt) {
        return;
      }
      if (again.inputRevision !== revision || abort.signal.aborted) return;

      const now = Date.now();
      let scheduled = 0;
      for (const d of turn.deliveries) {
        if (
          schedulePendingAssistant(again, d.text, now + d.delayMs, revision)
        ) {
          scheduled += 1;
        }
      }
      if (scheduled) {
        clearReplySkipState(again);
        afterAiReply(again);
      }
      committed = true;
    } catch (err) {
      if (!(err instanceof Error && /abort/i.test(err.message))) {
        console.error("[aiWorker] generation failed:", err);
      }
    } finally {
      const s = getSession(gameId);
      if (s) {
        if (!committed) restoreMemory(s, memorySnap);
        if (s.llmAbort === abort) s.llmAbort = null;
        s.aiJobPending = false;
        pumpQueue(gameId);
      }
    }
  })();
}

function flushPlayerBurst(gameId: string): void {
  const session = getSession(gameId);
  if (!session || session.mode !== "ai") return;
  session.burstTimer = null;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) {
    session.pendingPlayerBurst = [];
    return;
  }
  session.pendingPlayerBurst = [];
  const combined = unansweredPlayerText(session);
  if (!combined.trim()) return;

  const decision = decideReplyToPlayer(session);
  if (decision === "busy") return;
  if (decision === "skip") {
    onSkipReply(session);
    return;
  }

  // Keep skippedReplyStreak until delivery succeeds (see pumpQueue).
  session.deferredReplyAt = null;
  session.aiReplyQueue = [combined];
  pumpQueue(gameId);
}

/**
 * Late reply after a skip — called from the events / nudge poll loop.
 */
export function flushDeferredAiReply(session: GameSession): void {
  if (session.mode !== "ai") return;
  if (!session.deferredReplyAt || Date.now() < session.deferredReplyAt) return;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) {
    session.deferredReplyAt = null;
    return;
  }
  // Busy: retry soon instead of dropping the deferred reply.
  if (
    session.aiJobPending ||
    session.burstTimer ||
    session.aiReplyQueue.length ||
    hasPendingAssistant(session)
  ) {
    session.deferredReplyAt = Date.now() + 450;
    return;
  }
  const combined = unansweredPlayerText(session);
  if (!combined.trim()) {
    session.deferredReplyAt = null;
    return;
  }
  session.deferredReplyAt = null;
  session.aiReplyQueue = [combined];
  pumpQueue(session.id);
}

/**
 * Accept player text into timed transcript, invalidate undelivered AI work,
 * coalesce rapid lines, then regenerate against the real visible order.
 */
export function queueAiGeneration(
  session: GameSession,
  playerText: string,
): void {
  if (session.mode !== "ai") return;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) return;

  appendUserTranscript(session, playerText);
  cancelPendingAssistant(session);
  session.aiReplyQueue = [];
  session.deferredReplyAt = null;
  session.pendingPlayerBurst.push(playerText);

  if (session.burstTimer) clearTimeout(session.burstTimer);
  session.burstTimer = setTimeout(
    () => flushPlayerBurst(session.id),
    BURST_MS,
  );
}

/** Local openers only — no LLM call on match claim. */
export function queueOpeningTurn(
  session: GameSession,
  openStyle: "immediate" | "delayed",
): void {
  if (session.openerStarted) return;
  session.openerStarted = true;
  const gameId = session.id;

  try {
    const live = getSession(gameId);
    if (!live || live.mode !== "ai" || isChatClosed(live)) return;
    if (live.neverSpeakFirst) {
      beginSilentMatch(live);
      return;
    }
    if (live.lastPlayerActivityAt > 0 || live.playerCount > 0) return;

    const opener = pickOpeningLine(live);
    if (live.pendingOpener || live.opponentCount > 0) return;
    if (live.inputRevision !== 0) return;

    const noticeMs =
      openStyle === "immediate"
        ? 400 + nextRng(live) * 1_200
        : 2_500 + nextRng(live) * 6_000;
    holdDelayedOpener(live, opener, noticeMs);
  } catch (err) {
    console.error("[aiWorker] opening failed:", err);
    const again = getSession(gameId);
    if (
      again &&
      !isChatClosed(again) &&
      again.playerCount === 0 &&
      !again.pendingOpener &&
      again.opponentCount === 0 &&
      !again.neverSpeakFirst
    ) {
      holdDelayedOpener(again, fallbackOpener(again.persona), 400);
    }
  }
}

/** Kick opening / silent wait after the client has claimed the match. */
export function startClaimedOpening(session: GameSession): void {
  if (session.mode !== "ai" || session.openerStarted) return;
  const style = session.pendingOpenStyle ?? "immediate";
  session.pendingOpenStyle = null;
  if (style === "wait" || session.neverSpeakFirst) {
    session.openerStarted = true;
    beginSilentMatch(session);
    return;
  }
  queueOpeningTurn(session, style);
}
