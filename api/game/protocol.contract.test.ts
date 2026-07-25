import { describe, expect, it } from "vitest";
import type { ChatAck, EventPullResult, MatchStatus } from "@contracts/types";
import { scrubReply } from "./personas";
import { flavorJudgePlayer } from "./aiJudgment";
import type { GameSession } from "./store";

/** Shape guards — keep AI/PvP wire formats indistinguishable pre-reveal. */

const FORBIDDEN_KEYS = [
  "opponentsource",
  "persona",
  "llm",
  "player",
  "machine",
  "truth",
  "socialpersonaid",
];

function assertNoIdentityKeys(obj: unknown, path = "$") {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.toLowerCase();
    expect(
      FORBIDDEN_KEYS.includes(key),
      `${path}.${k} must not leak identity`,
    ).toBe(false);
    if (v && typeof v === "object") assertNoIdentityKeys(v, `${path}.${k}`);
  }
}

describe("pre-reveal protocol shapes", () => {
  it("matched payload has no identity fields", () => {
    const matched: Extract<MatchStatus, { status: "matched" }> = {
      status: "matched",
      gameId: "g1",
      timeLimitSec: 120,
      maxPlayerMessages: 12,
    };
    assertNoIdentityKeys(matched);
    expect("opponentSource" in matched).toBe(false);
    expect("opener" in matched).toBe(false);
  });

  it("chat ack shape is identity-free", () => {
    const ack: ChatAck = {
      ok: true,
      acceptedAt: Date.now(),
      limitReached: false,
    };
    assertNoIdentityKeys(ack);
    expect("reply" in ack).toBe(false);
    expect("typingMs" in ack).toBe(false);
    expect("pending" in ack).toBe(false);
  });

  it("events chat payload has no identity fields", () => {
    const pull: Extract<EventPullResult, { phase: "chat" }> = {
      ok: true,
      phase: "chat",
      cursor: 1,
      events: [
        {
          seq: 1,
          type: "message",
          from: "opponent",
          text: "嗨",
          deliverAt: Date.now(),
        },
      ],
      chatLocked: false,
      mustJudge: false,
      judgeDeadlineAt: null,
    };
    assertNoIdentityKeys(pull);
  });
});

describe("reply hygiene", () => {
  it("strips casual punctuation", () => {
    expect(scrubReply("你好。还行！")).toBe("你好还行");
    expect(scrubReply("？？")).toBe("？？");
    expect(scrubReply("在吗？")).toBe("在吗");
  });
});

describe("flavor judgment", () => {
  it("returns human or ai", () => {
    const session = {
      history: [
        { role: "user", content: "今天好累啊刚下班" },
        { role: "user", content: "你呢" },
      ],
      memory: { accusationCount: 0 },
      socialPersonaId: "tired_worker_01",
    } as unknown as GameSession;
    const g = flavorJudgePlayer(session);
    expect(g === "human" || g === "ai").toBe(true);
  });
});
