import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../lib/env";
import {
  __debugCultureMemory,
  __resetCultureMemoryForTests,
  findCultureCue,
  observeCulturePhrase,
  observeCultureReaction,
} from "./cultureMemory";
import {
  reviewCultureCandidate,
  type CultureReviewDecision,
} from "./cultureReviewer";
import { cultureReviewRouter } from "./cultureReviewRouter";
import { __resetRateLimitsForTests } from "./rateLimit";

vi.mock("./cultureReviewer", () => ({
  reviewCultureCandidate: vi.fn(),
  cultureEvidenceScore: (supportCount: number) =>
    supportCount >= 7 ? 10 : supportCount >= 5 ? 9 : supportCount >= 4 ? 8 : 6,
}));

const TOKEN = "owner-review-token-with-32-characters";
const PHRASE = "电子木鱼今天替我加班哈哈哈";
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
let previousToken = "";

type CallerOptions = {
  origin?: string;
  proxyToken?: string;
  secFetchSite?: string;
  retiredTokenHeader?: string;
};

function caller(options: CallerOptions = {}) {
  const headers = new Headers({ "x-real-ip": "203.0.113.80" });
  if (options.origin) headers.set("origin", options.origin);
  if (options.proxyToken) {
    headers.set("x-culture-review-companion-token", options.proxyToken);
  }
  if (options.secFetchSite) {
    headers.set("sec-fetch-site", options.secFetchSite);
  }
  if (options.retiredTokenHeader) {
    headers.set("x-culture-review-token", options.retiredTokenHeader);
  }
  return cultureReviewRouter.createCaller({
    req: new Request("http://localhost/api/trpc", { headers }),
    resHeaders: new Headers(),
  });
}

async function createPendingCandidate(phrase = PHRASE) {
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await observeCulturePhrase({
      sourceId: `review-source-${phrase}-${i}`,
      text: phrase,
      now: now + i,
    });
  }
}

describe("local-companion culture review API", () => {
  beforeEach(() => {
    previousToken = env.cultureReviewToken;
    env.cultureReviewToken = TOKEN;
    __resetCultureMemoryForTests();
    __resetRateLimitsForTests();
    vi.mocked(reviewCultureCandidate).mockReset();
    vi.mocked(reviewCultureCandidate).mockResolvedValue(PASS_REVIEW);
  });

  afterEach(() => {
    env.cultureReviewToken = previousToken;
    vi.restoreAllMocks();
  });

  it("looks nonexistent without the local companion credential", async () => {
    await expect(caller().report()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Not Found",
    });
    await expect(
      caller({ retiredTokenHeader: TOKEN }).report()
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller({ proxyToken: "wrong-companion-token" }).report()
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("accepts the server-side companion token but never a browser-origin copy", async () => {
    await expect(caller({ proxyToken: TOKEN }).session()).resolves.toEqual({
      authenticated: true,
    });

    await expect(
      caller({
        origin: "http://127.0.0.1:3001",
        proxyToken: TOKEN,
        secFetchSite: "same-origin",
      }).session()
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks an owner-edited approval as curated and activates only that text", async () => {
    await createPendingCandidate();
    const owner = caller({ proxyToken: TOKEN });
    const report = await owner.report();
    expect(report.pendingCount).toBe(1);
    expect(findCultureCue(PHRASE)).toBeNull();

    const editedPhrase = "电子木鱼今天申请带薪摸鱼哈哈哈";
    const result = await owner.approve({
      fingerprint: report.items[0]!.fingerprint,
      editedPhrase,
      allowAsOpener: false,
    });

    expect(result).toMatchObject({
      ok: true,
      phrase: editedPhrase,
      origin: "curated",
    });
    expect(findCultureCue(editedPhrase)?.origin).toBe("curated");
    expect(findCultureCue(PHRASE)).toBeNull();
    expect(reviewCultureCandidate).toHaveBeenCalledTimes(2);

    await observeCultureReaction({
      sourceId: "curated-reaction-source",
      trigger: editedPhrase,
      response: "啥意思？",
    });
    expect(findCultureCue(editedPhrase)?.responseMode).toBe("clarify_light");
  });

  it("removes rejected candidate text from the quarantine state", async () => {
    await createPendingCandidate();
    const owner = caller({ proxyToken: TOKEN });
    const report = await owner.report();
    await owner.reject({
      fingerprint: report.items[0]!.fingerprint,
    });

    expect((await owner.report()).pendingCount).toBe(0);
    expect(__debugCultureMemory().candidates[0]).toMatchObject({
      status: "rejected",
      hasReviewPhrase: false,
      rejectionReason: "human_reject",
    });
  });
});
