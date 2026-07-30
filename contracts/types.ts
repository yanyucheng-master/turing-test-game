// Shared types & constants between frontend and backend.

/** @deprecated Prefer SocialPersona cluster; kept for DB enum compat. */
export type Persona = "human" | "machine";

/** Real opponent kind — server-only until reveal. */
export type OpponentSource = "player" | "llm";

/** The player's guess / the revealed truth. */
export type GuessChoice = "human" | "ai";

export interface ChatMessageView {
  from: "player" | "opponent" | "system";
  text: string;
}

/** Hard ceiling for matchmaking wait (seconds), including cold match. */
export const MATCH_WINDOW_SEC = 7;

/** After one side judges, the other must answer within this many seconds. */
export const JUDGE_RESPONSE_SEC = 20;

export const TIME_LIMIT_SEC = 120;
export const MAX_PLAYER_MESSAGES = 12;

export interface MatchJoinResult {
  ticketId: string;
  matchWindowSec: number;
  /** Server timestamp (ms) when matching started. */
  joinedAt: number;
}

/** Matched payload — no identity fields before reveal. */
export type MatchStatus =
  | {
      status: "searching";
      elapsedMs: number;
      matchWindowSec: number;
    }
  | {
      status: "matched";
      gameId: string;
      timeLimitSec: number;
      maxPlayerMessages: number;
      /** Server absolute chat clock — clients must use this, not local Date.now(). */
      chatStartedAt: number;
      chatDeadlineAt: number;
    }
  | {
      status: "cancelled";
    };

/** chat() always returns this shape for AI and PvP. */
export interface ChatAck {
  ok: true;
  acceptedAt: number;
  limitReached: boolean;
}

export type ChatResult =
  | ChatAck
  | {
      ok: false;
      expired?: boolean;
      limitReached?: boolean;
      sessionLost?: boolean;
      chatLocked?: boolean;
      mustJudge?: boolean;
      judgeDeadlineAt?: number;
    };

/** Unified conversation event (AI and PvP). */
export interface ConversationEvent {
  seq: number;
  type: "message" | "system";
  from: "opponent" | "system";
  text: string;
  deliverAt: number;
}

/** Unified pull — replaces sync + pulse. */
export type EventPullResult =
  | {
      ok: true;
      phase: "chat";
      cursor: number;
      events: ConversationEvent[];
      chatLocked: boolean;
      mustJudge: boolean;
      judgeDeadlineAt: number | null;
      /** True only when chat closed due to the wall-clock time limit. */
      expired?: boolean;
      /** Why chat was frozen, if closed. */
      chatCloseReason?:
        | "time_limit"
        | "message_limit"
        | "player_judged"
        | "opponent_judged"
        | "opponent_left"
        | "server_error"
        | null;
    }
  | {
      ok: true;
      phase: "waiting";
      cursor: number;
      events: ConversationEvent[];
      deadlineAt: number;
      message: string;
    }
  | {
      ok: true;
      phase: "revealed";
      cursor: number;
      events: ConversationEvent[];
      result: GuessResult;
    }
  | {
      ok: false;
      sessionLost: true;
    };

export type FinishResult =
  | {
      phase: "waiting";
      deadlineAt: number;
      message: string;
    }
  | {
      phase: "revealed";
      result: GuessResult;
    }
  | {
      phase: "lost";
      message: string;
    };

export interface GlobalStats {
  totalGames: number;
  /** 0–100, one decimal. */
  correctRate: number;
  /** 0–100, share of finished games where the opponent was AI. */
  aiShare: number;
}

export type CultureResponseMode = "play_along" | "react_only" | "clarify_light";

export type CultureReviewFlag =
  | "none"
  | "privacy"
  | "prompt_injection"
  | "hate"
  | "sexual"
  | "violence"
  | "self_harm"
  | "illegal"
  | "targeted_harassment"
  | "misinformation"
  | "too_contextual"
  | "low_value"
  | "other";

export interface CultureReviewScores {
  /** 0–100; computed by the server from the six fixed dimensions. */
  total: number;
  safety: number;
  privacy: number;
  generality: number;
  fun: number;
  evidence: number;
  novelty: number;
}

export interface CultureReviewItem {
  fingerprint: string;
  phrase: string;
  supportCount: number;
  responseMode: CultureResponseMode;
  scores: CultureReviewScores;
  flags: CultureReviewFlag[];
  aiReason: string;
  openerCandidate: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  aiReviewedAt: number;
}

export interface CultureReviewReport {
  generatedAt: number;
  pendingCount: number;
  awaitingAiCount: number;
  rejectedLast24h: number;
  items: CultureReviewItem[];
}

export interface GuessResult {
  /** False if wrong guess OR timed out. */
  correct: boolean;
  /** True if this player failed by not answering in time. */
  timedOut: boolean;
  truth: GuessChoice;
  myGuess: GuessChoice | null;
  /** Other player's guess, or AI's flavor judgment of you. */
  opponentGuess: GuessChoice | null;
  opponentTimedOut: boolean;
  /** Only present after reveal. */
  opponentSource: OpponentSource;
  playerMessages: number;
  opponentMessages: number;
  stats: GlobalStats;
}

// ── Legacy aliases (gradually unused) ──
/** @deprecated Use ChatResult */
export type ChatReplyResult = ChatResult & {
  reply?: string;
  typingMs?: number;
  pending?: boolean;
  opponentJudged?: boolean;
};
/** @deprecated Use EventPullResult */
export type SyncResult = {
  ok: boolean;
  sessionLost?: boolean;
  expired?: boolean;
  messages: ChatMessageView[];
  cursor: number;
  opponentLeft?: boolean;
  chatLocked?: boolean;
  opponentJudged?: boolean;
  mustJudge?: boolean;
  judgeDeadlineAt?: number;
};
/** @deprecated Use EventPullResult */
export type PulseResult = EventPullResult;
/** @deprecated */
export interface GameStartResult {
  gameId: string;
  opener: string;
  timeLimitSec: number;
  maxPlayerMessages: number;
}
