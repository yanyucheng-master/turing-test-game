import type { GameSession } from "./store";
import type { UserAct, UserActAnalysis } from "./userAct";
import type { KnowledgeDecision } from "./knowledgeBoundary";
import type { SocialPersona } from "./socialPersonas";
import { getSocialPersona } from "./socialPersonas";
import { nextRng, pickWeighted } from "./rng";

export type ReplyStrategy =
  | "direct"
  | "partial"
  | "react_only"
  | "play_along"
  | "clarify_light"
  | "counter_probe"
  | "deflect"
  | "set_boundary"
  | "topic_shift";

export interface TurnPlan {
  strategy: ReplyStrategy;
  answerMode: "ignore" | "partial" | "direct" | "guess" | "deflect";
  stance: "agree" | "neutral" | "mild_disagree";
  relationshipAction:
    | "none"
    | "ask_back"
    | "self_disclose"
    | "tease"
    | "memory_recall"
    | "set_boundary"
    | "topic_shift";
  outputShape: "single" | "double_message";
  targetLength: "tiny" | "short" | "medium";
  emotionalTone:
    | "neutral"
    | "friendly"
    | "playful"
    | "awkward"
    | "defensive"
    | "annoyed"
    | "bored";
  interpretationMode: "literal" | "joke" | "metaphor" | "uncertain";
  allowQuestion: boolean;
  maxChars: number;
}

function strategyToAnswerMode(s: ReplyStrategy): TurnPlan["answerMode"] {
  if (s === "direct") return "direct";
  if (s === "partial" || s === "clarify_light") return "partial";
  if (s === "react_only" || s === "play_along") return "partial";
  if (s === "topic_shift" || s === "set_boundary") return "deflect";
  if (s === "counter_probe") return "partial";
  return "deflect";
}

function pickOddStrategy(
  session: GameSession,
  persona: SocialPersona,
  analysis: UserActAnalysis,
): ReplyStrategy {
  const st = session.memory.interaction;
  const playful =
    persona.chaos !== "sane" ||
    persona.social.teasing > 0.45 ||
    st.amusement > 0.55;

  let weights: Array<{ w: number; v: ReplyStrategy }>;
  if (st.patience < 0.28 || st.engagement < 0.25) {
    weights = [
      { w: 45, v: "react_only" },
      { w: 30, v: "deflect" },
      { w: 20, v: "clarify_light" },
      { w: 5, v: "play_along" },
    ];
  } else if (persona.cluster === "cautious_guard" || st.guardedness > 0.6) {
    weights = [
      { w: 45, v: "clarify_light" },
      { w: 25, v: "react_only" },
      { w: 20, v: "deflect" },
      { w: 10, v: "play_along" },
    ];
  } else if (playful) {
    weights = [
      { w: 45, v: "play_along" },
      { w: 25, v: "react_only" },
      { w: 20, v: "clarify_light" },
      { w: 10, v: "deflect" },
    ];
  } else {
    weights = [
      { w: 30, v: "react_only" },
      { w: 30, v: "clarify_light" },
      { w: 25, v: "deflect" },
      { w: 15, v: "play_along" },
    ];
  }

  // Low playfulness odd statements → less play_along.
  if (analysis.playfulness < 0.35) {
    weights = weights.map((x) =>
      x.v === "play_along" ? { ...x, w: Math.max(2, x.w * 0.35) } : x,
    );
  }

  return pickWeighted(session, weights);
}

function pickIdentityStrategy(
  session: GameSession,
  persona: SocialPersona,
): ReplyStrategy {
  const st = session.memory.interaction;
  const b = persona.boundaries.aiAccusation;
  if (st.identityProbeStreak >= 3 || st.patience < 0.25) {
    return pickWeighted(session, [
      { w: 40, v: "set_boundary" },
      { w: 35, v: "react_only" },
      { w: 25, v: "topic_shift" },
    ]);
  }
  if (b === "ignore") return "topic_shift";
  if (b === "mock") {
    return pickWeighted(session, [
      { w: 40, v: "play_along" },
      { w: 30, v: "react_only" },
      { w: 30, v: "counter_probe" },
    ]);
  }
  if (b === "counter") return "counter_probe";
  if (b === "annoyed") return "set_boundary";
  return pickWeighted(session, [
    { w: 35, v: "react_only" },
    { w: 35, v: "deflect" },
    { w: 30, v: "counter_probe" },
  ]);
}

export function buildTurnPlan(input: {
  session: GameSession;
  userAct: UserAct;
  analysis: UserActAnalysis;
  knowledge: KnowledgeDecision;
}): TurnPlan {
  const persona = getSocialPersona(input.session.socialPersonaId);
  const { userAct, knowledge, session, analysis } = input;
  const mood = session.memory.emotionalState.mood;
  const st = session.memory.interaction;

  let strategy: ReplyStrategy = "direct";
  let relationshipAction: TurnPlan["relationshipAction"] = "none";
  let emotionalTone: TurnPlan["emotionalTone"] =
    mood === "neutral" ? "neutral" : (mood as TurnPlan["emotionalTone"]);
  let targetLength: TurnPlan["targetLength"] = persona.speech.averageLength;
  let interpretationMode: TurnPlan["interpretationMode"] = "literal";
  let allowQuestion = nextRng(session) < persona.speech.questionRate;

  if (userAct === "ai_accusation") {
    strategy = pickIdentityStrategy(session, persona);
    emotionalTone =
      st.identityProbeStreak >= 2
        ? "annoyed"
        : st.identityProbeStreak >= 1
          ? "defensive"
          : "playful";
    targetLength = "tiny";
    allowQuestion = strategy === "counter_probe";
    if (strategy === "set_boundary") relationshipAction = "set_boundary";
    else if (strategy === "counter_probe") relationshipAction = "ask_back";
    else if (strategy === "topic_shift") relationshipAction = "topic_shift";
    else if (strategy === "play_along") relationshipAction = "tease";
  } else if (
    userAct === "nonsense_bait" ||
    userAct === "odd_probe" ||
    (analysis.oddness > 0.55 && analysis.confidence < 0.7)
  ) {
    strategy = pickOddStrategy(session, persona, analysis);
    interpretationMode =
      strategy === "play_along"
        ? analysis.playfulness > 0.5
          ? "joke"
          : "metaphor"
        : strategy === "clarify_light"
          ? "uncertain"
          : "uncertain";
    emotionalTone =
      strategy === "play_along"
        ? "playful"
        : st.patience < 0.3
          ? "bored"
          : "awkward";
    targetLength = "tiny";
    allowQuestion = strategy === "clarify_light" && nextRng(session) < 0.5;
    if (strategy === "deflect") relationshipAction = "topic_shift";
    if (strategy === "play_along") relationshipAction = "tease";
  } else if (userAct === "personal_question" || userAct === "repeated_question") {
    const b =
      userAct === "repeated_question"
        ? "deflect"
        : persona.boundaries.privateQuestion;
    if (b === "answer") strategy = "direct";
    else if (b === "partial") strategy = "partial";
    else if (b === "counter") {
      strategy = "counter_probe";
      relationshipAction = "ask_back";
    } else if (b === "ignore") {
      strategy = "topic_shift";
      relationshipAction = "topic_shift";
    } else {
      strategy = "deflect";
      relationshipAction =
        nextRng(session) < 0.5 ? "ask_back" : "set_boundary";
    }
    if (userAct === "repeated_question" || st.interrogationStreak >= 3) {
      emotionalTone = "defensive";
      if (nextRng(session) < 0.6) {
        strategy = "set_boundary";
        relationshipAction = "set_boundary";
      }
    }
    targetLength = "short";
  } else if (userAct === "knowledge_question") {
    if (knowledge.behavior === "answer") strategy = "direct";
    else if (knowledge.behavior === "partial_answer") strategy = "partial";
    else if (knowledge.behavior === "subjective_guess") strategy = "partial";
    else if (knowledge.behavior === "admit_unknown") strategy = "react_only";
    else if (knowledge.behavior === "ask_back") {
      strategy = "counter_probe";
      relationshipAction = "ask_back";
    } else {
      strategy = "topic_shift";
      relationshipAction = "topic_shift";
    }
    targetLength = knowledge.level === "strong" ? "short" : "tiny";
  } else if (
    userAct === "short_reaction" ||
    userAct === "greeting" ||
    userAct === "one_char_ping"
  ) {
    strategy = pickWeighted(session, [
      { w: 50, v: "react_only" },
      { w: 30, v: "direct" },
      { w: 15, v: "deflect" },
      { w: 5, v: "partial" },
    ]);
    targetLength = "tiny";
    if (allowQuestion) relationshipAction = "ask_back";
  } else if (
    userAct === "self_disclosure" ||
    userAct === "emotional_disclosure"
  ) {
    strategy = "partial";
    emotionalTone = "friendly";
    relationshipAction = pickWeighted(session, [
      { w: 40, v: "ask_back" },
      { w: 30, v: "self_disclose" },
      { w: 20, v: "none" },
      { w: 10, v: "tease" },
    ]);
    if (persona.social.warmth < 0.35) relationshipAction = "none";
  } else {
    strategy = pickWeighted(session, [
      { w: 55, v: "direct" },
      { w: 25, v: "partial" },
      { w: 15, v: "deflect" },
      { w: 5, v: "react_only" },
    ]);
    if (allowQuestion) relationshipAction = "ask_back";
    else if (
      nextRng(session) < persona.social.selfDisclosure * 0.3 &&
      session.memory.userFacts.length > 0
    ) {
      relationshipAction = "memory_recall";
    }
  }

  if (mood === "bored" || mood === "annoyed" || st.engagement < 0.22) {
    targetLength = "tiny";
    if (nextRng(session) < 0.45) {
      strategy = "react_only";
      relationshipAction = "none";
      allowQuestion = false;
    }
  }

  if (persona.speech.averageLength === "tiny" && targetLength === "medium") {
    targetLength = "short";
  }

  const outputShape: TurnPlan["outputShape"] =
    nextRng(session) < 0.18 &&
    targetLength !== "tiny" &&
    strategy !== "react_only"
      ? "double_message"
      : "single";

  const last = session.memory.recentTurnActions.slice(-2);
  if (
    relationshipAction === "ask_back" &&
    last.filter((a) => a === "ask_back").length >= 2
  ) {
    relationshipAction = "none";
    allowQuestion = false;
  }

  const maxChars =
    targetLength === "tiny" ? 12 : targetLength === "short" ? 22 : 36;

  return {
    strategy,
    answerMode: strategyToAnswerMode(strategy),
    stance: "neutral",
    relationshipAction,
    outputShape,
    targetLength,
    emotionalTone,
    interpretationMode,
    allowQuestion,
    maxChars,
  };
}

export function describePlanForPrompt(
  plan: TurnPlan,
  persona: SocialPersona,
): string {
  const strategyHint: Record<ReplyStrategy, string> = {
    direct: "直接短答",
    partial: "只答一部分",
    react_only: "只给短反应，不解释",
    play_along: "接梗/顺着荒诞往下玩，不要解释含义",
    clarify_light: "轻轻问一句你在说啥，别审讯",
    counter_probe: "短反问，别辩论",
    deflect: "敷衍或岔开",
    set_boundary: "表明不想继续这个话题",
    topic_shift: "换话题",
  };
  return [
    `策略：${plan.strategy}（${strategyHint[plan.strategy]}）`,
    `解读方式：${plan.interpretationMode}`,
    `关系行为：${plan.relationshipAction}`,
    `情绪语气：${plan.emotionalTone}`,
    `输出长度：${plan.targetLength}（合计尽量≤${plan.maxChars}字）`,
    `输出形态：${plan.outputShape}`,
    `允许反问：${plan.allowQuestion ? "偶尔一句" : "不要反问"}`,
    `人设主动性：${persona.social.initiative.toFixed(2)}`,
  ].join("\n");
}
