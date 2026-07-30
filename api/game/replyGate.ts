import type { GameSession } from "./store";
import { getSocialPersona } from "./socialPersonas";
import { nextRng } from "./rng";

/** Visible user lines after the last visible assistant message. */
export function unansweredUserTexts(session: GameSession): string[] {
  const visible = session.transcript
    .filter((e) => e.state === "visible")
    .sort((a, b) => a.occurredAt - b.occurredAt);
  let lastAssistant = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  return visible
    .slice(lastAssistant + 1)
    .filter((e) => e.role === "user")
    .map((e) => e.text);
}

export function unansweredPlayerText(session: GameSession): string {
  return unansweredUserTexts(session).join("\n");
}

export function hasPendingAssistant(session: GameSession): boolean {
  return session.transcript.some(
    (e) => e.role === "assistant" && e.state === "pending",
  );
}

/**
 * Decide whether to generate a reply for the current unanswered player burst.
 * Not 1:1 — can skip; floors force a reply after enough ignored turns.
 */
export function decideReplyToPlayer(
  session: GameSession,
): "reply" | "skip" | "busy" {
  const unanswered = unansweredUserTexts(session);
  if (!unanswered.length) return "skip";

  // Already typing / queued — don't stack another generation.
  if (hasPendingAssistant(session) || session.aiJobPending) return "busy";

  // Floor: too many ignored player lines → must answer.
  if (unanswered.length >= 3) return "reply";
  if (session.skippedReplyStreak >= 2) return "reply";

  // Explicit: may ignore the player's first message entirely.
  if (
    session.ignoreFirstPlayerMsg &&
    session.playerCount === 1 &&
    session.opponentCount === 0
  ) {
    return "skip";
  }

  const persona = getSocialPersona(session.socialPersonaId);
  const initiative = persona.social.initiative;
  let skipP = 0.18 + (1 - initiative) * 0.28; // ~0.18–0.46
  if (persona.cluster === "cold_low_interest") skipP += 0.12;
  if (persona.cluster === "cautious_guard") skipP += 0.06;
  if (persona.chaos === "troll") skipP += 0.08;
  if (session.opponentCount === 0) skipP += 0.1;
  if (session.playerCount <= 2) skipP += 0.05;
  // Second unanswered line: much less likely to ghost again.
  if (unanswered.length >= 2) skipP *= 0.22;

  skipP = Math.min(0.55, Math.max(0.08, skipP));
  return nextRng(session) < skipP ? "skip" : "reply";
}

/** After a skip: sometimes schedule a late reply; often stay silent. */
export function onSkipReply(session: GameSession): void {
  session.skippedReplyStreak += 1;

  const pureFirstGhost =
    session.ignoreFirstPlayerMsg &&
    session.playerCount === 1 &&
    session.opponentCount === 0;

  if (pureFirstGhost) {
    // Usually no reaction at all to the first line; rare deferred mutter.
    session.deferredReplyAt =
      nextRng(session) < 0.12
        ? Date.now() + 10_000 + nextRng(session) * 14_000
        : null;
    return;
  }

  // Other skips: sometimes come back late (partial read / phone glance).
  if (nextRng(session) < 0.42) {
    session.deferredReplyAt =
      Date.now() + 3_500 + nextRng(session) * 12_000;
  } else {
    session.deferredReplyAt = null;
  }
}

export function clearReplySkipState(session: GameSession): void {
  session.skippedReplyStreak = 0;
  session.deferredReplyAt = null;
}
