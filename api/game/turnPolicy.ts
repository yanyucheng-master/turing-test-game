import type { GameSession } from "./store";
import type { UserAct } from "./userAct";
import type { KnowledgeDecision } from "./knowledgeBoundary";
import type { SocialPersona } from "./socialPersonas";
import { getSocialPersona } from "./socialPersonas";

export interface TurnPlan {
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
}

function roll<T>(items: Array<{ w: number; v: T }>): T {
  const sum = items.reduce((a, b) => a + b.w, 0);
  let r = Math.random() * sum;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

export function buildTurnPlan(input: {
  session: GameSession;
  userAct: UserAct;
  knowledge: KnowledgeDecision;
}): TurnPlan {
  const persona = getSocialPersona(input.session.socialPersonaId);
  const { userAct, knowledge, session } = input;
  const mood = session.memory.emotionalState.mood;

  let answerMode: TurnPlan["answerMode"] = "direct";
  let relationshipAction: TurnPlan["relationshipAction"] = "none";
  let emotionalTone: TurnPlan["emotionalTone"] =
    mood === "neutral" ? "neutral" : (mood as TurnPlan["emotionalTone"]);
  let targetLength: TurnPlan["targetLength"] = persona.speech.averageLength;

  if (userAct === "ai_accusation") {
    emotionalTone =
      session.memory.accusationCount >= 2
        ? "annoyed"
        : session.memory.accusationCount >= 1
          ? "defensive"
          : "playful";
    const b = persona.boundaries.aiAccusation;
    if (b === "ignore") {
      answerMode = "ignore";
      relationshipAction = "topic_shift";
    } else if (b === "mock") {
      answerMode = "deflect";
      relationshipAction = "tease";
    } else if (b === "counter") {
      answerMode = "partial";
      relationshipAction = "ask_back";
    } else if (b === "annoyed") {
      answerMode = "deflect";
      relationshipAction = "set_boundary";
      emotionalTone = "annoyed";
    } else {
      answerMode = "partial";
      relationshipAction = "ask_back";
    }
    targetLength = "tiny";
  } else if (userAct === "personal_question" || userAct === "repeated_question") {
    const b =
      userAct === "repeated_question"
        ? "deflect"
        : persona.boundaries.privateQuestion;
    if (b === "answer") answerMode = "direct";
    else if (b === "partial") answerMode = "partial";
    else if (b === "counter") {
      answerMode = "partial";
      relationshipAction = "ask_back";
    } else if (b === "ignore") {
      answerMode = "ignore";
      relationshipAction = "topic_shift";
    } else {
      answerMode = "deflect";
      relationshipAction = Math.random() < 0.5 ? "ask_back" : "set_boundary";
    }
    if (userAct === "repeated_question") {
      emotionalTone = "defensive";
      relationshipAction =
        Math.random() < 0.6 ? "set_boundary" : relationshipAction;
    }
    targetLength = "short";
  } else if (userAct === "knowledge_question") {
    if (knowledge.behavior === "answer") answerMode = "direct";
    else if (knowledge.behavior === "partial_answer") answerMode = "partial";
    else if (knowledge.behavior === "subjective_guess") answerMode = "guess";
    else if (knowledge.behavior === "admit_unknown") answerMode = "partial";
    else if (knowledge.behavior === "ask_back") {
      answerMode = "deflect";
      relationshipAction = "ask_back";
    } else {
      answerMode = "deflect";
      relationshipAction = "topic_shift";
    }
    targetLength = knowledge.level === "strong" ? "short" : "tiny";
  } else if (userAct === "short_reaction" || userAct === "greeting") {
    answerMode = roll([
      { w: 40, v: "direct" as const },
      { w: 30, v: "partial" as const },
      { w: 20, v: "deflect" as const },
      { w: 10, v: "ignore" as const },
    ]);
    targetLength = "tiny";
    if (Math.random() < persona.speech.questionRate) {
      relationshipAction = "ask_back";
    }
  } else if (
    userAct === "self_disclosure" ||
    userAct === "emotional_disclosure"
  ) {
    answerMode = "partial";
    emotionalTone = userAct === "emotional_disclosure" ? "friendly" : "friendly";
    relationshipAction = roll([
      { w: 40, v: "ask_back" as const },
      { w: 30, v: "self_disclose" as const },
      { w: 20, v: "none" as const },
      { w: 10, v: "tease" as const },
    ]);
    if (persona.social.warmth < 0.35) relationshipAction = "none";
  } else {
    // normal / unclear / opinion
    answerMode = roll([
      { w: 55, v: "direct" as const },
      { w: 25, v: "partial" as const },
      { w: 15, v: "deflect" as const },
      { w: 5, v: "ignore" as const },
    ]);
    if (Math.random() < persona.speech.questionRate * 0.8) {
      relationshipAction = "ask_back";
    } else if (
      Math.random() < persona.social.selfDisclosure * 0.3 &&
      session.memory.userFacts.length > 0
    ) {
      relationshipAction = "memory_recall";
    }
  }

  // Bored / annoyed compresses
  if (mood === "bored" || mood === "annoyed") {
    targetLength = "tiny";
    if (Math.random() < 0.4) {
      answerMode = "ignore";
      relationshipAction = "none";
    }
  }

  // Length from persona
  if (persona.speech.averageLength === "tiny" && targetLength === "medium") {
    targetLength = "short";
  }

  const outputShape: TurnPlan["outputShape"] =
    Math.random() < 0.18 && targetLength !== "tiny"
      ? "double_message"
      : "single";

  // Avoid consecutive ask_back spam
  const last = session.memory.recentTurnActions.slice(-2);
  if (
    relationshipAction === "ask_back" &&
    last.filter((a) => a === "ask_back").length >= 2
  ) {
    relationshipAction = "none";
  }

  return {
    answerMode,
    stance: "neutral",
    relationshipAction,
    outputShape,
    targetLength,
    emotionalTone,
  };
}

export function describePlanForPrompt(plan: TurnPlan, persona: SocialPersona): string {
  return [
    `回答方式：${plan.answerMode}`,
    `关系行为：${plan.relationshipAction}`,
    `情绪语气：${plan.emotionalTone}`,
    `输出长度：${plan.targetLength}`,
    `输出形态：${plan.outputShape}`,
    `人设主动性：${persona.social.initiative.toFixed(2)}`,
  ].join("\n");
}
