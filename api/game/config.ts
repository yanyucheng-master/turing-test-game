/** First-ship dialogue / delivery knobs (A+B iteration). */
export const INITIAL_CONFIG = {
  maxReplyParts: 2,
  maxPartLength: 40,
  maxTotalLength: 64,
  /** Relaxed caps when strategy is spill / targetLength long. */
  maxSpillPartLength: 110,
  maxSpillTotalLength: 180,

  cannedShortReplyRate: 0.35,
  cannedAccusationReplyRate: 0.2,

  proactiveMaxNormal: 1,
  proactiveMaxHighInitiative: 2,
  /** Mutual silence floor before AI may speak first / nudge. */
  proactiveMinSilenceMs: 10_000,

  minDelayMs: 500,
  maxDelayMs: 6500,
  doubleMessageGapMinMs: 400,
  doubleMessageGapMaxMs: 1000,

  chaosPersonaShareMax: 0.15,
  maxStrongChaosTurns: 3,

  earlyJudgeMinElapsedMs: 25_000,
  earlyJudgeMinPlayerMessages: 3,
  earlyJudgeMinTotalMessages: 6,

  maxMetaConversationTurns: 2,
  /** Prefer local compression / persona fallback over a second LLM call. */
  maxRewriteAttempts: 0,
} as const;
