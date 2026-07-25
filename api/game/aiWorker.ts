import type { GameSession } from "./store";
import { enqueueOpponentMessage, getSession } from "./store";
import { generateOpponentTurn, generateOpeningTurn } from "./generateTurn";
import { afterAiReply, holdDelayedOpener } from "./proactive";
import { fallbackOpener } from "./personas";

function pumpQueue(gameId: string): void {
  const session = getSession(gameId);
  if (!session || session.mode !== "ai") return;
  if (session.aiJobPending) return;
  if (session.finished || session.myGuess || session.aiJudgedAt) {
    session.aiReplyQueue = [];
    return;
  }
  const next = session.aiReplyQueue.shift();
  if (!next) return;

  session.aiJobPending = true;
  void (async () => {
    try {
      const live = getSession(gameId);
      if (!live || live.finished || live.myGuess || live.aiJudgedAt) return;

      live.history.push({ role: "user", content: next });
      const turn = await generateOpponentTurn(live, next);
      const again = getSession(gameId);
      if (!again || again.finished || again.myGuess || again.aiJudgedAt) return;

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

/**
 * Enqueue player text for AI reply. Never await from chat HTTP handler.
 */
export function queueAiGeneration(
  session: GameSession,
  playerText: string,
): void {
  if (session.mode !== "ai") return;
  if (session.finished || session.myGuess || session.aiJudgedAt) return;
  session.aiReplyQueue.push(playerText);
  pumpQueue(session.id);
}

/**
 * Generate opening off the matchmaking hot path.
 */
export function queueOpeningTurn(
  session: GameSession,
  openStyle: "immediate" | "delayed",
): void {
  const gameId = session.id;
  void (async () => {
    try {
      const live = getSession(gameId);
      if (!live || live.mode !== "ai") return;
      // Player already spoke — skip opener.
      if (live.lastPlayerActivityAt > 0 || live.playerCount > 0) return;

      let opener: string;
      try {
        opener = await generateOpeningTurn(live);
      } catch {
        opener = fallbackOpener(live.persona);
      }
      if (!opener.trim()) opener = fallbackOpener(live.persona);

      const again = getSession(gameId);
      if (!again || again.lastPlayerActivityAt > 0 || again.playerCount > 0) {
        return;
      }
      if (again.pendingOpener || again.opponentCount > 0) return;

      const noticeMs =
        openStyle === "immediate"
          ? 400 + Math.random() * 1_200
          : 2_500 + Math.random() * 6_000;
      holdDelayedOpener(again, opener, noticeMs);
    } catch (err) {
      console.error("[aiWorker] opening failed:", err);
    }
  })();
}
