import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import {
  TIME_LIMIT_SEC,
  MAX_PLAYER_MESSAGES,
  MATCH_WINDOW_SEC,
  type ChatResult,
  type MatchJoinResult,
  type MatchStatus,
  type FinishResult,
  type EventPullResult,
  type GuessResult,
} from "@contracts/types";
import {
  getSession,
  getRoom,
  peekDueEvents,
  enqueueOpponentMessage,
  type Seat,
} from "./store";
import { joinMatch, pollMatch, cancelMatch } from "./matchmaking";
import { queueAiGeneration } from "./aiWorker";
import {
  computeStats,
  truthOf,
  maybeTriggerAiEarlyJudge,
  revealIfReady,
  submitPlayerGuess,
  chatLocked,
  mustJudge,
  judgeDeadlineAt,
  waitingMessage,
  waitingDeadline,
  getSettledResult,
} from "./settle";
import { onPlayerActivity, maybeProactiveNudge } from "./proactive";

function emptyGuess(): GuessResult {
  return {
    correct: false,
    timedOut: false,
    truth: "ai",
    myGuess: null,
    opponentGuess: null,
    opponentTimedOut: false,
    opponentSource: "llm",
    playerMessages: 0,
    opponentMessages: 0,
    stats: { totalGames: 0, correctRate: 0, aiShare: 0 },
  };
}

export const gameRouter = createRouter({
  joinMatch: publicQuery.mutation(async (): Promise<MatchJoinResult> => {
    const { ticketId, joinedAt } = joinMatch();
    return {
      ticketId,
      matchWindowSec: MATCH_WINDOW_SEC,
      joinedAt,
    };
  }),

  pollMatch: publicQuery
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ input }): Promise<MatchStatus> =>
      pollMatch(input.ticketId),
    ),

  cancelMatch: publicQuery
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ input }) => {
      cancelMatch(input.ticketId);
      return { ok: true as const };
    }),

  /**
   * Unified chat ACK — identical shape for AI and PvP.
   * Never waits on LLM; never returns opponent reply.
   */
  chat: publicQuery
    .input(z.object({ gameId: z.string(), text: z.string().min(1).max(500) }))
    .mutation(async ({ input }): Promise<ChatResult> => {
      const session = getSession(input.gameId);
      if (!session) {
        if (getSettledResult(input.gameId)) {
          return { ok: false, chatLocked: true };
        }
        return { ok: false, sessionLost: true };
      }

      maybeTriggerAiEarlyJudge(session);

      if (chatLocked(session)) {
        return {
          ok: false,
          chatLocked: true,
          mustJudge: mustJudge(session),
          judgeDeadlineAt: judgeDeadlineAt(session) ?? undefined,
        };
      }

      const startedAt =
        session.mode === "pvp" && session.roomId
          ? (getRoom(session.roomId)?.startedAt ?? session.startedAt)
          : session.startedAt;
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed > TIME_LIMIT_SEC + 5) {
        return { ok: false, expired: true };
      }

      if (session.playerCount >= MAX_PLAYER_MESSAGES) {
        return { ok: false, limitReached: true };
      }

      const text = input.text.trim();
      session.playerCount += 1;
      onPlayerActivity(session);

      if (session.mode === "pvp") {
        const room = session.roomId ? getRoom(session.roomId) : undefined;
        if (!room || !session.seat) {
          return { ok: false, sessionLost: true };
        }
        const other: Seat = session.seat === "a" ? "b" : "a";
        if (room.left[other]) {
          return { ok: false, sessionLost: true };
        }
        room.messages.push({ seat: session.seat, text, at: Date.now() });
        const peer = getSession(room.seats[other]);
        if (peer) {
          enqueueOpponentMessage(peer, text, Date.now());
          peer.opponentCount += 1;
        }
      } else {
        // User line is appended inside aiWorker when the turn starts,
        // so rapid messages stay ordered as u1,a1,u2,a2.
        maybeTriggerAiEarlyJudge(session);
        if (!(session.aiJudgedAt && !session.myGuess)) {
          queueAiGeneration(session, text);
        }
      }

      return {
        ok: true,
        acceptedAt: Date.now(),
        limitReached: session.playerCount >= MAX_PLAYER_MESSAGES,
      };
    }),

  /**
   * Unified event pull — replaces sync + pulse.
   * Same endpoint / cadence for AI and PvP.
   */
  events: publicQuery
    .input(
      z.object({
        gameId: z.string(),
        cursor: z.number().int().min(0).default(0),
      }),
    )
    .mutation(async ({ input }): Promise<EventPullResult> => {
      const cached = getSettledResult(input.gameId);
      if (cached) {
        return {
          ok: true,
          phase: "revealed",
          cursor: input.cursor,
          events: [],
          result: cached,
        };
      }

      const session = getSession(input.gameId);
      if (!session) {
        return { ok: false, sessionLost: true };
      }

      const revealed = await revealIfReady(session);
      if (revealed) {
        return {
          ok: true,
          phase: "revealed",
          cursor: input.cursor,
          events: [],
          result: revealed,
        };
      }

      const after = getSettledResult(input.gameId);
      if (after) {
        return {
          ok: true,
          phase: "revealed",
          cursor: input.cursor,
          events: [],
          result: after,
        };
      }

      const live = getSession(input.gameId);
      if (!live) {
        return { ok: false, sessionLost: true };
      }

      maybeTriggerAiEarlyJudge(live);
      maybeProactiveNudge(live);

      const events = peekDueEvents(live, input.cursor);
      const cursor =
        events.length > 0
          ? events[events.length - 1].seq
          : input.cursor;

      if (live.waitingForOpponent) {
        return {
          ok: true,
          phase: "waiting",
          cursor,
          events,
          deadlineAt: waitingDeadline(live),
          message: waitingMessage(),
        };
      }

      const startedAt =
        live.mode === "pvp" && live.roomId
          ? (getRoom(live.roomId)?.startedAt ?? live.startedAt)
          : live.startedAt;
      const expired =
        !live.myGuess &&
        !live.aiJudgedAt &&
        (Date.now() - startedAt) / 1000 > TIME_LIMIT_SEC + 5;

      return {
        ok: true,
        phase: "chat",
        cursor,
        events,
        chatLocked: chatLocked(live) || expired,
        mustJudge: mustJudge(live),
        judgeDeadlineAt: judgeDeadlineAt(live),
        expired,
      };
    }),

  finish: publicQuery
    .input(
      z.object({
        gameId: z.string(),
        guess: z.enum(["human", "ai"]),
      }),
    )
    .mutation(async ({ input }): Promise<FinishResult> => {
      const cached = getSettledResult(input.gameId);
      if (cached) {
        return { phase: "revealed", result: cached };
      }

      const session = getSession(input.gameId);
      if (!session) {
        const stats = await computeStats();
        return {
          phase: "revealed",
          result: { ...emptyGuess(), stats },
        };
      }

      if (session.myGuess && session.waitingForOpponent) {
        const revealed = await revealIfReady(session);
        if (revealed) return { phase: "revealed", result: revealed };
        return {
          phase: "waiting",
          deadlineAt: waitingDeadline(session),
          message: waitingMessage(),
        };
      }

      maybeTriggerAiEarlyJudge(session);
      const phase = submitPlayerGuess(session, input.guess);

      if (phase === "waiting") {
        return {
          phase: "waiting",
          deadlineAt: waitingDeadline(session),
          message: waitingMessage(),
        };
      }

      const result = await revealIfReady(session);
      if (result) {
        return { phase: "revealed", result };
      }

      if (session.waitingForOpponent) {
        return {
          phase: "waiting",
          deadlineAt: waitingDeadline(session),
          message: waitingMessage(),
        };
      }

      const stats = await computeStats();
      return {
        phase: "revealed",
        result: {
          ...emptyGuess(),
          stats,
          truth: truthOf(session.persona, session.opponentSource),
          myGuess: session.myGuess,
          opponentSource: session.opponentSource,
        },
      };
    }),

  stats: publicQuery.query(async () => computeStats()),
});
