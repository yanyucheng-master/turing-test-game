import { callLLM } from "./llm";
import { INITIAL_CONFIG } from "./config";
import { analyzeUserInput, type UserAct } from "./userAct";
import { decideKnowledgeBoundary } from "./knowledgeBoundary";
import {
  buildTurnPlan,
  describePlanForPrompt,
  type TurnPlan,
} from "./turnPolicy";
import {
  compressAssistantese,
  runRawSafetyGuard,
  runStyleGuard,
} from "./styleGuard";
import { calculateReplyDelay, scheduleDeliveries } from "./timing";
import { getSocialPersona, type SocialPersona } from "./socialPersonas";
import { scrubReply, fallbackReply } from "./personas";
import type { GameSession } from "./store";
import { updateEmotionForAct } from "./emotion";
import { harvestUserFacts } from "./memory";
import {
  describeEnvironment,
  markMetaUsed,
} from "./environmentAwareness";
import { reduceInteractionState } from "./interactionState";
import { nextRng, pickOne } from "./rng";

export interface GeneratedTurn {
  replyParts: string[];
  deliveries: Array<{ text: string; delayMs: number }>;
  plan: TurnPlan;
  userAct: UserAct;
}

const SHORT_POOL = ["嗯", "啊？", "真的假的", "行吧", "笑死", "哦", "？"];
const ACCUSATION_SOFT = [
  "你怎么判断的",
  "你才像吧",
  "又来了",
  "啊？",
  "那你觉得呢",
  "想啥呢",
  "笑死",
];
const PLAY_ALONG_POOL = [
  "它工资给你结了吗",
  "那挺狠的",
  "哈哈行",
  "离谱",
  "然后呢",
  "我投香蕉",
  "笑死",
];
const CLARIFY_POOL = ["啊？", "你在说啥", "啥意思", "？"];

function pickUnused(
  session: GameSession,
  pool: string[],
): string {
  const used = session.memory.usedReplyIds;
  const fresh = pool.filter((p) => !used.includes(p.slice(0, 24)));
  const src = fresh.length ? fresh : pool;
  return pickOne(session, src);
}

function buildSystemPrompt(
  persona: SocialPersona,
  plan: TurnPlan,
  session: GameSession,
  knowledgeNote: string,
): string {
  const facts = Object.entries(session.memory.selfFacts)
    .map(([k, v]) => `${k}:${v}`)
    .join("；");
  const userFacts = session.memory.userFacts
    .slice(-5)
    .map((f) => f.value)
    .join("；");
  const env = describeEnvironment(session);
  const st = session.memory.interaction;

  return `你正在参与限时匿名聊天。对方可能以为你是真人或AI。你要像下面这个角色一样即时闲聊，不是助手。

角色：${persona.identity.blurb}
处境：${persona.identity.currentSituation}
语言：偏${persona.speech.averageLength}，口语词可用：${persona.speech.fillerWords.join("、")}
禁止：${persona.speech.avoidedExpressions.join("、") || "客服腔"}

已透露过的自己事实：${facts || "无"}
已知对方信息（意译回忆，勿复读原句）：${userFacts || "无"}
知识处理：${knowledgeNote}
情绪：${session.memory.emotionalState.mood} / intensity ${session.memory.emotionalState.intensity}
心态：耐心${st.patience.toFixed(2)} 防备${st.guardedness.toFixed(2)} 兴致${st.amusement.toFixed(2)} 投入${st.engagement.toFixed(2)}
环境：${env.join("；") || "正常闲聊"}
元对话（时间将尽/被审讯感）整局最多 ${INITIAL_CONFIG.maxMetaConversationTurns} 次，且仅在环境提示出现时偶尔使用

本轮计划（必须遵守，不要自行改策略）：
${describePlanForPrompt(plan, persona)}

硬规则：
1. 不要像客服/老师/百科；不要解释对方为什么这么说
2. 不要完整解释、建议清单、列表、标题、总结
3. 先回应社交作用（接梗/敷衍/短反应），再决定是否碰字面
4. 不知道就说不会/猜一下/转移
5. 保持已透露事实一致；不要编造新的身份事实
6. 不要每轮都反问或共情
7. 不要说自己是AI/模型；不要长篇证明自己是人
8. 最多两条短消息；合计尽量不超过${plan.maxChars}字
9. 标点尽量少；强烈反问或单独「？」才带问号
10. 策略是 play_along 时必须接梗，禁止科普式解读

只返回JSON：
{"replyParts":["第一条","可选第二条"]}`;
}

function parseModelJson(raw: string): { replyParts: string[] } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      replyParts?: unknown;
    };
    const parts = Array.isArray(obj.replyParts)
      ? obj.replyParts.filter((x): x is string => typeof x === "string")
      : [];
    if (!parts.length) return null;
    return { replyParts: parts };
  } catch {
    return null;
  }
}

export function safePersonaFallback(
  session: GameSession,
  act: UserAct,
  plan?: TurnPlan,
): string {
  if (plan?.strategy === "play_along") {
    return pickUnused(session, PLAY_ALONG_POOL);
  }
  if (plan?.strategy === "clarify_light") {
    return pickUnused(session, CLARIFY_POOL);
  }
  if (act === "ai_accusation") {
    return pickUnused(session, ACCUSATION_SOFT);
  }
  if (act === "knowledge_question") return "这我不太懂";
  if (act === "personal_question") {
    const persona = getSocialPersona(session.socialPersonaId);
    return persona.boundaries.privateQuestion === "answer"
      ? "还好吧"
      : "不太方便说";
  }
  if (act === "greeting" || act === "one_char_ping") {
    return pickUnused(session, ["嗨", "哈喽", "嘿", "在"]);
  }
  return pickUnused(session, SHORT_POOL);
}

function cannedPath(
  session: GameSession,
  userAct: UserAct,
  plan: TurnPlan,
  persona: SocialPersona,
): string[] | null {
  if (plan.strategy === "react_only" && nextRng(session) < 0.55) {
    return [pickUnused(session, SHORT_POOL)];
  }
  if (plan.strategy === "play_along" && nextRng(session) < 0.35) {
    return [pickUnused(session, PLAY_ALONG_POOL)];
  }
  if (plan.strategy === "clarify_light" && nextRng(session) < 0.4) {
    return [pickUnused(session, CLARIFY_POOL)];
  }
  if (userAct === "ai_accusation") {
    if (nextRng(session) < INITIAL_CONFIG.cannedAccusationReplyRate) {
      return [pickUnused(session, ACCUSATION_SOFT)];
    }
    return null;
  }
  if (userAct === "short_reaction" || userAct === "one_char_ping") {
    if (nextRng(session) < INITIAL_CONFIG.cannedShortReplyRate) {
      return [pickUnused(session, SHORT_POOL)];
    }
  }
  if (
    persona.chaos !== "sane" &&
    session.memory.strongChaosTurns < INITIAL_CONFIG.maxStrongChaosTurns &&
    nextRng(session) < 0.12
  ) {
    session.memory.strongChaosTurns += 1;
    return [pickUnused(session, ["啊？", "你猜", "得了吧", "嗯嗯"])];
  }
  return null;
}

export async function generateOpponentTurn(
  session: GameSession,
  playerText: string,
  opts?: { signal?: AbortSignal },
): Promise<GeneratedTurn> {
  const persona = getSocialPersona(session.socialPersonaId);
  harvestUserFacts(session, playerText);
  const analysis = analyzeUserInput(playerText, session);
  const userAct = analysis.primaryAct;
  session.memory.interaction = reduceInteractionState(
    session.memory.interaction,
    analysis,
    persona,
  );
  updateEmotionForAct(session, userAct);
  if (userAct === "ai_accusation") {
    session.memory.accusationCount += 1;
  }
  const knowledge = decideKnowledgeBoundary(persona, playerText);
  const plan = buildTurnPlan({ session, userAct, analysis, knowledge });

  let parts = cannedPath(session, userAct, plan, persona);
  const nearDeadline = Date.now() > session.chatDeadlineAt - 8_000;

  if (!parts) {
    const knowledgeNote = `${knowledge.topic}/${knowledge.level} → ${knowledge.behavior}`;
    const system = buildSystemPrompt(persona, plan, session, knowledgeNote);
    const history = session.history.slice(-20);
    session.llmCallsUsed += 1;
    const raw =
      (await callLLM(system, history, {
        maxTokens: 80,
        temperature: 1.0,
        timeoutMs: 5_000,
        signal: opts?.signal,
      })) ?? "";

    const parsed = parseModelJson(raw);
    if (!parsed) {
      const rawGuard = runRawSafetyGuard(raw);
      if (!rawGuard.passed) {
        parts = null;
      } else {
        const scrubbed = scrubReply(raw);
        parts = scrubbed ? compressAssistantese([scrubbed]) : null;
      }
    } else {
      parts = compressAssistantese(parsed.replyParts);
    }

    let guard = runStyleGuard(parts ?? [], plan, session.memory.usedReplyIds);

    // Prefer local compression / fallback over a second LLM call.
    if (!guard.passed || guard.severity === "high" || !guard.parts.length) {
      if (
        guard.severity !== "high" &&
        parts?.length &&
        !nearDeadline
      ) {
        const compressed = compressAssistantese(parts);
        guard = runStyleGuard(compressed, plan, session.memory.usedReplyIds);
        if (guard.passed && guard.parts.length) {
          parts = guard.parts;
        } else {
          parts = [safePersonaFallback(session, userAct, plan)];
        }
      } else {
        parts = [safePersonaFallback(session, userAct, plan)];
      }
    } else {
      parts = guard.parts;
    }

    // Only rewrite via LLM when far from deadline and still assistant-ese medium.
    if (
      parts &&
      INITIAL_CONFIG.maxRewriteAttempts > 0 &&
      !nearDeadline &&
      !opts?.signal?.aborted &&
      guard.severity === "medium" &&
      guard.reasons.some((r) => r === "length_mismatch" || r === "total_too_long")
    ) {
      // Already locally truncated by styleGuard — skip second LLM.
    }
  } else {
    const guard = runStyleGuard(parts, plan, session.memory.usedReplyIds);
    parts =
      !guard.passed || guard.severity === "high" || !guard.parts.length
        ? [safePersonaFallback(session, userAct, plan)]
        : guard.parts;
  }

  if (!parts.length) {
    parts = [scrubReply(fallbackReply("human")) || "嗯"];
  }

  for (const p of parts) {
    const id = p.slice(0, 24);
    if (!session.memory.usedReplyIds.includes(id)) {
      session.memory.usedReplyIds.push(id);
    }
  }
  if (session.memory.usedReplyIds.length > 40) {
    session.memory.usedReplyIds = session.memory.usedReplyIds.slice(-40);
  }

  session.memory.recentTurnActions.push(plan.relationshipAction);
  if (session.memory.recentTurnActions.length > 8) {
    session.memory.recentTurnActions =
      session.memory.recentTurnActions.slice(-8);
  }

  markMetaUsed(session, parts);

  const joined = parts.join("");
  const baseDelay = calculateReplyDelay({
    text: joined,
    persona,
    act: userAct,
    plan,
    analysis,
    session,
  });
  const deliveries = scheduleDeliveries(parts, baseDelay, session);

  return { replyParts: parts, deliveries, plan, userAct };
}

/** Local persona openers — no LLM (saves budget and latency). */
export function pickOpeningLine(session: GameSession): string {
  const persona = getSocialPersona(session.socialPersonaId);
  const st = session.memory.interaction;
  const hour = new Date().getHours();
  const night = hour >= 22 || hour < 6;

  const base = ["嗨", "在", "哈喽", "嘿"];
  const contextual: Record<string, string[]> = {
    campus_night: ["还没睡啊", "哈喽", "在吗"],
    slow_observer: ["嗯你好", "嗨", "在"],
    tired_worker: ["在", "刚下班", "嗯"],
    commute_fragment: ["在", "嗨"],
    teasing_friend: ["哈喽", "嘿", "来了"],
    cautious_guard: ["你好", "嗨"],
    high_social: ["哈喽", "终于匹配上了", "嗨嗨"],
    cold_low_interest: ["在", "嗯"],
    creative_procrastinator: ["嗨", "摸鱼吗", "哈喽"],
    night_shift: ["在", "还醒着", "嗨"],
  };
  const lowEnergy = ["嗯", "在", "哦"];

  let pool = [
    ...base,
    ...(contextual[persona.cluster] ?? []),
  ];
  if (night && (persona.cluster === "campus_night" || persona.cluster === "night_shift")) {
    pool = [...pool, "还没睡啊", "还醒着"];
  }
  if (st.engagement < 0.35 || st.patience < 0.35) {
    pool = [...lowEnergy, ...pool.slice(0, 2)];
  }
  return pickOne(session, pool);
}

/** @deprecated Opening no longer calls the model. */
export async function generateOpeningTurn(
  session: GameSession,
  _opts?: { signal?: AbortSignal },
): Promise<string> {
  return pickOpeningLine(session);
}
