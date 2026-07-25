import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import {
  MAX_PLAYER_MESSAGES,
  MATCH_WINDOW_SEC,
  type ChatResult,
  type MatchJoinResult,
  type MatchStatus,
  type FinishResult,
  type EventPullResult,
} from "@contracts/types";
import {
  closeConversation,
  getSession,
  getRoom,
  isChatClosed,
  peekDueEvents,
  enqueueOpponentMessage,
  type Seat,
} from "./store";
import {
  joinMatch,
  pollMatch,
  cancelMatch,
  acceptMatch,
  ensureClaimedByGameId,
} from "./matchmaking";
import { queueAiGeneration } from "./aiWorker";
import {
  computeStats,
  maybeTriggerAiEarlyJudge,
  maybeJudgmentTimeout,
  revealIfReady,
  submitPlayerGuess,
  chatLocked,
  mustJudge,
  judgeDeadlineAt,
  waitingMessage,
  waitingDeadline,
  getSettledResult,
  closeChatIfExpired,
} from "./settle";
import { onPlayerActivity, maybeProactiveNudge } from "./proactive";
import {
  canRegisterActiveGame,
  checkRateLimit,
  clientIp,
  registerActiveGame,
  releaseActiveGame,
} from "./rateLimit";

function assertRate(
  ip: string,
  action: string,
  limit: number,
  windowMs: number,
) {
  if (!checkRateLimit(`${ip}:${action}`, limit, windowMs)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "请求过于频繁，请稍后再试",
    });
  }
}

export const gameRouter = createRouter({
  joinMatch: publicQuery.mutation(async ({ ctx }): Promise<MatchJoinResult> => {
    const ip = clientIp(ctx.req);
    assertRate(ip, "join", 5, 60_000);
    const { ticketId, joinedAt } = joinMatch();
    return {
      ticketId,
      matchWindowSec: MATCH_WINDOW_SEC,
      joinedAt,
    };
  }),

  pollMatch: publicQuery
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<MatchStatus> => {
      assertRate(clientIp(ctx.req), "poll", 120, 60_000);
      return pollMatch(input.ticketId);
    }),

  cancelMatch: publicQuery
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ input }) => {
      cancelMatch(input.ticketId);
      return { ok: true as const };
    }),

  acceptMatch: publicQuery
    .input(z.object({ ticketId: z.string(), gameId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const ip = clientIp(ctx.req);
      assertRate(ip, "accept", 20, 60_000);
      if (!canRegisterActiveGame(ip, input.gameId)) {
        return { ok: false as const };
      }
      const ok = acceptMatch(input.ticketId, input.gameId);
      if (!ok) return { ok: false as const };
      if (!registerActiveGame(ip, input.gameId)) {
        return { ok: false as const };
      }
      return { ok: true as const };
    }),

  /**
   * Unified chat ACK — identical shape for AI and PvP.
   * Never waits on LLM; never returns opponent reply.
   */
  chat: publicQuery
    .input(
      z.object({
        gameId: z.string(),
        text: z.string().trim().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ChatResult> => {
      const ip = clientIp(ctx.req);
      assertRate(ip, "chat", 30, 60_000);

      ensureClaimedByGameId(input.gameId);
      registerActiveGame(ip, input.gameId);

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

      if (closeChatIfExpired(session)) {
        return { ok: false, expired: true, chatLocked: true };
      }

      if (session.playerCount >= MAX_PLAYER_MESSAGES) {
        closeConversation(session, "message_limit");
        return { ok: false, limitReached: true, chatLocked: true };
      }

      const text = input.text;
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
        if (peer && !isChatClosed(peer)) {
          enqueueOpponentMessage(peer, text, Date.now());
          peer.opponentCount += 1;
        }
      } else {
        maybeTriggerAiEarlyJudge(session);
        if (!(session.aiJudgedAt && !session.myGuess)) {
          queueAiGeneration(session, text);
        }
      }

      const limitReached = session.playerCount >= MAX_PLAYER_MESSAGES;
      if (limitReached) {
        closeConversation(session, "message_limit");
      }

      return {
        ok: true,
        acceptedAt: Date.now(),
        limitReached,
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
    .mutation(async ({ ctx, input }): Promise<EventPullResult> => {
      ensureClaimedByGameId(input.gameId);
      registerActiveGame(clientIp(ctx.req), input.gameId);

      const cached = getSettledResult(input.gameId);
      if (cached) {
        releaseActiveGame(clientIp(ctx.req), input.gameId);
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
        releaseActiveGame(clientIp(ctx.req), input.gameId);
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
        releaseActiveGame(clientIp(ctx.req), input.gameId);
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
      maybeJudgmentTimeout(live);

      const expired = closeChatIfExpired(live);

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

      return {
        ok: true,
        phase: "chat",
        cursor,
        events,
        chatLocked: chatLocked(live) || expired || !!live.chatClosedAt,
        mustJudge: mustJudge(live),
        judgeDeadlineAt: judgeDeadlineAt(live) ?? live.judgmentDeadlineAt,
        expired,
        chatCloseReason: live.chatCloseReason,
      };
    }),

  finish: publicQuery
    .input(
      z.object({
        gameId: z.string(),
        guess: z.enum(["human", "ai"]),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<FinishResult> => {
      ensureClaimedByGameId(input.gameId);

      const cached = getSettledResult(input.gameId);
      if (cached) {
        releaseActiveGame(clientIp(ctx.req), input.gameId);
        return { phase: "revealed", result: cached };
      }

      const session = getSession(input.gameId);
      if (!session) {
        if (getSettledResult(input.gameId)) {
          return {
            phase: "revealed",
            result: getSettledResult(input.gameId)!,
          };
        }
        return {
          phase: "lost",
          message: "对局已失效，请重新开始（不会伪造对方身份）",
        };
      }

      if (session.myGuess && session.waitingForOpponent) {
        const revealed = await revealIfReady(session);
        if (revealed) {
          releaseActiveGame(clientIp(ctx.req), input.gameId);
          return { phase: "revealed", result: revealed };
        }
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
        releaseActiveGame(clientIp(ctx.req), input.gameId);
        return { phase: "revealed", result };
      }

      if (session.waitingForOpponent) {
        return {
          phase: "waiting",
          deadlineAt: waitingDeadline(session),
          message: waitingMessage(),
        };
      }

      return {
        phase: "lost",
        message: "结算状态异常，请重新开始",
      };
    }),

  stats: publicQuery.query(async () => computeStats()),
});
