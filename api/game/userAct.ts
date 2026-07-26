import type { GameSession } from "./store";

/** Legacy single-label act — kept for timing / emotion / canned paths. */
export type UserAct =
  | "greeting"
  | "short_reaction"
  | "normal_question"
  | "personal_question"
  | "knowledge_question"
  | "self_disclosure"
  | "emotional_disclosure"
  | "opinion"
  | "ai_accusation"
  | "provocation"
  | "repeated_question"
  | "topic_shift"
  | "goodbye"
  | "unclear"
  | "odd_probe"
  | "nonsense_bait"
  | "identity_bait"
  | "one_char_ping";

export interface UserActAnalysis {
  primaryAct: UserAct;
  oddness: number;
  ambiguity: number;
  playfulness: number;
  hostility: number;
  identityProbe: number;
  personalIntrusion: number;
  emotionalDisclosure: number;
  confidence: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function scoreIdentity(n: string): number {
  if (
    /(你是|是不是).{0,8}(ai|人工智能|机器人|chatgpt|gpt)/i.test(n) ||
    /^(ai|机器人)\??$/i.test(n) ||
    /证明你(是人|不是ai)/i.test(n)
  ) {
    return 0.95;
  }
  if (/你是人吗|真人吗|机器吗/.test(n)) return 0.8;
  return 0;
}

function scoreOddness(t: string): number {
  if (t.length <= 1) return 0.15;
  let s = 0;
  if (/香蕉|雨伞|开除|开会|外星人|宇宙|穿越|梦里|脑壳/.test(t)) s += 0.45;
  if (/如果.{0,12}(你|我)/.test(t) && !/如果我/.test(t)) s += 0.25;
  if (/[^\u4e00-\u9fff\w\s?？!！,.，。…~～]{2,}/.test(t)) s += 0.2;
  if (t.length >= 4 && !/[?？吗么呢啥谁哪怎]/.test(t) && /了$|啊$|呢$/.test(t)) {
    // Declarative weird statements often read as bait.
    if (/把我|投谁|今天/.test(t)) s += 0.2;
  }
  return clamp01(s);
}

function scorePlayfulness(t: string, oddness: number): number {
  let s = 0;
  if (/哈哈|笑死|hhhh|lol|梗|好玩|离谱|绝了/.test(t)) s += 0.5;
  if (oddness > 0.5 && !/证明|审讯|测试/.test(t)) s += 0.35;
  if (/[哈呵嘿]{2,}/.test(t)) s += 0.2;
  return clamp01(s);
}

function scoreHostility(t: string): number {
  if (/傻|蠢|滚|废物|垃圾|脑残|智障|去死/.test(t)) return 0.9;
  if (/你啥东西|有病|恶心|烦不烦/.test(t)) return 0.7;
  if (/[?？]{3,}/.test(t) && /你/.test(t)) return 0.45;
  return 0;
}

function classifyPrimary(text: string, session: GameSession): UserAct {
  const t = text.trim();
  const n = t.toLowerCase();

  if (scoreIdentity(n) >= 0.8) return "identity_bait";

  if (
    /你多大|几岁|哪里人|哪的|什么学校|住哪|真名|工资|月薪|对象|单身吗/.test(t)
  ) {
    return "personal_question";
  }

  if (/再见|拜拜|不聊了|走了|下了/.test(t)) return "goodbye";

  if (/^(你好|嗨|哈喽|hello|hi|在吗)$/i.test(t)) return "greeting";

  if (/^[哈呵嘿嗯哦啊唉]+$|^[?？]+$|^6{2,}$/.test(t)) return "short_reaction";
  if (/^(1|啊|哦|嗯|？|\?)$/.test(t) || t.length === 1) return "one_char_ping";
  if (t.length <= 2) return "short_reaction";

  if (/你好|嗨|哈喽|在吗|hello|hi\b/i.test(t) && t.length <= 8) {
    return "greeting";
  }

  if (/为什么|怎么理解|解释一下|是什么意思|原理|怎么算/.test(t)) {
    return "knowledge_question";
  }

  if (/我今天|我刚刚|我最近|我觉得|我有点|好累|好烦|开心|难过/.test(t)) {
    if (/累|烦|难过|崩溃|焦虑|寄了|难受/.test(t)) {
      return "emotional_disclosure";
    }
    return "self_disclosure";
  }

  const odd = scoreOddness(t);
  const play = scorePlayfulness(t, odd);
  if (odd >= 0.55 && play >= 0.4) return "nonsense_bait";
  if (odd >= 0.55) return "odd_probe";

  if (/[?？]|吗$|么$|呢$|啥|谁|哪|怎/.test(t)) {
    const recent = session.history
      .filter((h) => h.role === "user")
      .slice(-3)
      .map((h) => h.content);
    const qCount = recent.filter((x) =>
      /[?？]|吗|么|呢|啥|谁|哪|怎/.test(x),
    ).length;
    if (qCount >= 2 && /你|吗|几|哪/.test(t)) return "repeated_question";
    return "normal_question";
  }

  if (/傻|蠢|滚|废物|有病/.test(t)) return "provocation";
  if (/我觉得|我认为|应该|其实/.test(t)) return "opinion";

  return "unclear";
}

/** Multi-dimensional local analysis — no extra LLM call. */
export function analyzeUserInput(
  text: string,
  session: GameSession,
): UserActAnalysis {
  const t = text.trim();
  const n = t.toLowerCase();
  const primaryAct = classifyPrimary(t, session);
  const identityProbe = scoreIdentity(n);
  const oddness = scoreOddness(t);
  const playfulness = scorePlayfulness(t, oddness);
  const hostility = scoreHostility(t);
  const personalIntrusion =
    primaryAct === "personal_question"
      ? 0.75
      : /真名|地址|电话|微信|几岁|工资/.test(t)
        ? 0.85
        : 0;
  const emotionalDisclosure =
    primaryAct === "emotional_disclosure"
      ? 0.85
      : /累|烦|难过|崩溃|焦虑/.test(t)
        ? 0.6
        : 0;
  const ambiguity =
    primaryAct === "unclear" || primaryAct === "odd_probe"
      ? 0.7
      : oddness > 0.5
        ? 0.5
        : 0.15;

  let confidence = 0.75;
  if (primaryAct === "unclear") confidence = 0.35;
  if (identityProbe > 0.8) confidence = 0.95;
  if (primaryAct === "nonsense_bait" || primaryAct === "odd_probe") {
    confidence = 0.55;
  }

  // Map identity_bait → ai_accusation for downstream emotion / canned paths.
  const normalized: UserAct =
    primaryAct === "identity_bait" ? "ai_accusation" : primaryAct;

  return {
    primaryAct: normalized,
    oddness: clamp01(oddness),
    ambiguity: clamp01(ambiguity),
    playfulness: clamp01(playfulness),
    hostility: clamp01(hostility),
    identityProbe: clamp01(identityProbe),
    personalIntrusion: clamp01(personalIntrusion),
    emotionalDisclosure: clamp01(emotionalDisclosure),
    confidence,
  };
}

/** @deprecated Prefer analyzeUserInput — kept for narrow call sites. */
export function classifyUserAct(
  text: string,
  session: GameSession,
): UserAct {
  return analyzeUserInput(text, session).primaryAct;
}
