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
  OpponentSource,
} from "@contracts/types";
import { TIME_LIMIT_SEC } from "@contracts/types";

type Phase = "intro" | "matching" | "chat" | "waiting" | "verdict";

export default function Home() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [matchElapsedMs, setMatchElapsedMs] = useState(0);
  const [matchWindowSec, setMatchWindowSec] = useState(10);
  const [gameId, setGameId] = useState<string | null>(null);
  const [opponentSource, setOpponentSource] =
    useState<OpponentSource | null>(null);
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
  const syncCursorRef = useRef(0);
  const matchJoinedAtRef = useRef(0);
  const mustJudgeRef = useRef(false);

  const utils = trpc.useUtils();
  const joinMut = trpc.game.joinMatch.useMutation();
  const pollMut = trpc.game.pollMatch.useMutation();
  const cancelMut = trpc.game.cancelMatch.useMutation();
  const chatMut = trpc.game.chat.useMutation();
  const finishMut = trpc.game.finish.useMutation();
  const pulseMut = trpc.game.pulse.useMutation();
  const pollAsyncRef = useRef(pollMut.mutateAsync);
  pollAsyncRef.current = pollMut.mutateAsync;
  const pulseAsyncRef = useRef(pulseMut.mutateAsync);
  pulseAsyncRef.current = pulseMut.mutateAsync;

  const showReveal = (r: GuessResult) => {
    setResult(r);
    setGuessOpen(false);
    setMustJudgeMode(false);
    mustJudgeRef.current = false;
    setJudgeDeadlineAt(null);
    setChatOver(true);
    setPhase("verdict");
    setShowVerdict(true);
  };

  const enterWaiting = (deadlineAt: number, message: string) => {
    setWaitDeadlineAt(deadlineAt);
    setWaitMessage(message);
    setWaitNow(Date.now());
    setGuessOpen(false);
    setChatOver(true);
    setPhase("waiting");
  };

  const enterMustJudge = (deadlineAt: number, sysMsgs?: ChatMessageView[]) => {
    setMustJudgeMode(true);
    mustJudgeRef.current = true;
    setJudgeDeadlineAt(deadlineAt);
    setChatOver(true);
    if (sysMsgs?.length) {
      setMessages((ms) => [...ms, ...sysMsgs]);
    } else {
      setMessages((ms) => {
        const tip = "对方已提交判断，请在 20 秒内做出你的判断";
        if (ms.some((m) => m.text.includes("对方已提交判断"))) return ms;
        return [...ms, { from: "system", text: tip }];
      });
    }
    setGuessOpen(true);
  };

  const enterChat = (r: {
    gameId: string;
    opener: string;
    timeLimitSec: number;
    opponentSource: OpponentSource;
  }) => {
    setGameId(r.gameId);
    setOpponentSource(r.opponentSource);
    syncCursorRef.current = 0;
    // Opener arrives later via pulse after a human-like delay.
    setMessages([{ from: "system", text: "已为你匹配一位匿名对话者" }]);
    setResult(null);
    setShowVerdict(false);
    setSessionLost(false);
    setChatOver(false);
    setGuessOpen(false);
    setMustJudgeMode(false);
    mustJudgeRef.current = false;
    setJudgeDeadlineAt(null);
    setJudgeSecondsLeft(null);
    setDeadline(Date.now() + r.timeLimitSec * 1000);
    setSecondsLeft(r.timeLimitSec);
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

  // Matchmaking poll
  useEffect(() => {
    if (phase !== "matching" || !ticketId) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
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
          return;
        }
        if (status.status === "matched") enterChat(status);
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 400);
    const localClock = window.setInterval(() => {
      if (matchJoinedAtRef.current) {
        setMatchElapsedMs(Date.now() - matchJoinedAtRef.current);
      }
    }, 100);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearInterval(localClock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ticketId]);

  const endChat = (sysMsg?: string) => {
    setChatOver(true);
    if (sysMsg) {
      setMessages((ms) => [...ms, { from: "system", text: sysMsg }]);
    }
    setGuessOpen(true);
  };

  // Chat countdown (normal game timer)
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

  // Judge response countdown (20s)
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

  // Pulse during chat + waiting
  useEffect(() => {
    if ((phase !== "chat" && phase !== "waiting") || !gameId) return;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await pulseAsyncRef.current({ gameId });
        if (stopped) return;
        if (!r.ok) {
          if (r.sessionLost && phase === "chat" && !mustJudgeRef.current) {
            setSessionLost(true);
            setChatOver(true);
          }
          return;
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
        // chat phase pulse
        if (r.systemMessages.length > 0) {
          setMessages((ms) => [...ms, ...r.systemMessages]);
        }
        if (r.opponentMessages?.length) {
          const incoming = r.opponentMessages;
          const delay = r.typingMs ?? 1500;
          window.setTimeout(() => {
            if (mustJudgeRef.current) return;
            setMessages((ms) => [...ms, ...incoming]);
          }, delay);
        }
        if (r.mustJudge && r.judgeDeadlineAt) {
          if (!mustJudgeRef.current) {
            enterMustJudge(r.judgeDeadlineAt);
          } else {
            setJudgeDeadlineAt(r.judgeDeadlineAt);
          }
        }
        if (r.chatLocked) {
          setChatOver(true);
        }
      } catch {
        /* ignore */
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), 600);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameId]);

  // PvP message sync
  useEffect(() => {
    if (phase !== "chat" || !gameId || opponentSource !== "player") return;
    let stopped = false;
    const pull = async () => {
      if (stopped) return;
      try {
        const r = await utils.game.sync.fetch({
          gameId,
          cursor: syncCursorRef.current,
        });
        if (stopped) return;
        if (!r.ok) {
          if (r.sessionLost || r.opponentLeft) {
            setSessionLost(true);
            setChatOver(true);
            setMessages((ms) => [
              ...ms,
              { from: "system", text: "连接中断，对方已离开" },
            ]);
          } else if (r.expired && !mustJudgeRef.current) {
            endChat("时间到，请做出你的判断");
          }
          return;
        }
        if (r.messages.length > 0) {
          setMessages((ms) => [...ms, ...r.messages]);
        }
        syncCursorRef.current = r.cursor;
        if (r.mustJudge && r.judgeDeadlineAt && !mustJudgeRef.current) {
          enterMustJudge(r.judgeDeadlineAt);
        } else if (r.chatLocked) {
          setChatOver(true);
        } else if (r.expired && !mustJudgeRef.current && !chatOver) {
          endChat("时间到，请做出你的判断");
        }
      } catch {
        /* ignore */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 700);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameId, opponentSource]);

  const send = (text: string) => {
    if (!gameId || chatOver || mustJudgeMode) return;
    setMessages((ms) => [...ms, { from: "player", text }]);

    chatMut.mutate(
      { gameId, text },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            if (r.opponentJudged && r.judgeDeadlineAt) {
              enterMustJudge(r.judgeDeadlineAt);
              return;
            }
            if (r.chatLocked) {
              setChatOver(true);
              return;
            }
            if (r.sessionLost) {
              setSessionLost(true);
              setChatOver(true);
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

          if (r.pending) {
            if (r.limitReached) {
              window.setTimeout(
                () => endChat("消息条数已用尽，请做出判断"),
                600,
              );
            }
            return;
          }

          const delay = r.typingMs ?? 1500;
          window.setTimeout(() => {
            if (mustJudgeRef.current) return;
            setMessages((ms) => [
              ...ms,
              { from: "opponent", text: r.reply ?? "" },
            ]);
            if (r.limitReached) {
              window.setTimeout(() => endChat("对方有事要忙，先离开了"), 900);
            }
          }, delay);
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
        <IntroScreen
          starting={joinMut.isPending}
          onStart={startMatch}
        />
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
          // Allow reviewing history even in must-judge mode.
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
