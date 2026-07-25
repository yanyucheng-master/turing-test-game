import type { SocialPersona } from "./socialPersonas";

export interface KnowledgeDecision {
  level: "strong" | "familiar" | "weak" | "unknown" | "avoid";
  behavior:
    | "answer"
    | "partial_answer"
    | "subjective_guess"
    | "admit_unknown"
    | "deflect"
    | "ask_back";
  topic: string;
}

const TOPIC_KEYWORDS: Record<string, string[]> = {
  campus: ["学校", "宿舍", "上课", "室友", "期末", "考研", "高数", "社团"],
  exams: ["考试", "高数", "四级", "考研", "期末", "挂科"],
  games: ["游戏", "开黑", "排位", "王者", "原神", "steam"],
  food: ["吃", "饭", "外卖", "奶茶", "火锅", "饿"],
  commute: ["地铁", "公交", "通勤", "堵车", "加班"],
  work_life: ["上班", "下班", "老板", "开会", "同事", "加班"],
  work_shift: ["夜班", "值班", "倒班"],
  finance: ["股票", "基金", "理财", "炒股"],
  physics: ["量子", "相对论", "薛定谔", "物理"],
  science: ["公式", "算法", "证明", "定理"],
  politics: ["政治", "选举", "总统"],
  music: ["歌", "乐队", "听歌", "演唱会"],
  shows: ["剧", "综艺", "追番", "电影"],
  creative: ["画画", "写作", "剪辑", "卡文", "稿"],
  daily: ["今天", "天气", "睡觉", "周末"],
};

export function detectTopic(text: string): string {
  for (const [topic, keys] of Object.entries(TOPIC_KEYWORDS)) {
    if (keys.some((k) => text.includes(k))) return topic;
  }
  return "daily";
}

export function decideKnowledgeBoundary(
  persona: SocialPersona,
  text: string,
): KnowledgeDecision {
  const topic = detectTopic(text);
  const k = persona.knowledge;

  if (k.avoidedDomains.includes(topic)) {
    return { level: "avoid", behavior: "deflect", topic };
  }
  if (k.strongDomains.includes(topic)) {
    return { level: "strong", behavior: "answer", topic };
  }
  if (k.familiarDomains.includes(topic)) {
    return { level: "familiar", behavior: "partial_answer", topic };
  }
  if (k.weakDomains.includes(topic) || k.weakDomains.includes("everything_else")) {
    return {
      level: "weak",
      behavior:
        k.uncertaintyStyle === "guess"
          ? "subjective_guess"
          : k.uncertaintyStyle === "deflect"
            ? "deflect"
            : "admit_unknown",
      topic,
    };
  }
  return {
    level: "unknown",
    behavior:
      k.uncertaintyStyle === "guess" ? "subjective_guess" : "admit_unknown",
    topic,
  };
}
