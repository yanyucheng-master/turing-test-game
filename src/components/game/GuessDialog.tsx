import type { GuessChoice } from "@contracts/types";

interface Props {
  open: boolean;
  submitting: boolean;
  onGuess: (choice: GuessChoice) => void;
  onClose: () => void;
}

export default function GuessDialog({
  open,
  submitting,
  onGuess,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center px-5">
      <div className="bg-white border-2 border-[var(--ink)] shadow-[6px_6px_0_rgba(13,13,13,0.9)] w-full max-w-sm p-8">
        <p className="font-mono-x text-[11px] tracking-[0.3em] uppercase text-[var(--faint)]">
          Final Answer
        </p>
        <h2 className="mt-3 text-2xl font-bold font-sans-x text-[var(--ink)]">
          做出你的判断
        </h2>
        <p className="mt-2 text-sm text-neutral-500 font-sans-x">
          对方可能已提交判断。和你聊了这么久的对象，究竟是……
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <button
            onClick={() => onGuess("human")}
            disabled={submitting}
            className="border border-[var(--ink)] py-3.5 font-mono-x text-sm tracking-[0.25em] uppercase transition-colors hover:bg-[var(--ink)] hover:text-white disabled:opacity-40"
          >
            真人 · Human
          </button>
          <button
            onClick={() => onGuess("ai")}
            disabled={submitting}
            className="border border-[var(--ink)] py-3.5 font-mono-x text-sm tracking-[0.25em] uppercase transition-colors hover:bg-[var(--ink)] hover:text-white disabled:opacity-40"
          >
            人工智能 · AI
          </button>
        </div>

        <button
          onClick={onClose}
          disabled={submitting}
          className="mt-6 font-mono-x text-[11px] tracking-[0.2em] uppercase text-[var(--faint)] underline underline-offset-4 hover:text-[var(--ink)] transition-colors"
        >
          再想想，回去看看聊天记录
        </button>
      </div>
    </div>
  );
}
