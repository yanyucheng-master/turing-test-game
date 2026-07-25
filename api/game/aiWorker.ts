import type { GameSession } from "./store";
import {
  enqueueOpponentMessage,
  getSession,
  isChatClosed,
} from "./store";
import { generateOpponentTurn, generateOpeningTurn } from "./generateTurn";
import { afterAiReply, holdDelayedOpener } from "./proactive";
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

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
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

  session.aiJobPending = true;
  void (async () => {
    try {
      const live = getSession(gameId);
      if (!live || isChatClosed(live) || live.myGuess || live.aiJudgedAt) return;

      // User lines already in history at accept time (real UI order).
      const turn = await generateOpponentTurn(live, next);
      const again = getSession(gameId);
      if (!again || isChatClosed(again) || again.myGuess || again.aiJudgedAt) {
        return;
      }

      const now = Date.now();
      for (const d of turn.deliveries) {
        enqueueOpponentMessage(again, d.text, now + d.delayMs);
        again.history.push({ role: "assistant", content: d.text });
        again.opponentCount += 1;
      }
      if (turn.deliveries.length) {
        afterAiReply(again);
      }
    } catch (err) {
      console.error("[aiWorker] generation failed:", err);
    } finally {
      const s = getSession(gameId);
      if (s) {
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
  const burst = session.pendingPlayerBurst.splice(0);
  if (!burst.length) return;
  const combined = burst.join("\n");
  session.aiReplyQueue.push(combined);
  pumpQueue(gameId);
}

/**
 * Accept player text: write history immediately, coalesce rapid lines, then
 * generate one AI reply for the burst.
 */
export function queueAiGeneration(
  session: GameSession,
  playerText: string,
): void {
  if (session.mode !== "ai") return;
  if (isChatClosed(session) || session.myGuess || session.aiJudgedAt) return;

  session.history.push({ role: "user", content: playerText });
  session.pendingPlayerBurst.push(playerText);

  if (session.burstTimer) clearTimeout(session.burstTimer);
  session.burstTimer = setTimeout(
    () => flushPlayerBurst(session.id),
    BURST_MS,
  );
}

/**
 * Generate opening off the matchmaking hot path.
 * Cap LLM wait at 1.5s then fall back to persona-local openers.
 */
export function queueOpeningTurn(
  session: GameSession,
  openStyle: "immediate" | "delayed",
): void {
  const gameId = session.id;
  void (async () => {
    try {
      const live = getSession(gameId);
      if (!live || live.mode !== "ai" || isChatClosed(live)) return;
      if (live.lastPlayerActivityAt > 0 || live.playerCount > 0) return;

      let opener: string | null = null;
      try {
        opener = await Promise.race([
          generateOpeningTurn(live).then((o) => (o?.trim() ? o : null)),
          delay(OPENER_WAIT_MS),
        ]);
      } catch {
        opener = null;
      }
      if (!opener?.trim()) opener = personaOpeningFallback(live);

      const again = getSession(gameId);
      if (!again || isChatClosed(again)) return;
      if (again.lastPlayerActivityAt > 0 || again.playerCount > 0) return;
      if (again.pendingOpener || again.opponentCount > 0) return;

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
    }
  })();
}
