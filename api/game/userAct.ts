import type { GameSession } from "./store";

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
  | "unclear";

export function classifyUserAct(
  text: string,
  session: GameSession,
): UserAct {
  const t = text.trim();
  const n = t.toLowerCase();

  if (
    /(你是|是不是).{0,8}(ai|人工智能|机器人|chatgpt|gpt)/i.test(n) ||
    /^(ai|机器人)\??$/i.test(n)
  ) {
    return "ai_accusation";
  }

  if (
    /你多大|几岁|哪里人|哪的|什么学校|住哪|真名|工资|月薪|对象|单身吗/.test(t)
  ) {
    return "personal_question";
  }

  if (/再见|拜拜|不聊了|走了|下了/.test(t)) {
    return "goodbye";
  }

  // Greetings before short_reaction — otherwise「你好」「嗨」are misclassified.
  if (/^(你好|嗨|哈喽|hello|hi|在吗)$/i.test(t)) {
    return "greeting";
  }

  if (/^[哈呵嘿嗯哦啊唉]+$|^[?？]+$|^[0-9]+$|^6{2,}$|^1$/.test(t) || t.length <= 2) {
    return "short_reaction";
  }

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

  if (/[?？]|吗$|么$|呢$|啥|谁|哪|怎/.test(t)) {
    // Repeated interrogation style
    const recent = session.history
      .filter((h) => h.role === "user")
      .slice(-3)
      .map((h) => h.content);
    const qCount = recent.filter((x) => /[?？]|吗|么|呢|啥|谁|哪|怎/.test(x))
      .length;
    if (qCount >= 2 && /你|吗|几|哪/.test(t)) {
      return "repeated_question";
    }
    return "normal_question";
  }

  if (/我觉得|我认为|应该|其实/.test(t)) {
    return "opinion";
  }

  return "unclear";
}
