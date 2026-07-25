// Shared types & constants between frontend and backend.

/** Internal persona assigned to an LLM opponent (disguise). */
export type Persona = "human" | "machine";

/** Whether the opponent is a real player or an LLM. */
export type OpponentSource = "player" | "llm";

/** The player's guess / the revealed truth. */
export type GuessChoice = "human" | "ai";

export interface ChatMessageView {
  from: "player" | "opponent" | "system";
  text: string;
}

/** Forced matchmaking window. AI arrives at a random time inside this window. */
export const MATCH_WINDOW_SEC = 10;

/** After one side judges, the other must answer within this many seconds. */
export const JUDGE_RESPONSE_SEC = 20;

export interface MatchJoinResult {
  ticketId: string;
  matchWindowSec: number;
  /** Server timestamp (ms) when matching started. */
  joinedAt: number;
}

export type MatchStatus =
  | {
      status: "searching";
      /** Elapsed ms since join. */
      elapsedMs: number;
      matchWindowSec: number;
    }
  | {
      status: "matched";
      gameId: string;
      /** Opening line (AI only; empty for PvP). */
      opener: string;
      timeLimitSec: number;
      maxPlayerMessages: number;
      /** Hidden from UI during chat; useful for client bookkeeping. */
      opponentSource: OpponentSource;
    }
  | {
      status: "cancelled";
    };

export interface GameStartResult {
  gameId: string;
  /** The opponent's opening line. */
  opener: string;
  timeLimitSec: number;
  maxPlayerMessages: number;
}

export interface ChatReplyResult {
  ok: boolean;
  reply?: string;
  /** Simulated human typing delay for the client-side typing indicator. */
  typingMs?: number;
  /** Time is up — client should move to the guessing phase. */
  expired?: boolean;
  /** Message quota exhausted — client should move to the guessing phase. */
  limitReached?: boolean;
  /** Session lost (server restarted etc.) — client should offer a restart. */
  sessionLost?: boolean;
  /**
   * PvP: message accepted but no immediate reply.
   * Client should poll `sync` for opponent messages.
   */
  pending?: boolean;
  /** Chat locked because someone already judged. */
  chatLocked?: boolean;
  opponentJudged?: boolean;
  judgeDeadlineAt?: number;
}

export interface SyncResult {
  ok: boolean;
  sessionLost?: boolean;
  expired?: boolean;
  /** New opponent (and system) messages since `after`. */
  messages: ChatMessageView[];
  /** Next cursor for subsequent sync calls. */
  cursor: number;
  opponentLeft?: boolean;
  chatLocked?: boolean;
  opponentJudged?: boolean;
  mustJudge?: boolean;
  judgeDeadlineAt?: number;
}

/** Periodic heartbeat while in chat / waiting — drives AI early-judge & timeouts. */
export type PulseResult =
  | {
      ok: true;
      phase: "chat";
      chatLocked: boolean;
      opponentJudged: boolean;
      mustJudge: boolean;
      judgeDeadlineAt: number | null;
      systemMessages: ChatMessageView[];
      /** AI follow-ups while you were silent (e.g. 「在吗」). */
      opponentMessages: ChatMessageView[];
      /** Client typing-indicator delay before revealing opponentMessages. */
      typingMs?: number;
    }
  | {
      ok: true;
      phase: "waiting";
      deadlineAt: number;
      message: string;
    }
  | {
      ok: true;
      phase: "revealed";
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
    };

export interface GlobalStats {
  totalGames: number;
  /** 0–100, one decimal. */
  correctRate: number;
  /** 0–100, share of finished games where the opponent was AI. */
  aiShare: number;
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
  /** Real player vs LLM-backed opponent. */
  opponentSource: OpponentSource;
  playerMessages: number;
  opponentMessages: number;
  stats: GlobalStats;
}

export const TIME_LIMIT_SEC = 120;
export const MAX_PLAYER_MESSAGES = 12;
