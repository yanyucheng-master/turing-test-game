import { INITIAL_CONFIG } from "./config";
import type { SocialPersona } from "./socialPersonas";
import type { UserAct } from "./userAct";
import type { TurnPlan } from "./turnPolicy";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const PACE_TYPE_MS: Record<SocialPersona["tempo"]["pace"], number> = {
  fast: 55,
  normal: 80,
  slow: 110,
  erratic: 70,
};

export function calculateReplyDelay(input: {
  text: string;
  persona: SocialPersona;
  act: UserAct;
  plan: TurnPlan;
}): number {
  const len = Math.max(1, input.text.trim().length);
  const readingDelay = 250 + Math.random() * 350;
  const typingDelay = len * PACE_TYPE_MS[input.persona.tempo.pace];

  let semanticPause = 0;
  if (input.act === "personal_question" || input.act === "ai_accusation") {
    semanticPause = 600 + Math.random() * 1000;
  } else if (input.act === "knowledge_question" && input.plan.answerMode === "guess") {
    semanticPause = 400 + Math.random() * 600;
  }

  const jitter = Math.random() * 450;
  return Math.round(
    clamp(
      readingDelay + typingDelay + semanticPause + jitter,
      INITIAL_CONFIG.minDelayMs,
      INITIAL_CONFIG.maxDelayMs,
    ),
  );
}

export function doubleMessageGapMs(): number {
  const { doubleMessageGapMinMs: a, doubleMessageGapMaxMs: b } = INITIAL_CONFIG;
  return Math.round(a + Math.random() * (b - a));
}

export function scheduleDeliveries(
  parts: string[],
  baseDelayMs: number,
): Array<{ text: string; delayMs: number }> {
  if (!parts.length) return [];
  const out: Array<{ text: string; delayMs: number }> = [
    { text: parts[0], delayMs: baseDelayMs },
  ];
  if (parts[1]) {
    out.push({
      text: parts[1],
      delayMs: baseDelayMs + doubleMessageGapMs(),
    });
  }
  return out;
}
