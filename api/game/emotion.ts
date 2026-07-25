import type { GameSession } from "./store";
import type { UserAct } from "./userAct";

export type Mood =
  | "neutral"
  | "curious"
  | "friendly"
  | "playful"
  | "awkward"
  | "defensive"
  | "annoyed"
  | "bored";

export interface EmotionalState {
  mood: Mood;
  intensity: 0 | 1 | 2 | 3;
  decayTurns: number;
}

export function defaultEmotion(): EmotionalState {
  return { mood: "neutral", intensity: 0, decayTurns: 2 };
}

function setMood(session: GameSession, mood: Mood, intensity: 0 | 1 | 2 | 3) {
  session.memory.emotionalState = {
    mood,
    intensity,
    decayTurns: 2,
  };
}

/** Call once per player message before planning. */
export function updateEmotionForAct(session: GameSession, act: UserAct): void {
  const st = session.memory.emotionalState;

  st.decayTurns -= 1;
  if (st.decayTurns <= 0) {
    if (st.intensity > 0) {
      st.intensity = (st.intensity - 1) as 0 | 1 | 2 | 3;
    }
    if (st.intensity === 0) st.mood = "neutral";
    st.decayTurns = 2;
  }

  if (act === "ai_accusation") {
    const prior = session.memory.accusationCount;
    if (prior >= 2) setMood(session, "annoyed", 2);
    else if (prior >= 1) setMood(session, "defensive", 2);
    else setMood(session, "defensive", 1);
    return;
  }

  if (act === "self_disclosure" || act === "emotional_disclosure") {
    const next = Math.min(3, Math.max(1, st.intensity + 1)) as 1 | 2 | 3;
    setMood(session, "friendly", next);
    return;
  }

  if (act === "short_reaction") {
    const recent = session.history.filter((h) => h.role === "user").slice(-3);
    const shortN = recent.filter((h) => h.content.trim().length <= 2).length;
    if (shortN >= 2) setMood(session, "bored", 1);
    return;
  }

  if (act === "repeated_question") {
    setMood(session, "defensive", 2);
  }
}
