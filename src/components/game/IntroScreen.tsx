interface Props {
  starting: boolean;
  onStart: () => void;
}

const RULES = [
  {
    no: "01",
    title: "自由对话",
    desc: "与匹配到的对象聊 2 分钟，话题不限",
  },
  {
    no: "02",
    title: "观察细节",
    desc: "对方可能是真人，也可能是人工智能",
  },
  {
    no: "03",
    title: "做出判断",
    desc: "时间一到，写下你的答案：真人，还是 AI",
  },
];

export default function IntroScreen({ starting, onStart }: Props) {
  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)] font-sans-x flex flex-col">
      <header className="border-b border-[var(--hairline)]">
        <div className="max-w-2xl mx-auto px-5 h-12 flex items-center justify-between">
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase">
            Turing Test
          </span>
          <span className="font-mono-x text-[11px] tracking-[0.25em] uppercase text-[var(--faint)]">
            Est. 1950
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center">
        <div className="max-w-2xl mx-auto px-5 py-16 w-full">
          <p className="font-mono-x text-[11px] tracking-[0.35em] uppercase text-[var(--faint)]">
            The Imitation Game
          </p>
          <h1 className="mt-4 text-[clamp(3.2rem,11vw,6rem)] leading-none font-bold tracking-tight">
            图灵测试
          </h1>
          <p className="mt-6 text-sm leading-relaxed text-neutral-500 max-w-md">
            “我提议考虑这样一个问题：机器能思考吗？”
            <span className="block mt-1 font-mono-x text-[11px] tracking-[0.15em] uppercase">
              —— Alan M. Turing, 1950
            </span>
          </p>

          <div className="mt-12">
            {RULES.map((r) => (
              <div
                key={r.no}
                className="flex items-baseline gap-5 py-4 border-t border-[var(--hairline)] last:border-b"
              >
                <span className="font-mono-x text-xs text-[var(--faint)]">
                  {r.no}
                </span>
                <span className="font-semibold w-20 shrink-0">{r.title}</span>
                <span className="text-sm text-neutral-500">{r.desc}</span>
              </div>
            ))}
          </div>

          <p className="mt-5 max-w-lg font-mono-x text-[10px] leading-relaxed tracking-[0.08em] text-[var(--faint)]">
            隐私说明：玩家在真人或 AI 对局中的表达只有在通过安全过滤，
            并被多个独立来源重复后，才会送至所配置的 AI
            服务并进入隔离审核区；达到评分门槛且经所有者批准后，才可能用于改进
            AI。达到重复门槛前只保存不可逆指纹，不保存聊天原文。
          </p>

          <div className="mt-12">
            <button
              onClick={onStart}
              disabled={starting}
              className="group inline-flex items-center gap-3 border border-[var(--ink)] px-8 py-3 font-mono-x text-sm tracking-[0.2em] uppercase transition-colors hover:bg-[var(--ink)] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {starting ? "匹配中…" : "开始测试"}
              {!starting && (
                <span className="transition-transform group-hover:translate-x-1">
                  →
                </span>
              )}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
