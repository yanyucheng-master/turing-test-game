import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import IntroScreen from "@/components/game/IntroScreen";
import MatchingScreen from "@/components/game/MatchingScreen";
import WaitingScreen from "@/components/game/WaitingScreen";
import ChatScreen from "@/components/game/ChatScreen";
import GuessDialog from "@/components/game/GuessDialog";
import VerdictScreen from "@/components/game/VerdictScreen";
import type {
  ChatMessageView,
  GuessChoice,
  GuessResult,
} from "@contracts/types";
import { TIME_LIMIT_SEC } from "@contracts/types";

type Phase = "intro" | "matching" | "chat" | "waiting" | "verdict";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [matchElapsedMs, setMatchElapsedMs] = useState(0);
  const [matchWindowSec, setMatchWindowSec] = useState(10);
  const [gameId, setGameId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [deadline, setDeadline] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(TIME_LIMIT_SEC);
  const [chatOver, setChatOver] = useState(false);
  const [guessOpen, setGuessOpen] = useState(false);
  const [mustJudgeMode, setMustJudgeMode] = useState(false);
  const [judgeDeadlineAt, setJudgeDeadlineAt] = useState<number | null>(null);
  const [judgeSecondsLeft, setJudgeSecondsLeft] = useState<number | null>(null);
  const [waitDeadlineAt, setWaitDeadlineAt] = useState(0);
  const [waitMessage, setWaitMessage] = useState("");
  const [waitNow, setWaitNow] = useState(Date.now());
  const [result, setResult] = useState<GuessResult | null>(null);
  const [showVerdict, setShowVerdict] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const eventCursorRef = useRef(0);
  const matchJoinedAtRef = useRef(0);
  const mustJudgeRef = useRef(false);
  const chatOverRef = useRef(false);

  const setChatEnded = (value: boolean) => {
    chatOverRef.current = value;
    setChatOver(value);
  };

  const joinMut = trpc.game.joinMatch.useMutation();
  const pollMut = trpc.game.pollMatch.useMutation();
  const cancelMut = trpc.game.cancelMatch.useMutation();
  const acceptMut = trpc.game.acceptMatch.useMutation();
  const chatMut = trpc.game.chat.useMutation();
  const finishMut = trpc.game.finish.useMutation();
  const eventsMut = trpc.game.events.useMutation();
  const pollAsyncRef = useRef(pollMut.mutateAsync);
  pollAsyncRef.current = pollMut.mutateAsync;
  const acceptAsyncRef = useRef(acceptMut.mutateAsync);
  acceptAsyncRef.current = acceptMut.mutateAsync;
  const eventsAsyncRef = useRef(eventsMut.mutateAsync);
  eventsAsyncRef.current = eventsMut.mutateAsync;

  const showReveal = (r: GuessResult) => {
    setResult(r);
    setGuessOpen(false);
    setMustJudgeMode(false);
    mustJudgeRef.current = false;
    setJudgeDeadlineAt(null);
    setChatEnded(true);
    setPhase("verdict");
    setShowVerdict(true);
  };

  const enterWaiting = (deadlineAt: number, message: string) => {
    setWaitDeadlineAt(deadlineAt);
    setWaitMessage(message);
    setWaitNow(Date.now());
    setGuessOpen(false);
    setChatEnded(true);
    setPhase("waiting");
  };

  const enterMustJudge = (deadlineAt: number, sysMsgs?: ChatMessageView[]) => {
    setMustJudgeMode(true);
    mustJudgeRef.current = true;
    setJudgeDeadlineAt(deadlineAt);
    setChatEnded(true);
    // Server outbox is the sole source for judge tips — avoid local duplicates.
    if (sysMsgs?.length) {
      setMessages((ms) => [...ms, ...sysMsgs]);
    }
    setGuessOpen(true);
  };

  const enterChat = (r: {
    gameId: string;
    timeLimitSec: number;
    chatDeadlineAt?: number;
    chatStartedAt?: number;
  }) => {
    setGameId(r.gameId);
    eventCursorRef.current = 0;
    setMessages([{ from: "system", text: "已为你匹配一位匿名对话者" }]);
    setResult(null);
    setShowVerdict(false);
    setSessionLost(false);
    setChatEnded(false);
    setGuessOpen(false);
    setMustJudgeMode(false);
    mustJudgeRef.current = false;
    setJudgeDeadlineAt(null);
    setJudgeSecondsLeft(null);
    const deadlineAt =
      r.chatDeadlineAt ?? Date.now() + r.timeLimitSec * 1000;
    setDeadline(deadlineAt);
    setSecondsLeft(
      Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)),
    );
    setTicketId(null);
    setPhase("chat");
  };

  const startMatch = () => {
    joinMut.mutate(undefined, {
      onSuccess: (r) => {
        setTicketId(r.ticketId);
        setMatchWindowSec(r.matchWindowSec);
        setMatchElapsedMs(0);
        matchJoinedAtRef.current = Date.now();
        setPhase("matching");
      },
    });
  };

  const cancelMatching = () => {
    if (ticketId) cancelMut.mutate({ ticketId });
    setTicketId(null);
    setPhase("intro");
  };

  // Matchmaking poll (no overlapping requests)
  useEffect(() => {
    if (phase !== "matching" || !ticketId) return;
    let stopped = false;
    let timer = 0;
    let polling = false;

    const loop = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const status = await pollAsyncRef.current({ ticketId });
        if (stopped) return;
        if (status.status === "cancelled") {
          setTicketId(null);
          setPhase("intro");
          return;
        }
        if (status.status === "searching") {
          setMatchElapsedMs(status.elapsedMs);
          setMatchWindowSec(status.matchWindowSec);
        } else if (status.status === "matched") {
          let accepted = false;
          try {
            const res = await acceptAsyncRef.current({
              ticketId,
              gameId: status.gameId,
            });
            accepted = !!res.ok;
          } catch {
            accepted = false;
          }
          if (stopped) return;
          if (!accepted) {
            setTicketId(null);
            setSessionLost(true);
            setPhase("intro");
            return;
          }
          enterChat(status);
          return;
        }
      } catch {
        /* keep polling */
      } finally {
        polling = false;
        if (!stopped) timer = window.setTimeout(() => void loop(), 400);
      }
    };

    void loop();
    const localClock = window.setInterval(() => {
      if (matchJoinedAtRef.current) {
        setMatchElapsedMs(Date.now() - matchJoinedAtRef.current);
      }
    }, 500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(localClock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ticketId]);

  const endChat = (sysMsg?: string) => {
    if (chatOverRef.current) {
      setGuessOpen(true);
      return;
    }
    setChatEnded(true);
    if (sysMsg) {
      setMessages((ms) => {
        if (ms.some((m) => m.text === sysMsg)) return ms;
        return [...ms, { from: "system", text: sysMsg }];
      });
    }
    setGuessOpen(true);
  };

  // Chat countdown
  useEffect(() => {
    if (phase !== "chat" || chatOver || mustJudgeMode || !deadline) return;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(t);
        endChat("时间到，请做出你的判断");
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, chatOver, deadline, mustJudgeMode]);

  // Judge response countdown
  useEffect(() => {
    if (!mustJudgeMode || !judgeDeadlineAt || phase !== "chat") return;
    const t = setInterval(() => {
      const left = Math.max(
        0,
        Math.ceil((judgeDeadlineAt - Date.now()) / 1000),
      );
      setJudgeSecondsLeft(left);
    }, 200);
    return () => clearInterval(t);
  }, [mustJudgeMode, judgeDeadlineAt, phase]);

  // Waiting page clock
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(() => setWaitNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [phase]);

  // Unified events poll — recursive timeout avoids overlapping requests
  useEffect(() => {
    if ((phase !== "chat" && phase !== "waiting") || !gameId) return;
    let stopped = false;
    let timer = 0;

    const loop = async () => {
      if (stopped) return;
      try {
        const r = await eventsAsyncRef.current({
          gameId,
          cursor: eventCursorRef.current,
        });
        if (stopped) return;
        if (!r.ok) {
          if (r.sessionLost && phase === "chat" && !mustJudgeRef.current) {
            setSessionLost(true);
            setChatEnded(true);
          }
          return;
        }

        if (r.events.length > 0) {
          eventCursorRef.current = r.cursor;
          const incoming: ChatMessageView[] = r.events.map((e) => ({
            from: e.from,
            text: e.text,
          }));
          setMessages((ms) => [...ms, ...incoming]);
        }

        if (r.phase === "revealed") {
          showReveal(r.result);
          return;
        }
        if (r.phase === "waiting") {
          if (phase !== "waiting") {
            enterWaiting(r.deadlineAt, r.message);
          } else {
            setWaitDeadlineAt(r.deadlineAt);
            setWaitMessage(r.message);
          }
          return;
        }

        if (r.mustJudge && r.judgeDeadlineAt) {
          if (!mustJudgeRef.current) {
            enterMustJudge(r.judgeDeadlineAt);
          } else {
            setJudgeDeadlineAt(r.judgeDeadlineAt);
          }
        } else if (
          r.expired &&
          !mustJudgeRef.current &&
          !chatOverRef.current
        ) {
          endChat("时间到，请做出你的判断");
        } else if (
          r.chatCloseReason === "message_limit" &&
          !mustJudgeRef.current &&
          !chatOverRef.current
        ) {
          endChat("对话已结束，请做出你的判断");
        } else if (
          r.chatCloseReason === "opponent_left" &&
          !mustJudgeRef.current &&
          !chatOverRef.current
        ) {
          endChat("对方已离开，请做出你的判断");
        } else if (r.chatLocked) {
          setChatEnded(true);
          if (r.judgeDeadlineAt) setJudgeDeadlineAt(r.judgeDeadlineAt);
        }
      } catch {
        /* ignore */
      } finally {
        if (!stopped) timer = window.setTimeout(() => void loop(), 600);
      }
    };

    void loop();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameId]);

  const send = (text: string) => {
    if (!gameId || chatOverRef.current || mustJudgeMode) return;
    setMessages((ms) => [...ms, { from: "player", text }]);

    chatMut.mutate(
      { gameId, text },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            if (r.mustJudge && r.judgeDeadlineAt) {
              enterMustJudge(r.judgeDeadlineAt);
              return;
            }
            if (r.chatLocked && !r.limitReached && !r.expired) {
              setChatEnded(true);
              return;
            }
            if (r.sessionLost) {
              setSessionLost(true);
              setChatEnded(true);
              setMessages((ms) => [
                ...ms,
                { from: "system", text: "连接中断，对方已离开" },
              ]);
            } else if (r.expired) {
              endChat("时间到，请做出你的判断");
            } else if (r.limitReached) {
              endChat("对方有事要忙，先离开了");
            }
            return;
          }

          if (r.limitReached) {
            endChat("对方有事要忙，先离开了");
          }
        },
      },
    );
  };

  const guess = (choice: GuessChoice) => {
    if (!gameId) return;
    finishMut.mutate(
      { gameId, guess: choice },
      {
        onSuccess: (r) => {
          if (r.phase === "lost") {
            setSessionLost(true);
            setChatEnded(true);
            setMessages((ms) => [
              ...ms,
              { from: "system", text: r.message },
            ]);
            return;
          }
          if (r.phase === "waiting") {
            enterWaiting(r.deadlineAt, r.message);
            return;
          }
          showReveal(r.result);
        },
      },
    );
  };

  if (phase === "intro") {
    return (
      <div>
        <IntroScreen starting={joinMut.isPending} onStart={startMatch} />
        {joinMut.isError && (
          <p className="fixed bottom-6 left-1/2 -translate-x-1/2 font-mono-x text-xs text-[var(--accent)]">
            匹配失败，请再试一次
          </p>
        )}
      </div>
    );
  }

  if (phase === "matching") {
    return (
      <MatchingScreen
        elapsedMs={matchElapsedMs}
        matchWindowSec={matchWindowSec}
        onCancel={cancelMatching}
      />
    );
  }

  if (phase === "waiting") {
    return (
      <WaitingScreen
        message={waitMessage}
        deadlineAt={waitDeadlineAt}
        now={waitNow}
      />
    );
  }

  return (
    <div>
      <ChatScreen
        messages={messages}
        secondsLeft={secondsLeft}
        inputDisabled={chatOver || mustJudgeMode}
        truth={result && !showVerdict ? result.truth : null}
        judgeSecondsLeft={mustJudgeMode ? judgeSecondsLeft : null}
        onSend={send}
        onEndEarly={() => setGuessOpen(true)}
      />

      <GuessDialog
        open={guessOpen}
        submitting={finishMut.isPending}
        onGuess={guess}
        onClose={() => {
          setGuessOpen(false);
        }}
      />

      {sessionLost && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-30">
          <button
            onClick={startMatch}
            disabled={joinMut.isPending}
            className="border border-[var(--ink)] bg-white px-6 py-2.5 font-mono-x text-xs tracking-[0.2em] uppercase shadow-[4px_4px_0_rgba(13,13,13,0.9)] hover:bg-[var(--ink)] hover:text-white transition-colors"
          >
            {joinMut.isPending ? "匹配中…" : "重新开始"}
          </button>
        </div>
      )}

      {phase === "verdict" && result && showVerdict && (
        <VerdictScreen
          result={result}
          onRestart={startMatch}
          onReview={() => setShowVerdict(false)}
        />
      )}
    </div>
  );
}
