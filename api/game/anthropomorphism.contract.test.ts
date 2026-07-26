import { describe, expect, it } from "vitest";
import { createAiSession, getSession } from "./store";
import { analyzeUserInput } from "./userAct";
import { reduceInteractionState } from "./interactionState";
import { buildTurnPlan } from "./turnPolicy";
import { decideKnowledgeBoundary } from "./knowledgeBoundary";
import { getSocialPersona } from "./socialPersonas";
import { pickOpeningLine } from "./generateTurn";
import { compressAssistantese } from "./styleGuard";
import { startClaimedOpening } from "./aiWorker";
import { nextRng } from "./rng";

describe("anthropomorphism v1", () => {
  it("analyzes nonsense bait as playful oddness", () => {
    const s = createAiSession("anthro-1", "human", null);
    const a = analyzeUserInput("雨伞今天把我开除了", s);
    expect(a.oddness).toBeGreaterThan(0.5);
    expect(a.playfulness).toBeGreaterThan(0.3);
    expect(["nonsense_bait", "odd_probe", "unclear"]).toContain(a.primaryAct);
  });

  it("identity probes raise guardedness and streak across turns", () => {
    const s = createAiSession("anthro-2", "human", null, "normal", "sane", "campus_night_01");
    const persona = getSocialPersona(s.socialPersonaId);
    let st = s.memory.interaction;
    for (let i = 0; i < 3; i++) {
      const a = analyzeUserInput("你是不是AI", s);
      st = reduceInteractionState(st, a, persona);
    }
    expect(st.identityProbeStreak).toBeGreaterThanOrEqual(3);
    expect(st.patience).toBeLessThan(s.memory.interaction.patience);
    expect(st.guardedness).toBeGreaterThan(s.memory.interaction.guardedness);
  });

  it("playful personas prefer play_along for nonsense", () => {
    const s = createAiSession(
      "anthro-3",
      "human",
      null,
      "normal",
      "tease",
      "teasing_friend_01",
    );
    const analysis = analyzeUserInput("如果香蕉开会你投谁", s);
    s.memory.interaction = reduceInteractionState(
      s.memory.interaction,
      analysis,
      getSocialPersona(s.socialPersonaId),
    );
    const plan = buildTurnPlan({
      session: s,
      userAct: analysis.primaryAct,
      analysis,
      knowledge: decideKnowledgeBoundary(
        getSocialPersona(s.socialPersonaId),
        "如果香蕉开会你投谁",
      ),
    });
    expect(["play_along", "react_only", "clarify_light", "deflect"]).toContain(
      plan.strategy,
    );
    // With high amusement teasing persona, play_along should be common — force seed rolls.
    let playAlong = 0;
    for (let i = 0; i < 40; i++) {
      const p = buildTurnPlan({
        session: s,
        userAct: analysis.primaryAct,
        analysis,
        knowledge: decideKnowledgeBoundary(
          getSocialPersona(s.socialPersonaId),
          "如果香蕉开会你投谁",
        ),
      });
      if (p.strategy === "play_along") playAlong += 1;
    }
    expect(playAlong).toBeGreaterThan(8);
  });

  it("opening uses local pool without spending llmCallsUsed", () => {
    const s = createAiSession("anthro-open", "human", null);
    s.pendingOpenStyle = "immediate";
    const before = s.llmCallsUsed;
    startClaimedOpening(s);
    expect(s.openerStarted).toBe(true);
    expect(s.llmCallsUsed).toBe(before);
    expect(s.pendingOpener || pickOpeningLine(s)).toBeTruthy();
    expect(getSession("anthro-open")?.llmCallsUsed).toBe(before);
  });

  it("compressAssistantese drops explanatory tails", () => {
    const out = compressAssistantese([
      "听起来你可能是在用雨伞被开除作为一种比喻，表达自己遭遇了挫折",
    ]);
    expect(out[0].length).toBeLessThan(24);
    expect(out[0]).not.toMatch(/比喻|挫折/);
  });

  it("session rng is deterministic from state", () => {
    const s = createAiSession("anthro-rng", "human", null);
    s.rngState = 12345;
    const a = [nextRng(s), nextRng(s), nextRng(s)];
    s.rngState = 12345;
    const b = [nextRng(s), nextRng(s), nextRng(s)];
    expect(a).toEqual(b);
  });
});
