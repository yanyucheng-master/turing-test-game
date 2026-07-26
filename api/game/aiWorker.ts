import type { GameSession } from "./store";
import {
  MAX_LLM_CALLS_PER_GAME,
  appendUserTranscript,
  cancelPendingAssistant,
  getSession,
  isChatClosed,
  schedulePendingAssistant,
} from "./store";
import { generateOpponentTurn, generateOpeningTurn } from "./generateTurn";
import { afterAiReply, beginSilentMatch, holdDelayedOpener } from "./proactive";
import { fallbackOpener } from "./personas";
import {
  getSocialPersona,
  type PersonaCluster,
} from "./socialPersonas";

const BURST_MS = 350;
const OPENER_WAIT_MS = 1_500;

const CLUSTER_OPENERS: Record<PersonaCluster, string[]> = {
  campus_night: ["嗨", "还没睡啊", "哈喽"],
  slow_observer: ["嗯你好", "嗨"],
  tired_worker: ["在", "刚下班"],
  commute_fragment: ["在", "嗨"],
  teasing_friend: ["哈喽", "嘿"],
  cautious_guard: ["你好", "嗨"],
  high_social: ["哈喽", "终于匹配上了"],
  cold_low_interest: ["在", "嗯"],
  creative_procrastinator: ["嗨", "摸鱼吗"],
  night_shift: ["在", "还醒着"],
};

function personaOpeningFallback(session: GameSession): string {
  const persona = getSocialPersona(session.socialPersonaId);
  const pool = CLUSTER_OPENERS[persona.cluster] ?? ["嗨"];
  return pool[Math.floor(Math.random() * pool.length)];
}

function delay(ms: number, signal?: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const t = setTimeout(() => resolve(null), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve(null);
      },
      { once: true },
    );
  });
}

function unansweredPlayerText(session: GameSession): string {
  const visible = session.transcript
    .filter((e) => e.state === "visible")
    .sort((a, b) => a.occurredAt - b.occurredAt);
  let lastAssistant = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  return visible
    .slice(lastAssistant + 1)
    .filter((e) => e.role === "user")
    .map((e) => e.text)
    .join("\n");
}

function snapshotMutables(session: GameSession) {
  return {
    memory: structuredClone(session.memory),
    llmCallsUsed: session.llmCallsUsed,
  };
}

function restoreMutables(
  session: GameSession,
  snap: ReturnType<typeof snapshotMutables>,
): void {
  session.memory = snap.memory;
  session.llmCallsUsed = snap.llmCallsUsed;
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
  const mutablesSnap = snapshotMutables(session);

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
        if (!committed) restoreMutables(s, mutablesSnap);
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
  session.aiReplyQueue = [combined];
  pumpQueue(gameId);
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
  session.pendingPlayerBurst.push(playerText);

  if (session.burstTimer) clearTimeout(session.burstTimer);
  session.burstTimer = setTimeout(
    () => flushPlayerBurst(session.id),
    BURST_MS,
  );
}

/**
 * Opening is started only after acceptMatch (or auto-claim).
 * Cap LLM wait at 1.5s and abort the underlying request on timeout.
 */
export function queueOpeningTurn(
  session: GameSession,
  openStyle: "immediate" | "delayed",
): void {
  if (session.openerStarted) return;
  session.openerStarted = true;
  const gameId = session.id;
  const abort = new AbortController();
  session.llmAbort = abort;

  void (async () => {
    try {
      const live = getSession(gameId);
      if (!live || live.mode !== "ai" || isChatClosed(live)) return;
      if (live.lastPlayerActivityAt > 0 || live.playerCount > 0) return;

      let opener: string | null = null;
      try {
        opener = await Promise.race([
          generateOpeningTurn(live, { signal: abort.signal }).then((o) =>
            o?.trim() ? o : null,
          ),
          delay(OPENER_WAIT_MS, abort.signal).then(() => {
            abort.abort();
            return null;
          }),
        ]);
      } catch {
        opener = null;
      }
      if (!opener?.trim()) opener = personaOpeningFallback(live);

      const again = getSession(gameId);
      if (!again || isChatClosed(again)) return;
      if (again.lastPlayerActivityAt > 0 || again.playerCount > 0) return;
      if (again.pendingOpener || again.opponentCount > 0) return;
      if (again.inputRevision !== 0) return;

      const noticeMs =
        openStyle === "immediate"
          ? 400 + Math.random() * 1_200
          : 2_500 + Math.random() * 6_000;
      holdDelayedOpener(again, opener, noticeMs);
    } catch (err) {
      console.error("[aiWorker] opening failed:", err);
      const again = getSession(gameId);
      if (
        again &&
        !isChatClosed(again) &&
        again.playerCount === 0 &&
        !again.pendingOpener &&
        again.opponentCount === 0
      ) {
        holdDelayedOpener(again, fallbackOpener(again.persona), 400);
      }
    } finally {
      const s = getSession(gameId);
      if (s && s.llmAbort === abort) s.llmAbort = null;
    }
  })();
}

/** Kick opening / silent wait after the client has claimed the match. */
export function startClaimedOpening(session: GameSession): void {
  if (session.mode !== "ai" || session.openerStarted) return;
  const style = session.pendingOpenStyle ?? "immediate";
  session.pendingOpenStyle = null;
  if (style === "wait") {
    session.openerStarted = true;
    beginSilentMatch(session);
    return;
  }
  queueOpeningTurn(session, style);
}
