import { useEffect, useRef, useState } from "react";
import type { ChatMessageView, GuessChoice } from "@contracts/types";

interface Props {
  messages: ChatMessageView[];
  secondsLeft: number;
  inputDisabled: boolean;
  truth: GuessChoice | null;
  /** When opponent already judged — force answer countdown. */
  judgeSecondsLeft?: number | null;
  onSend: (text: string) => void;
  onEndEarly: () => void;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function ChatScreen({
  messages,
  secondsLeft,
  inputDisabled,
  truth,
  judgeSecondsLeft,
  onSend,
  onEndEarly,
}: Props) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || inputDisabled) return;
    onSend(text);
    setDraft("");
    inputRef.current?.focus();
  };

  const urgent = secondsLeft <= 30;
  const judging =
    typeof judgeSecondsLeft === "number" && judgeSecondsLeft >= 0 && !truth;

  return (
    <div className="h-screen bg-[var(--paper)] text-[var(--ink)] font-sans-x flex flex-col">
      {/* header */}
      <header className="border-b border-[var(--hairline)] shrink-0">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center justify-between">
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase">
            Turing Test
          </span>
          {truth ? (
            <span className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--accent)]">
              已揭晓 · 对方是{truth === "ai" ? " AI" : "真人"}
            </span>
          ) : judging ? (
            <span className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--accent)]">
              请在 {judgeSecondsLeft}s 内判断
            </span>
          ) : (
            <span className="flex items-center gap-2 font-mono-x text-[11px] tracking-[0.2em] uppercase">
              <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--ink)]" />
              对方在线
            </span>
          )}
          <span
            className={`font-mono-x text-sm ${
              (urgent || judging) && !truth ? "text-[var(--accent)]" : ""
            }`}
          >
            {judging ? fmt(judgeSecondsLeft!) : fmt(secondsLeft)}
          </span>
        </div>
      </header>

      {/* messages */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-6 flex flex-col gap-3">
          {messages.map((m, i) => {
            if (m.from === "system") {
              return (
                <p
                  key={i}
                  className="msg-in self-center font-mono-x text-[10px] tracking-[0.25em] uppercase text-[var(--faint)] py-2"
                >
                  {m.text}
                </p>
              );
            }
            const mine = m.from === "player";
            return (
              <div
                key={i}
                className={`msg-in max-w-[80%] px-4 py-2.5 text-[15px] leading-relaxed rounded-[4px] whitespace-pre-wrap break-words ${
                  mine
                    ? "self-end bg-[var(--ink)] text-white"
                    : "self-start bg-[var(--bubble)] text-[var(--ink)]"
                }`}
              >
                {m.text}
              </div>
            );
          })}

          <div ref={bottomRef} />
        </div>
      </main>

      {/* input */}
      <footer className="border-t border-[var(--hairline)] shrink-0">
        <div className="max-w-2xl mx-auto px-5 py-3">
          {!truth && !judging && (
            <div className="flex justify-end pb-2">
              <button
                onClick={onEndEarly}
                className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--faint)] underline underline-offset-4 hover:text-[var(--ink)] transition-colors"
              >
                提前结束并判断 →
              </button>
            </div>
          )}
          {judging && (
            <div className="flex justify-between items-center pb-2 gap-3">
              <p className="font-mono-x text-[10px] tracking-[0.15em] uppercase text-[var(--accent)]">
                可回顾记录 · 无法发送
              </p>
              <button
                onClick={onEndEarly}
                className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--accent)] underline underline-offset-4"
              >
                立即判断 →
              </button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              disabled={inputDisabled || judging}
              maxLength={500}
              placeholder={
                judging
                  ? "对方已提交，请做出判断"
                  : inputDisabled
                    ? "对话已结束"
                    : "输入消息，回车发送…"
              }
              className="flex-1 bg-transparent font-sans-x text-[15px] py-2.5 outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
            />
            <button
              onClick={submit}
              disabled={inputDisabled || !draft.trim()}
              aria-label="发送"
              className="w-10 h-10 shrink-0 bg-[var(--ink)] flex items-center justify-center transition-colors hover:bg-[var(--accent)] disabled:opacity-30 disabled:hover:bg-[var(--ink)]"
            >
              <span className="tri-right ml-0.5" />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
