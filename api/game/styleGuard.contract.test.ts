import { describe, expect, it } from "vitest";
import { runStyleGuard } from "./styleGuard";
import type { TurnPlan } from "./turnPolicy";

const plan: TurnPlan = {
  answerMode: "direct",
  stance: "neutral",
  relationshipAction: "none",
  outputShape: "single",
  targetLength: "short",
  emotionalTone: "neutral",
};

describe("styleGuard hard gate", () => {
  it("clears parts on AI self-identification", () => {
    const g = runStyleGuard(["作为AI我不能这样说"], plan, []);
    expect(g.passed).toBe(false);
    expect(g.severity).toBe("high");
    expect(g.parts).toEqual([]);
  });
});
