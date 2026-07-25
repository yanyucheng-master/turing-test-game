import { callLLM } from "./llm";
import { INITIAL_CONFIG } from "./config";
import { classifyUserAct, type UserAct } from "./userAct";
import { decideKnowledgeBoundary } from "./knowledgeBoundary";
import {
  buildTurnPlan,
  describePlanForPrompt,
  type TurnPlan,
} from "./turnPolicy";
import { runStyleGuard } from "./styleGuard";
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

function pickUnused(pool: string[], used: string[]): string {
  const fresh = pool.filter((p) => !used.includes(p.slice(0, 24)));
  const src = fresh.length ? fresh : pool;
  return src[Math.floor(Math.random() * src.length)];
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

  return `你正在参与限时匿名聊天。对方可能以为你是真人或AI。你要像下面这个角色一样即时闲聊，不是助手。

角色：${persona.identity.blurb}
处境：${persona.identity.currentSituation}
语言：偏${persona.speech.averageLength}，口语词可用：${persona.speech.fillerWords.join("、")}
禁止：${persona.speech.avoidedExpressions.join("、") || "客服腔"}

已透露过的自己事实：${facts || "无"}
已知对方信息（意译回忆，勿复读原句）：${userFacts || "无"}
知识处理：${knowledgeNote}
情绪：${session.memory.emotionalState.mood} / intensity ${session.memory.emotionalState.intensity}
环境：${env.join("；") || "正常闲聊"}
元对话（时间将尽/被审讯感）整局最多 ${INITIAL_CONFIG.maxMetaConversationTurns} 次，且仅在环境提示出现时偶尔使用

本轮计划：
${describePlanForPrompt(plan, persona)}

硬规则：
1. 不要像客服/老师/百科
2. 不要完整解释或建议清单
3. 不要列表、标题、总结
4. 可以不回答每个问题
5. 不知道就说不会/猜一下/转移
6. 保持已透露事实一致
7. 不要每轮都反问或共情
8. 不要说自己是AI/模型
9. 最多两条短消息，总长尽量短
10. 不要辱骂人身攻击
11. 标点尽量少；强烈反问或单独「？」才带问号

只返回JSON：
{"replyParts":["第一条","可选第二条"],"memoryPatch":{"newUserFacts":[],"newSelfFacts":{},"emotion":null},"turnAction":""}`;
}

function parseModelJson(raw: string): {
  replyParts: string[];
  memoryPatch?: {
    newUserFacts?: Array<{ key?: string; value: string } | string>;
    newSelfFacts?: Record<string, string>;
  };
} | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      replyParts?: unknown;
      memoryPatch?: {
        newUserFacts?: Array<{ key?: string; value: string } | string>;
        newSelfFacts?: Record<string, string>;
      };
    };
    const parts = Array.isArray(obj.replyParts)
      ? obj.replyParts.filter((x): x is string => typeof x === "string")
      : [];
    if (!parts.length) return null;
    return { replyParts: parts, memoryPatch: obj.memoryPatch };
  } catch {
    return null;
  }
}

function applyMemoryPatch(
  session: GameSession,
  patch:
    | {
        newUserFacts?: Array<{ key?: string; value: string } | string>;
        newSelfFacts?: Record<string, string>;
      }
    | undefined,
) {
  if (!patch) return;
  if (patch.newSelfFacts) {
    Object.assign(session.memory.selfFacts, patch.newSelfFacts);
  }
  if (patch.newUserFacts?.length) {
    for (const f of patch.newUserFacts) {
      const value = typeof f === "string" ? f : f.value;
      if (!value?.trim()) continue;
      const key =
        typeof f === "string"
          ? `fact_${session.memory.userFacts.length}`
          : (f.key ?? `fact_${session.memory.userFacts.length}`);
      session.memory.userFacts.push({
        key,
        value: value.trim().slice(0, 40),
        confidence: 0.7,
        turn: session.playerCount,
      });
    }
    if (session.memory.userFacts.length > 8) {
      session.memory.userFacts = session.memory.userFacts.slice(-8);
    }
  }
}

function cannedPath(
  session: GameSession,
  userAct: UserAct,
  plan: TurnPlan,
  persona: SocialPersona,
): string[] | null {
  if (userAct === "ai_accusation") {
    if (Math.random() < INITIAL_CONFIG.cannedAccusationReplyRate) {
      return [pickUnused(ACCUSATION_SOFT, session.memory.usedReplyIds)];
    }
    return null;
  }
  if (userAct === "short_reaction") {
    if (Math.random() < INITIAL_CONFIG.cannedShortReplyRate) {
      return [pickUnused(SHORT_POOL, session.memory.usedReplyIds)];
    }
  }
  // Rare chaos tease
  if (
    persona.chaos !== "sane" &&
    session.memory.strongChaosTurns < INITIAL_CONFIG.maxStrongChaosTurns &&
    Math.random() < 0.12
  ) {
    session.memory.strongChaosTurns += 1;
    return [pickUnused(["啊？", "你猜", "得了吧", "嗯嗯"], session.memory.usedReplyIds)];
  }
  void plan;
  return null;
}

export async function generateOpponentTurn(
  session: GameSession,
  playerText: string,
): Promise<GeneratedTurn> {
  const persona = getSocialPersona(session.socialPersonaId);
  harvestUserFacts(session, playerText);
  const userAct = classifyUserAct(playerText, session);
  updateEmotionForAct(session, userAct);
  if (userAct === "ai_accusation") {
    session.memory.accusationCount += 1;
  }
  const knowledge = decideKnowledgeBoundary(persona, playerText);
  const plan = buildTurnPlan({ session, userAct, knowledge });

  let parts = cannedPath(session, userAct, plan, persona);

  if (!parts) {
    const knowledgeNote = `${knowledge.topic}/${knowledge.level} → ${knowledge.behavior}`;
    const system = buildSystemPrompt(persona, plan, session, knowledgeNote);
    const history = session.history.slice(-20);
    let raw =
      (await callLLM(system, history, {
        maxTokens: 80,
        temperature: 1.0,
      })) ?? "";

    let parsed = parseModelJson(raw);
    if (!parsed) {
      // plain text fallback
      const scrubbed = scrubReply(raw);
      parts = scrubbed ? [scrubbed] : null;
    } else {
      parts = parsed.replyParts;
      applyMemoryPatch(session, parsed.memoryPatch);
    }

    let guard = runStyleGuard(parts ?? [], plan, session.memory.usedReplyIds);
    if ((!guard.passed || guard.severity === "high") && INITIAL_CONFIG.maxRewriteAttempts > 0) {
      raw =
        (await callLLM(
          system + "\n\n上次输出不合格，请更短、更口语、不要助手腔，只回JSON。",
          history,
          { maxTokens: 60, temperature: 0.95 },
        )) ?? "";
      parsed = parseModelJson(raw);
      parts = parsed?.replyParts ?? (scrubReply(raw) ? [scrubReply(raw)] : []);
      if (parsed) applyMemoryPatch(session, parsed.memoryPatch);
      guard = runStyleGuard(parts, plan, session.memory.usedReplyIds);
    }
    parts = guard.parts.length
      ? guard.parts
      : [scrubReply(fallbackReply("human")) || "嗯"];
  } else {
    parts = runStyleGuard(parts, plan, session.memory.usedReplyIds).parts;
  }

  if (!parts.length) parts = ["嗯"];

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
  });
  const deliveries = scheduleDeliveries(parts, baseDelay);

  return { replyParts: parts, deliveries, plan, userAct };
}
