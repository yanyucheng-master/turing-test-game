import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JUDGMENT_GRACE_MS,
  closeChat,
  createAiSession,
  getSession,
} from "./store";
import { resolveFinish, submitPlayerGuess } from "./settle";
import {
  __debugTicket,
  __resetMatchmakingForTests,
  ensureClaimedByGameId,
  joinMatch,
  pollMatch,
} from "./matchmaking";
import {
  __resetRateLimitsForTests,
  canRegisterActiveGame,
  registerActiveGame,
} from "./rateLimit";
import { queueAiGeneration } from "./aiWorker";
import * as generateTurn from "./generateTurn";

describe("finish deadline + claim gate + llm budget", () => {
  beforeEach(() => {
    __resetMatchmakingForTests();
    __resetRateLimitsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetMatchmakingForTests();
    __resetRateLimitsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("finish after judgment deadline settles timeout instead of accepting guess", async () => {
    // Hazard: submitPlayerGuess alone still accepts after the wall clock passes,
    // because timeouts only apply inside revealIfReady / resolveFinish.
    const hazard = createAiSession("finish-hazard", "human", null);
    closeChat(hazard, "message_limit");
    vi.setSystemTime(Date.now() + JUDGMENT_GRACE_MS + 1);
    expect(hazard.timedOut).toBe(false);
    submitPlayerGuess(hazard, "ai");
    expect(hazard.myGuess).toBe("ai");

    // Correct path used by finish.
    vi.setSystemTime(1_700_000_200_000);
    const late = createAiSession("finish-late-ok", "human", null);
    closeChat(late, "message_limit");
    vi.setSystemTime(Date.now() + JUDGMENT_GRACE_MS + 1);
    const outcome = await resolveFinish(late, "human");
    expect(outcome.phase).toBe("revealed");
    if (outcome.phase === "revealed") {
      expect(outcome.result.timedOut).toBe(true);
      expect(outcome.result.myGuess).toBeNull();
    }
    expect(getSession("finish-late-ok")).toBeUndefined();
  });

  it("third concurrent game is rejected before auto-claim starts AI opener", async () => {
    const ip = "203.0.113.9";
    registerActiveGame(ip, "active-1");
    registerActiveGame(ip, "active-2");

    const { ticketId } = joinMatch();
    const t0 = __debugTicket(ticketId)!;
    vi.setSystemTime(t0.revealAt + 1);
    const status = await pollMatch(ticketId);
    expect(status.status).toBe("matched");
    if (status.status !== "matched") return;

    const gameId = status.gameId;
    expect(canRegisterActiveGame(ip, gameId)).toBe(false);

    // Correct router order: skip ensureClaimed when over the active-game limit.
    expect(getSession(gameId)?.openerStarted).toBe(false);
    expect(__debugTicket(ticketId)?.claimed).toBeFalsy();

    // Contrast: claiming first would start the opener even when over limit.
    ensureClaimedByGameId(gameId);
    expect(__debugTicket(ticketId)?.claimed).toBe(true);
    expect(getSession(gameId)?.openerStarted).toBe(true);
  });

  it("cancelled generation keeps llmCallsUsed but rolls back memory", async () => {
    vi.spyOn(generateTurn, "generateOpponentTurn").mockImplementation(
      async (session) => {
        session.llmCallsUsed += 1;
        session.memory.accusationCount += 10;
        await new Promise((r) => setTimeout(r, 500));
        return {
          replyParts: ["嗯"],
          deliveries: [{ text: "嗯", delayMs: 0 }],
          plan: {
            strategy: "react_only" as const,
            answerMode: "direct" as const,
            stance: "neutral" as const,
            relationshipAction: "none" as const,
            outputShape: "single" as const,
            targetLength: "tiny" as const,
            emotionalTone: "neutral" as const,
            interpretationMode: "literal" as const,
            allowQuestion: false,
            maxChars: 12,
          },
          userAct: "greeting" as const,
        };
      },
    );

    const s = createAiSession("budget-1", "human", null);
    queueAiGeneration(s, "你是AI吗");
    await vi.advanceTimersByTimeAsync(400); // burst flush → gen starts

    // Cancel in-flight work, then freeze chat so a follow-up turn cannot commit.
    queueAiGeneration(s, "再说一次");
    closeChat(s, "player_judged");
    await vi.advanceTimersByTimeAsync(600); // aborted turn finishes + restores

    const live = getSession("budget-1")!;
    expect(live.llmCallsUsed).toBeGreaterThanOrEqual(1);
    expect(live.memory.accusationCount).toBe(0);
  });
});
