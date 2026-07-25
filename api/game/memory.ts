import type { GameSession } from "./store";

/** Cheap rule-based fact harvest — no extra LLM call. */
export function harvestUserFacts(session: GameSession, text: string): void {
  const t = text.trim();
  if (t.length < 4) return;

  const rules: Array<{ key: string; re: RegExp; value: (m: RegExpMatchArray) => string }> = [
    {
      key: "exam",
      re: /(高数|期末|考试|四级|考研)/,
      value: (m) => `提到${m[1]}`,
    },
    {
      key: "work",
      re: /(上班|下班|加班|开会|老板)/,
      value: (m) => `提到${m[1]}`,
    },
    {
      key: "mood",
      re: /(好累|好烦|开心|难过|焦虑|崩溃|寄了)/,
      value: (m) => `情绪偏${m[1]}`,
    },
    {
      key: "place",
      re: /我(?:在|是)?([\u4e00-\u9fff]{2,4})人/,
      value: (m) => `自称${m[1]}人`,
    },
    {
      key: "age",
      re: /我(?:今年)?(\d{1,2})岁/,
      value: (m) => `约${m[1]}岁`,
    },
  ];

  for (const rule of rules) {
    const m = t.match(rule.re);
    if (!m) continue;
    const value = rule.value(m).slice(0, 36);
    const exists = session.memory.userFacts.some(
      (f) => f.key === rule.key || f.value === value,
    );
    if (exists) continue;
    session.memory.userFacts.push({
      key: rule.key,
      value,
      confidence: 0.6,
      turn: session.playerCount,
    });
  }

  if (session.memory.userFacts.length > 8) {
    session.memory.userFacts = session.memory.userFacts.slice(-8);
  }

  // Topic crumb
  const topic = t.slice(0, 12);
  if (topic && !session.memory.recentTopics.includes(topic)) {
    session.memory.recentTopics.push(topic);
    if (session.memory.recentTopics.length > 6) {
      session.memory.recentTopics = session.memory.recentTopics.slice(-6);
    }
  }
}

/** Paraphrase nudge from last fact — avoid echoing the player's raw sentence. */
export function contextualNudgeLine(session: GameSession): string | null {
  const fact = session.memory.userFacts.at(-1);
  if (!fact) return null;
  if (fact.key === "exam") return "考试那事还好吗";
  if (fact.key === "work") return "还在忙吗";
  if (fact.key === "mood") return "缓过来没";
  if (Math.random() < 0.5) return "然后呢";
  return null;
}
