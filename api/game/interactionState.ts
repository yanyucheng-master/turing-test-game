import type { SocialPersona, PersonaCluster } from "./socialPersonas";
import type { UserActAnalysis } from "./userAct";

/** Persistent in-match psychological state — drives strategy, not wording. */
export interface InteractionState {
  engagement: number;
  patience: number;
  guardedness: number;
  amusement: number;
  identityProbeStreak: number;
  interrogationStreak: number;
}

const CLUSTER_BASE: Record<
  PersonaCluster,
  Pick<
    InteractionState,
    "engagement" | "patience" | "guardedness" | "amusement"
  >
> = {
  campus_night: {
    engagement: 0.7,
    patience: 0.45,
    guardedness: 0.2,
    amusement: 0.65,
  },
  slow_observer: {
    engagement: 0.35,
    patience: 0.7,
    guardedness: 0.55,
    amusement: 0.25,
  },
  tired_worker: {
    engagement: 0.3,
    patience: 0.32,
    guardedness: 0.4,
    amusement: 0.2,
  },
  commute_fragment: {
    engagement: 0.4,
    patience: 0.4,
    guardedness: 0.35,
    amusement: 0.3,
  },
  teasing_friend: {
    engagement: 0.65,
    patience: 0.38,
    guardedness: 0.25,
    amusement: 0.8,
  },
  cautious_guard: {
    engagement: 0.4,
    patience: 0.55,
    guardedness: 0.7,
    amusement: 0.2,
  },
  high_social: {
    engagement: 0.8,
    patience: 0.5,
    guardedness: 0.15,
    amusement: 0.55,
  },
  cold_low_interest: {
    engagement: 0.22,
    patience: 0.35,
    guardedness: 0.5,
    amusement: 0.15,
  },
  creative_procrastinator: {
    engagement: 0.55,
    patience: 0.42,
    guardedness: 0.3,
    amusement: 0.7,
  },
  night_shift: {
    engagement: 0.45,
    patience: 0.4,
    guardedness: 0.35,
    amusement: 0.35,
  },
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function initialInteractionState(
  persona: SocialPersona,
): InteractionState {
  const base = CLUSTER_BASE[persona.cluster];
  return {
    engagement: clamp01(base.engagement * 0.7 + persona.social.warmth * 0.3),
    patience: clamp01(base.patience * 0.6 + persona.social.patience * 0.4),
    guardedness: clamp01(
      base.guardedness * 0.7 + (1 - persona.social.selfDisclosure) * 0.3,
    ),
    amusement: clamp01(base.amusement * 0.7 + persona.social.teasing * 0.3),
    identityProbeStreak: 0,
    interrogationStreak: 0,
  };
}

export function reduceInteractionState(
  previous: InteractionState,
  analysis: UserActAnalysis,
  persona: SocialPersona,
): InteractionState {
  const state: InteractionState = { ...previous };
  const absurdTol =
    persona.chaos === "troll" ? 0.85 : persona.chaos === "tease" ? 0.65 : 0.35;

  if (analysis.identityProbe > 0.7) {
    state.guardedness = clamp01(state.guardedness + 0.12);
    state.patience = clamp01(state.patience - 0.1);
    state.identityProbeStreak += 1;
  } else {
    state.identityProbeStreak = Math.max(0, state.identityProbeStreak - 1);
  }

  if (analysis.oddness > 0.65 && analysis.playfulness > 0.45) {
    state.amusement = clamp01(state.amusement + absurdTol * 0.15);
    state.engagement = clamp01(state.engagement + 0.04);
  } else if (analysis.oddness > 0.7 && analysis.playfulness < 0.35) {
    state.patience = clamp01(state.patience - 0.06);
  }

  if (analysis.emotionalDisclosure > 0.7) {
    state.engagement = clamp01(
      state.engagement + persona.social.warmth * 0.12,
    );
    state.guardedness = clamp01(state.guardedness - 0.05);
  }

  if (analysis.hostility > 0.65) {
    state.patience = clamp01(state.patience - 0.18);
    state.guardedness = clamp01(state.guardedness + 0.15);
  }

  if (analysis.personalIntrusion > 0.65) {
    state.guardedness = clamp01(state.guardedness + 0.1);
    state.patience = clamp01(state.patience - 0.06);
  }

  if (
    analysis.primaryAct === "normal_question" ||
    analysis.primaryAct === "personal_question" ||
    analysis.primaryAct === "repeated_question" ||
    analysis.primaryAct === "identity_bait"
  ) {
    state.interrogationStreak += 1;
  } else {
    state.interrogationStreak = 0;
  }

  if (state.interrogationStreak >= 3) {
    state.patience = clamp01(state.patience - 0.08);
    state.engagement = clamp01(state.engagement - 0.05);
  }

  if (analysis.primaryAct === "greeting" || analysis.primaryAct === "one_char_ping") {
    state.engagement = clamp01(state.engagement + 0.02);
  }

  return state;
}
