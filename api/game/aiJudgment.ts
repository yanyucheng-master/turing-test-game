import type { GuessChoice } from "@contracts/types";
import type { GameSession } from "./store";
import { getSocialPersona } from "./socialPersonas";

/**
 * Flavor-only judgment of the human player (not scored).
 * Uses simple chat features so early-judge feels less random.
 */
export function flavorJudgePlayer(session: GameSession): GuessChoice {
  const users = session.history.filter((h) => h.role === "user");
  if (!users.length) return Math.random() < 0.65 ? "human" : "ai";

  const lengths = users.map((h) => h.content.trim().length);
  const avg =
    lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const variance =
    lengths.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, lengths.length);

  const repeatedQ =
    users.filter((h) =>
      /你是|是不是|多大|哪里|学校|AI|机器人/i.test(h.content),
    ).length / users.length;

  const accusation = session.memory.accusationCount;
  const disclosure = users.filter((h) =>
    /我|今天|刚才|觉得|有点/.test(h.content),
  ).length;

  let humanScore = 0;
  if (variance > 18) humanScore += 1;
  if (disclosure > 0) humanScore += 1;
  if (avg >= 2 && avg <= 28) humanScore += 1;
  if (repeatedQ > 0.45) humanScore -= 1;
  if (accusation >= 2) humanScore -= 1;
  // Extremely tidy long essays feel more "probe AI"
  if (avg > 40 && variance < 8) humanScore -= 1;

  const persona = getSocialPersona(session.socialPersonaId);
  // Impatient personas slightly more willing to call "ai"
  if (persona.social.patience < 0.4 && humanScore <= 0) {
    humanScore -= 0.5;
  }

  if (humanScore >= 1.5) return "human";
  if (humanScore <= -0.5) return "ai";
  return Math.random() < 0.62 ? "human" : "ai";
}
