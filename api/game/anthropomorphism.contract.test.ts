import { describe, expect, it } from "vitest";
import { createAiSession, getSession } from "./store";
import { analyzeUserInput } from "./userAct";
import { reduceInteractionState } from "./interactionState";
import { buildTurnPlan, type TurnPlan } from "./turnPolicy";
import { decideKnowledgeBoundary } from "./knowledgeBoundary";
import { getSocialPersona } from "./socialPersonas";
import { pickOpeningLine } from "./generateTurn";
import { compressAssistantese, runStyleGuard } from "./styleGuard";
import { startClaimedOpening } from "./aiWorker";
import { nextRng } from "./rng";
import { decideReplyToPlayer } from "./replyGate";
import { scheduleProactiveNudge } from "./proactive";

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
    expect(["play_along", "spill", "react_only", "clarify_light", "deflect"]).toContain(
      plan.strategy,
    );
    // With high amusement teasing persona, play_along/spill should be common.
    let playful = 0;
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
      if (p.strategy === "play_along" || p.strategy === "spill") playful += 1;
    }
    expect(playful).toBeGreaterThan(8);
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

  it("ignoreFirstPlayerMsg forces skip on first unanswered line", () => {
    const s = createAiSession("anthro-skip-1", "human", null, "normal", "sane", "cold_low_01");
    s.ignoreFirstPlayerMsg = true;
    s.playerCount = 1;
    s.opponentCount = 0;
    s.transcript.push({
      id: "u1",
      role: "user",
      text: "你好",
      occurredAt: Date.now(),
      state: "visible",
    });
    expect(decideReplyToPlayer(s)).toBe("skip");
  });

  it("neverSpeakFirst blocks first-contact nudge scheduling", () => {
    const s = createAiSession("anthro-nudge", "human", null, "normal", "sane", "high_social_01");
    s.neverSpeakFirst = true;
    s.opponentCount = 0;
    scheduleProactiveNudge(s, { firstContact: true });
    expect(s.nextNudgeAt).toBeNull();
  });

  it("first-contact nudge can schedule even when followUpMax is 0", () => {
    const s = createAiSession(
      "anthro-nudge-floor",
      "human",
      null,
      "normal",
      "sane",
      "cold_low_01",
    );
    expect(getSocialPersona(s.socialPersonaId).tempo.followUpMax).toBe(0);
    s.neverSpeakFirst = false;
    s.opponentCount = 0;
    s.lastPlayerActivityAt = 0;
    scheduleProactiveNudge(s, { firstContact: true });
    expect(s.nextNudgeAt).not.toBeNull();
    expect(s.nextNudgeAt!).toBeGreaterThanOrEqual(Date.now() + 10_000 - 50);
  });

  it("does not first-contact hello after player already spoke", () => {
    const s = createAiSession(
      "anthro-nudge-after",
      "human",
      null,
      "normal",
      "sane",
      "high_social_01",
    );
    s.neverSpeakFirst = false;
    s.opponentCount = 0;
    s.lastPlayerActivityAt = Date.now();
    scheduleProactiveNudge(s, { firstContact: true });
    expect(s.nextNudgeAt).toBeNull();
  });

  it("forces reply after two skipped turns", () => {
    const s = createAiSession("anthro-floor", "human", null, "normal", "sane", "high_social_01");
    s.ignoreFirstPlayerMsg = false;
    s.skippedReplyStreak = 2;
    s.playerCount = 3;
    s.transcript.push({
      id: "u1",
      role: "user",
      text: "在吗",
      occurredAt: Date.now(),
      state: "visible",
    });
    expect(decideReplyToPlayer(s)).toBe("reply");
  });

  it("returns busy when an assistant reply is already pending", () => {
    const s = createAiSession("anthro-busy", "human", null);
    s.playerCount = 1;
    s.transcript.push(
      {
        id: "u1",
        role: "user",
        text: "嗨",
        occurredAt: Date.now(),
        state: "visible",
      },
      {
        id: "a1",
        role: "assistant",
        text: "嘿",
        occurredAt: Date.now() + 1000,
        state: "pending",
      },
    );
    expect(decideReplyToPlayer(s)).toBe("busy");
  });

  it("spill strategy can plan long meme dumps", () => {
    const s = createAiSession(
      "anthro-spill",
      "human",
      null,
      "normal",
      "troll",
      "teasing_friend_01",
    );
    s.memory.interaction.amusement = 0.9;
    const analysis = analyzeUserInput("如果香蕉开会你投谁", s);
    let longOrSpill = 0;
    for (let i = 0; i < 50; i++) {
      const plan = buildTurnPlan({
        session: s,
        userAct: analysis.primaryAct,
        analysis,
        knowledge: decideKnowledgeBoundary(
          getSocialPersona(s.socialPersonaId),
          "如果香蕉开会你投谁",
        ),
      });
      if (plan.strategy === "spill" || plan.targetLength === "long" || plan.maxChars >= 48) {
        longOrSpill += 1;
      }
    }
    expect(longOrSpill).toBeGreaterThan(5);
  });

  it("styleGuard allows long spill text", () => {
    const plan: TurnPlan = {
      strategy: "spill",
      answerMode: "partial",
      stance: "neutral",
      relationshipAction: "tease",
      outputShape: "single",
      targetLength: "long",
      emotionalTone: "playful",
      interpretationMode: "joke",
      allowQuestion: false,
      maxChars: 120,
    };
    const long =
      "啊啊啊啊啊啊我不管了我不管了今天脑子里全是超市门口那只猫在审判我哈哈哈";
    const g = runStyleGuard([long], plan, []);
    expect(g.passed).toBe(true);
    expect(g.parts[0].length).toBeGreaterThan(24);
  });
});
