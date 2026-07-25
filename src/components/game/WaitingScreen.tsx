import { JUDGE_RESPONSE_SEC } from "@contracts/types";

interface Props {
  message: string;
  /** Absolute timestamp when we expect the opponent to finish. */
  deadlineAt: number;
  now?: number;
}

export default function WaitingScreen({
  message,
  deadlineAt,
  now = Date.now(),
}: Props) {
  const leftMs = Math.max(0, deadlineAt - now);
  const leftSec = Math.ceil(leftMs / 1000);
  const windowMs = JUDGE_RESPONSE_SEC * 1000;
  const progress = 1 - Math.min(1, leftMs / windowMs);

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] font-sans-x flex flex-col">
      <header className="border-b border-[var(--hairline)]">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center justify-between">
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase">
            Turing Test
          </span>
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase text-[var(--faint)]">
            Holding
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-2xl mx-auto px-5 w-full">
          <p className="font-mono-x text-[11px] tracking-[0.35em] uppercase text-[var(--faint)]">
            Judgment Pending
          </p>
          <h1 className="mt-4 text-[clamp(2.2rem,7vw,3.4rem)] leading-none font-bold tracking-tight">
            等待对方判断
          </h1>
          <p className="mt-5 text-sm leading-relaxed text-neutral-500 max-w-md">
            {message || "你已提交答案。系统已锁定对话，正在等待另一方完成判断。"}
          </p>

          <div className="mt-12">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-mono-x text-4xl tracking-tight tabular-nums">
                {leftSec}
                <span className="text-base text-[var(--faint)] ml-2">sec</span>
              </span>
              <span className="font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--faint)] flex items-center gap-2">
                <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--ink)]" />
                通道静默
              </span>
            </div>
            <div className="mt-4 h-[2px] bg-[var(--hairline)] overflow-hidden">
              <div
                className="h-full bg-[var(--ink)] transition-[width] duration-200 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <p className="mt-4 font-mono-x text-[11px] tracking-[0.15em] uppercase text-[var(--faint)]">
              双方均结束后公布答案
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
