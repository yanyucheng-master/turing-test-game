import { TIME_LIMIT_SEC } from "@contracts/types";
import { INITIAL_CONFIG } from "./config";
import type { GameSession } from "./store";

export interface EnvironmentState {
  elapsedMs: number;
  remainingMs: number;
  playerMessageCount: number;
  opponentMessageCount: number;
  accusationCount: number;
  silenceDurationMs: number;
  conversationIntensity: "low" | "normal" | "high";
}

export function getEnvironmentState(session: GameSession): EnvironmentState {
  const now = Date.now();
  const elapsedMs = now - session.startedAt;
  const remainingMs = Math.max(0, TIME_LIMIT_SEC * 1000 - elapsedMs);
  const lastAct = Math.max(
    session.lastPlayerActivityAt,
    session.lastOpponentActivityAt,
  );
  const silenceDurationMs = lastAct > 0 ? now - lastAct : 0;
  const total = session.playerCount + session.opponentCount;
  const conversationIntensity =
    total >= 10 ? "high" : total <= 3 ? "low" : "normal";

  return {
    elapsedMs,
    remainingMs,
    playerMessageCount: session.playerCount,
    opponentMessageCount: session.opponentCount,
    accusationCount: session.memory.accusationCount,
    silenceDurationMs,
    conversationIntensity,
  };
}

/** Natural-language notes for the model; respects per-game meta budget. */
export function describeEnvironment(session: GameSession): string[] {
  const state = getEnvironmentState(session);
  const notes: string[] = [];

  if (state.remainingMs < 25_000) notes.push("对话时间已经不多");
  if (state.accusationCount >= 2) notes.push("对方已经连续质疑你的身份");
  if (state.silenceDurationMs > 15_000) notes.push("刚才出现了一段明显沉默");
  if (state.conversationIntensity === "high") notes.push("聊得比较密");

  // Soft meta allowance — planner may use at most N times via flag.
  if (
    notes.length > 0 &&
    session.memory.metaTurns >= INITIAL_CONFIG.maxMetaConversationTurns
  ) {
    return notes.filter((n) => !n.includes("时间") && !n.includes("质疑"));
  }

  return notes;
}

export function markMetaUsed(session: GameSession, replyParts: string[]): void {
  const joined = replyParts.join("");
  if (
    /时间|审讯|测试我|选完了|怎么不说话|一直问/.test(joined) &&
    session.memory.metaTurns < INITIAL_CONFIG.maxMetaConversationTurns
  ) {
    session.memory.metaTurns += 1;
  }
}
