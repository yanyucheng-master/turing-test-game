import type { GuessChoice, GuessResult } from "@contracts/types";

interface Props {
  result: GuessResult;
  onRestart: () => void;
  onReview: () => void;
}

function label(choice: GuessChoice | null, timedOut?: boolean): string {
  if (timedOut) return "超时未判";
  if (!choice) return "—";
  return choice === "ai" ? "AI" : "真人";
}

export default function VerdictScreen({
  result,
  onRestart,
  onReview,
}: Props) {
  const isAi = result.truth === "ai";
  const totalMessages = result.playerMessages + result.opponentMessages;
  const vsPlayer = result.opponentSource === "player";

  const outcomeLine = result.timedOut
    ? "✗ 超时判负"
    : result.correct
      ? "✓ 你猜对了"
      : "✗ 你猜错了";

  const stats: { label: string; value: string }[] = [
    { label: "你的判断", value: label(result.myGuess, result.timedOut) },
    {
      label: vsPlayer ? "对方判断" : "AI 对你的判断",
      value: label(result.opponentGuess, result.opponentTimedOut),
    },
    { label: "真实身份", value: isAi ? "AI" : "真人" },
    { label: "对话消息", value: `${totalMessages} 条` },
  ];

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col transition-colors duration-500 ${
        isAi ? "bg-[var(--ink)] text-white" : "bg-[var(--paper)] text-[var(--ink)]"
      }`}
    >
      <header
        className={`border-b ${isAi ? "border-white/15" : "border-[var(--hairline)]"}`}
      >
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center justify-between">
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase">
            Verdict
          </span>
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase opacity-50">
            Turing Test
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-2xl mx-auto px-5 w-full">
          <p className="font-mono-x text-[11px] tracking-[0.35em] uppercase opacity-50">
            判定结果
          </p>
          <h1 className="mt-4 text-[clamp(2.6rem,9vw,4.5rem)] leading-none font-bold font-sans-x tracking-tight">
            对方是{" "}
            <span className="text-[var(--accent)]">{isAi ? "AI" : "真人"}</span>
          </h1>
          <p className="mt-5 font-mono-x text-sm tracking-[0.2em] uppercase">
            <span
              className={
                result.correct && !result.timedOut
                  ? "text-[var(--accent)]"
                  : isAi
                    ? "text-white/70"
                    : "text-neutral-500"
              }
            >
              {outcomeLine}
            </span>
          </p>
          <p
            className={`mt-6 text-sm leading-relaxed max-w-md font-sans-x ${
              isAi ? "text-white/60" : "text-neutral-500"
            }`}
          >
            {result.timedOut
              ? "对方已提交判断后，你未能在限定时间内作答，本局判负。"
              : isAi
                ? "对方由大模型实时驱动。即便语气再像真人，正确答案也是 AI。"
                : "这一次，你对话的是另一位匿名测试者。屏幕两端，都是真实的人。"}
          </p>

          <div
            className={`mt-12 grid grid-cols-2 sm:grid-cols-4 border-t ${
              isAi ? "border-white/15" : "border-[var(--hairline)]"
            }`}
          >
            {stats.map((s) => (
              <div
                key={s.label}
                className={`py-4 pr-4 border-b sm:border-b-0 ${
                  isAi ? "border-white/15" : "border-[var(--hairline)]"
                }`}
              >
                <p className="font-mono-x text-[10px] tracking-[0.25em] uppercase opacity-50">
                  {s.label}
                </p>
                <p className="mt-1.5 font-mono-x text-sm">{s.value}</p>
              </div>
            ))}
          </div>

          <p
            className={`mt-6 font-mono-x text-[11px] tracking-[0.15em] uppercase ${
              isAi ? "text-white/40" : "text-[var(--faint)]"
            }`}
          >
            全网正确率 {result.stats.correctRate}% · {result.stats.totalGames} 局
          </p>

          <div className="mt-10 flex items-center gap-6">
            <button
              onClick={onRestart}
              className={`border px-8 py-3 font-mono-x text-sm tracking-[0.2em] uppercase transition-colors ${
                isAi
                  ? "border-white hover:bg-white hover:text-[var(--ink)]"
                  : "border-[var(--ink)] hover:bg-[var(--ink)] hover:text-white"
              }`}
            >
              再来一局
            </button>
            <button
              onClick={onReview}
              className="font-mono-x text-[11px] tracking-[0.2em] uppercase underline underline-offset-4 opacity-60 hover:opacity-100 transition-opacity"
            >
              回顾对话
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
