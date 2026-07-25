import { MATCH_WINDOW_SEC } from "@contracts/types";

interface Props {
  elapsedMs: number;
  matchWindowSec?: number;
  onCancel: () => void;
}

export default function MatchingScreen({
  elapsedMs,
  matchWindowSec = MATCH_WINDOW_SEC,
  onCancel,
}: Props) {
  const windowMs = matchWindowSec * 1000;
  const progress = Math.min(1, elapsedMs / windowMs);
  const sec = Math.min(matchWindowSec, elapsedMs / 1000);
  const display = sec.toFixed(1);

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] font-sans-x flex flex-col">
      <header className="border-b border-[var(--hairline)]">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center justify-between">
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase">
            Turing Test
          </span>
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase text-[var(--faint)]">
            Matching
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-2xl mx-auto px-5 w-full">
          <p className="font-mono-x text-[11px] tracking-[0.35em] uppercase text-[var(--faint)]">
            Secure Channel
          </p>
          <h1 className="mt-4 text-[clamp(2.4rem,8vw,3.8rem)] leading-none font-bold tracking-tight">
            正在匹配
          </h1>

          <div className="mt-12">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-mono-x text-4xl tracking-tight tabular-nums">
                {display}
                <span className="text-base text-[var(--faint)] ml-2">
                  / {matchWindowSec}.0s
                </span>
              </span>
              <span className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--faint)] flex items-center gap-2">
                <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--ink)]" />
                搜寻对手
              </span>
            </div>

            <div className="mt-4 h-[2px] bg-[var(--hairline)] overflow-hidden">
              <div
                className="h-full bg-[var(--ink)] transition-[width] duration-200 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>

          <button
            onClick={onCancel}
            className="mt-12 font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--faint)] underline underline-offset-4 hover:text-[var(--ink)] transition-colors"
          >
            取消匹配
          </button>
        </div>
      </main>
    </div>
  );
}
