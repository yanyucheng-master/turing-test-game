import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import {
  TIME_LIMIT_SEC,
  MAX_PLAYER_MESSAGES,
  MATCH_WINDOW_SEC,
  type ChatReplyResult,
  type SyncResult,
  type MatchJoinResult,
  type MatchStatus,
  type FinishResult,
  type PulseResult,
  type GuessResult,
} from "@contracts/types";
import { callLLM } from "./llm";
import {
  buildSystemPrompt,
  fallbackReply,
  scrubReply,
  typingDelayMs,
  maybeChaosReply,
  maybeShortMessageReply,
  maybeAiAccusationReply,
  chaosTurnNudge,
} from "./personas";
import { getSession, getRoom, type Seat } from "./store";
import { joinMatch, pollMatch, cancelMatch } from "./matchmaking";
import {
  computeStats,
  truthOf,
  maybeTriggerAiEarlyJudge,
  revealIfReady,
  submitPlayerGuess,
  chatLocked,
  mustJudge,
  judgeDeadlineAt,
  takeSystemMessages,
  waitingMessage,
  waitingDeadline,
  getSettledResult,
} from "./settle";
import {
  afterAiReply,
  onPlayerActivity,
  maybeProactiveNudge,
  drainPendingNudges,
} from "./proactive";

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

  chat: publicQuery
    .input(z.object({ gameId: z.string(), text: z.string().min(1).max(500) }))
    .mutation(async ({ input }): Promise<ChatReplyResult> => {
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
          opponentJudged: mustJudge(session),
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
        const limitReached = session.playerCount >= MAX_PLAYER_MESSAGES;
        return { ok: true, pending: true, limitReached };
      }

      session.history.push({ role: "user", content: text });

      // AI may early-judge mid-conversation instead of replying.
      maybeTriggerAiEarlyJudge(session);
      if (session.aiJudgedAt && !session.myGuess) {
        return {
          ok: false,
          chatLocked: true,
          opponentJudged: true,
          judgeDeadlineAt: judgeDeadlineAt(session) ?? undefined,
        };
      }

      const canned =
        maybeAiAccusationReply(text) ??
        maybeShortMessageReply(text) ??
        maybeChaosReply(session.chaos);
      let reply: string;
      if (canned) {
        reply = canned;
      } else {
        const system = buildSystemPrompt(
          session.persona,
          session.card,
          session.chaos,
        );
        const nudge = chaosTurnNudge(session.chaos);
        const history = nudge
          ? [
              ...session.history.slice(-20),
              { role: "user" as const, content: nudge },
            ]
          : session.history.slice(-20);
        const temp =
          session.chaos === "chaos" || session.chaos === "troll"
            ? 1.2
            : session.persona === "human"
              ? 1.05
              : 0.95;
        const raw =
          (await callLLM(system, history, {
            maxTokens: 48,
            temperature: temp,
          })) ?? "";
        reply = scrubReply(raw) || fallbackReply(session.persona);
      }

      // Re-check after LLM wait — AI early-judge may have fired.
      maybeTriggerAiEarlyJudge(session);
      if (session.aiJudgedAt && !session.myGuess) {
        return {
          ok: false,
          chatLocked: true,
          opponentJudged: true,
          judgeDeadlineAt: judgeDeadlineAt(session) ?? undefined,
        };
      }

      session.history.push({ role: "assistant", content: reply });
      session.opponentCount += 1;
      afterAiReply(session);

      const limitReached = session.playerCount >= MAX_PLAYER_MESSAGES;

      return {
        ok: true,
        reply,
        typingMs: typingDelayMs(reply, session.replyPace),
        limitReached,
      };
    }),

  sync: publicQuery
    .input(
      z.object({
        gameId: z.string(),
        cursor: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }): Promise<SyncResult> => {
      const session = getSession(input.gameId);
      if (!session) {
        return {
          ok: false,
          sessionLost: !getSettledResult(input.gameId),
          messages: [],
          cursor: input.cursor,
        };
      }

      maybeTriggerAiEarlyJudge(session);

      if (session.mode !== "pvp" || !session.roomId || !session.seat) {
        return {
          ok: true,
          messages: [],
          cursor: input.cursor,
          chatLocked: chatLocked(session),
          opponentJudged: mustJudge(session),
          mustJudge: mustJudge(session),
          judgeDeadlineAt: judgeDeadlineAt(session) ?? undefined,
        };
      }

      const room = getRoom(session.roomId);
      if (!room) {
        return {
          ok: false,
          sessionLost: true,
          messages: [],
          cursor: input.cursor,
        };
      }

      const elapsed = (Date.now() - room.startedAt) / 1000;
      const expired = elapsed > TIME_LIMIT_SEC + 5;
      const other: Seat = session.seat === "a" ? "b" : "a";

      const messages = room.messages
        .slice(input.cursor)
        .filter((m) => m.seat !== session.seat)
        .map((m) => ({ from: "opponent" as const, text: m.text }));

      return {
        ok: true,
        messages,
        cursor: room.messages.length,
        expired,
        opponentLeft: !!room.left[other],
        chatLocked: chatLocked(session),
        opponentJudged: mustJudge(session),
        mustJudge: mustJudge(session),
        judgeDeadlineAt: judgeDeadlineAt(session) ?? undefined,
      };
    }),

  /** Heartbeat: AI early-judge, timeouts, waiting → reveal. */
  pulse: publicQuery
    .input(z.object({ gameId: z.string() }))
    .mutation(async ({ input }): Promise<PulseResult> => {
      const cached = getSettledResult(input.gameId);
      if (cached) {
        return { ok: true, phase: "revealed", result: cached };
      }

      const session = getSession(input.gameId);
      if (!session) {
        return { ok: false, sessionLost: true };
      }

      const revealed = await revealIfReady(session);
      if (revealed) {
        return { ok: true, phase: "revealed", result: revealed };
      }

      // Session may have been deleted by a concurrent reveal — re-check cache.
      const after = getSettledResult(input.gameId);
      if (after) {
        return { ok: true, phase: "revealed", result: after };
      }

      const live = getSession(input.gameId);
      if (!live) {
        return { ok: false, sessionLost: true };
      }

      maybeTriggerAiEarlyJudge(live);
      const nudged = maybeProactiveNudge(live);
      const pending = nudged.length ? nudged : drainPendingNudges(live);
      const systemMessages = takeSystemMessages(live);
      const opponentMessages = pending.map((text) => ({
        from: "opponent" as const,
        text,
      }));
      const typingMs = pending.length
        ? typingDelayMs(pending.join(""), live.replyPace)
        : undefined;

      if (live.waitingForOpponent) {
        return {
          ok: true,
          phase: "waiting",
          deadlineAt: waitingDeadline(live),
          message: waitingMessage(),
        };
      }

      return {
        ok: true,
        phase: "chat",
        chatLocked: chatLocked(live),
        opponentJudged: mustJudge(live),
        mustJudge: mustJudge(live),
        judgeDeadlineAt: judgeDeadlineAt(live),
        systemMessages,
        opponentMessages,
        typingMs,
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

      // Idempotent re-fetch while waiting.
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

      const result =
        (await revealIfReady(session)) ??
        (await (async () => {
          // Force reveal path for AI when both already set.
          if (session.myGuess && session.aiJudgment) {
            return revealIfReady(session);
          }
          return null;
        })());

      if (result) {
        return { phase: "revealed", result };
      }

      // PvP second submit should have revealed; if not, wait briefly.
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
