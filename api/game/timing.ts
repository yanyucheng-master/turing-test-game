import { INITIAL_CONFIG } from "./config";
import type { SocialPersona } from "./socialPersonas";
import type { UserAct, UserActAnalysis } from "./userAct";
import type { TurnPlan } from "./turnPolicy";
import type { GameSession } from "./store";
import { nextRng } from "./rng";

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
  analysis?: UserActAnalysis;
  session?: GameSession;
}): number {
  const rng = input.session ? () => nextRng(input.session!) : Math.random;
  const len = Math.max(1, input.text.trim().length);
  const readingDelay = 250 + rng() * 350;
  const typingDelay = len * PACE_TYPE_MS[input.persona.tempo.pace];

  let interpretationPause = 0;
  const odd = input.analysis?.oddness ?? 0;
  if (input.act === "ai_accusation") {
    interpretationPause = 800 + rng() * 1_200;
  } else if (input.act === "personal_question") {
    interpretationPause = 600 + rng() * 1000;
  } else if (odd > 0.55 || input.plan.strategy === "play_along") {
    interpretationPause = 500 + rng() * 1_100;
  } else if (
    input.act === "knowledge_question" &&
    input.plan.answerMode === "guess"
  ) {
    interpretationPause = 400 + rng() * 600;
  }

  const patience = input.session?.memory.interaction.patience ?? 0.5;
  const hesitation = patience < 0.3 ? 200 + rng() * 400 : rng() * 200;
  const jitter = rng() * 450;

  return Math.round(
    clamp(
      readingDelay + typingDelay + interpretationPause + hesitation + jitter,
      INITIAL_CONFIG.minDelayMs,
      INITIAL_CONFIG.maxDelayMs,
    ),
  );
}

export function doubleMessageGapMs(session?: GameSession): number {
  const { doubleMessageGapMinMs: a, doubleMessageGapMaxMs: b } = INITIAL_CONFIG;
  const r = session ? nextRng(session) : Math.random();
  return Math.round(a + r * (b - a));
}

export function scheduleDeliveries(
  parts: string[],
  baseDelayMs: number,
  session?: GameSession,
): Array<{ text: string; delayMs: number }> {
  if (!parts.length) return [];
  const out: Array<{ text: string; delayMs: number }> = [
    { text: parts[0], delayMs: baseDelayMs },
  ];
  if (parts[1]) {
    out.push({
      text: parts[1],
      delayMs: baseDelayMs + doubleMessageGapMs(session),
    });
  }
  return out;
}
