import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCultureMemoryForTests,
  approveCultureCandidate,
  findCultureCue,
  getCultureReviewReport,
} from "./cultureMemory";
import {
  reviewCultureCandidate,
  type CultureReviewDecision,
} from "./cultureReviewer";
import { __resetRateLimitsForTests } from "./rateLimit";
import { gameRouter } from "./router";
import { createAiSession, deleteSession } from "./store";

vi.mock("./cultureReviewer", () => ({
  reviewCultureCandidate: vi.fn(),
  cultureEvidenceScore: (supportCount: number) =>
    supportCount >= 7 ? 10 : supportCount >= 5 ? 9 : supportCount >= 4 ? 8 : 6,
}));

const PHRASE = "电子木鱼今天替我加班哈哈哈";
const sessionIds: string[] = [];
const PASS_REVIEW = {
  scores: {
    total: 91,
    safety: 25,
    privacy: 20,
    generality: 14,
    fun: 16,
    evidence: 6,
    novelty: 10,
  },
  flags: ["none"],
  aiReason: "安全、可泛化且适合轻松闲聊",
  hardReject: false,
} satisfies CultureReviewDecision;

function callerFor(ip: string) {
  return gameRouter.createCaller({
    req: new Request("http://localhost/api/trpc", {
      headers: { "x-real-ip": ip },
    }),
    resHeaders: new Headers(),
  });
}

describe("AI-game player culture learning", () => {
  beforeEach(() => {
    __resetCultureMemoryForTests();
    __resetRateLimitsForTests();
    vi.mocked(reviewCultureCandidate).mockReset();
    vi.mocked(reviewCultureCandidate).mockResolvedValue(PASS_REVIEW);
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    for (const id of sessionIds.splice(0)) deleteSession(id);
    vi.useRealTimers();
  });

  it("sends repeated AI-match player replies to owner review before learning", async () => {
    for (let i = 0; i < 3; i += 1) {
      const gameId = `ai-culture-${i}`;
      sessionIds.push(gameId);
      createAiSession(
        gameId,
        "human",
        null,
        "normal",
        "sane",
        "teasing_friend_01"
      );
      const result = await callerFor(`203.0.113.${i + 1}`).chat({
        gameId,
        text: PHRASE,
      });
      expect(result.ok).toBe(true);
    }

    let report = await getCultureReviewReport();
    await vi.waitFor(async () => {
      report = await getCultureReviewReport();
      expect(report.pendingCount).toBe(1);
    });
    expect(findCultureCue(PHRASE)).toBeNull();
    await approveCultureCandidate({
      fingerprint: report.items[0]!.fingerprint,
    });
    expect(findCultureCue(PHRASE)).toMatchObject({
      phrase: PHRASE,
      supportCount: 3,
    });
  });
});
