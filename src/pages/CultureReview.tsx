import { useState } from "react";
import type { CultureReviewItem } from "@contracts/types";
import { trpc } from "@/providers/trpcClient";

const SCORE_LABELS: Array<[keyof CultureReviewItem["scores"], string, number]> =
  [
    ["safety", "安全", 25],
    ["privacy", "隐私", 20],
    ["generality", "泛化", 15],
    ["fun", "趣味", 20],
    ["evidence", "证据", 10],
    ["novelty", "新颖", 10],
  ];

function isAdminAuthError(
  error: { data?: { code?: string } | null } | null | undefined
): boolean {
  return (
    error?.data?.code === "UNAUTHORIZED" ||
    error?.data?.code === "FORBIDDEN" ||
    error?.data?.code === "NOT_FOUND"
  );
}

function ReviewCard({
  item,
  onChanged,
  onSessionExpired,
}: {
  item: CultureReviewItem;
  onChanged: () => void;
  onSessionExpired: () => void;
}) {
  const [phrase, setPhrase] = useState(item.phrase);
  const [allowAsOpener, setAllowAsOpener] = useState(false);
  const [message, setMessage] = useState("");
  const approve = trpc.cultureReview.approve.useMutation({
    onSuccess(data) {
      setMessage(
        `已批准为${data.origin === "curated" ? "人工策划" : "真人学习"}记忆`
      );
      onChanged();
    },
    onError(error) {
      if (isAdminAuthError(error)) {
        onSessionExpired();
        return;
      }
      setMessage(error.message);
    },
  });
  const reject = trpc.cultureReview.reject.useMutation({
    onSuccess() {
      setMessage("已拒绝并清除候选原文");
      onChanged();
    },
    onError(error) {
      if (isAdminAuthError(error)) {
        onSessionExpired();
        return;
      }
      setMessage(error.message);
    },
  });
  const busy = approve.isPending || reject.isPending;

  const submitApproval = () => {
    const next = phrase.trim();
    if (!next) return;
    setMessage("");
    approve.mutate({
      fingerprint: item.fingerprint,
      editedPhrase: next === item.phrase ? undefined : next,
      allowAsOpener,
    });
  };

  const submitRejection = () => {
    if (!window.confirm("确认拒绝？候选原文将被清除，并在抑制期内不再出现。")) {
      return;
    }
    setMessage("");
    reject.mutate({ fingerprint: item.fingerprint });
  };

  return (
    <article className="border border-[var(--hairline)] bg-white p-5 text-left">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono-x text-[10px] uppercase tracking-[0.18em] text-[var(--faint)]">
            {item.supportCount} 个独立来源 ·{" "}
            {new Date(item.aiReviewedAt).toLocaleString("zh-CN")}
          </p>
          <p className="mt-2 text-sm text-neutral-600">
            AI 建议：{item.aiReason}
          </p>
        </div>
        <div className="font-mono-x text-2xl font-bold">
          {item.scores.total}
          <span className="ml-1 text-xs font-normal text-[var(--faint)]">
            /100
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-px bg-[var(--hairline)] sm:grid-cols-6">
        {SCORE_LABELS.map(([key, label, max]) => (
          <div key={key} className="bg-white px-2 py-3 text-center">
            <div className="font-mono-x text-sm font-semibold">
              {item.scores[key]}/{max}
            </div>
            <div className="mt-1 text-[10px] text-[var(--faint)]">{label}</div>
          </div>
        ))}
      </div>

      {item.flags.filter(flag => flag !== "none").length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.flags
            .filter(flag => flag !== "none")
            .map(flag => (
              <span
                key={flag}
                className="bg-amber-50 px-2 py-1 font-mono-x text-[10px] text-amber-800"
              >
                {flag}
              </span>
            ))}
        </div>
      )}

      <label className="mt-5 block">
        <span className="font-mono-x text-[10px] uppercase tracking-[0.15em] text-[var(--faint)]">
          批准内容（可修改）
        </span>
        <textarea
          value={phrase}
          onChange={event => setPhrase(event.target.value)}
          maxLength={64}
          rows={3}
          className="mt-2 w-full resize-y border border-[var(--hairline)] bg-[var(--bubble)] px-3 py-3 text-sm outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label
        className={`mt-3 flex items-center gap-2 text-xs ${
          item.openerCandidate ? "" : "text-[var(--faint)]"
        }`}
      >
        <input
          type="checkbox"
          checked={allowAsOpener}
          disabled={!item.openerCandidate}
          onChange={event => setAllowAsOpener(event.target.checked)}
        />
        允许作为搞怪开场白
        {!item.openerCandidate && "（尚未满足来源数或形态要求）"}
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || phrase.trim().length < 3}
          onClick={submitApproval}
          className="bg-[var(--ink)] px-5 py-2 font-mono-x text-xs text-white disabled:opacity-40"
        >
          {approve.isPending ? "复审中…" : "批准"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={submitRejection}
          className="border border-red-200 px-5 py-2 font-mono-x text-xs text-red-700 disabled:opacity-40"
        >
          拒绝
        </button>
        {message && <span className="text-xs text-neutral-600">{message}</span>}
      </div>
    </article>
  );
}

export default function CultureReview() {
  const utils = trpc.useUtils();
  const session = trpc.cultureReview.session.useQuery(undefined, {
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
  });
  const hasSession = session.isSuccess && !session.error;
  const report = trpc.cultureReview.report.useQuery(undefined, {
    enabled: hasSession,
    retry: false,
  });
  const authorized = hasSession && !isAdminAuthError(report.error);
  const retryReview = trpc.cultureReview.retryAiReview.useMutation({
    onSuccess(data) {
      utils.cultureReview.report.setData(undefined, data);
    },
    onError(error) {
      if (isAdminAuthError(error)) reconnect();
    },
  });

  function reconnect() {
    void utils.cultureReview.report.reset();
    void session.refetch();
  }

  if (session.isPending) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-6">
        <p className="font-mono-x text-xs text-[var(--faint)]">
          正在通过本机代理连接 Render 审核区…
        </p>
      </main>
    );
  }

  if (session.isError || isAdminAuthError(report.error) || !authorized) {
    const error = session.error ?? report.error;
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
        <section className="w-full border border-[var(--hairline)] bg-white p-8 text-left">
          <p className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-[var(--faint)]">
            Local companion only
          </p>
          <h1 className="mt-3 text-2xl font-semibold">本机管理员连接失败</h1>
          <p className="mt-3 text-sm leading-6 text-neutral-500">
            Render 免费服务可能正在从休眠中唤醒，请等待约一分钟后重试。
            如果仍失败，请检查本机
            <code className="mx-1">.env.admin.local</code>
            中的 Render 地址和密钥是否与 Render 环境变量一致。
          </p>
          <button
            type="button"
            disabled={session.isFetching}
            onClick={reconnect}
            className="mt-3 w-full bg-[var(--ink)] py-3 font-mono-x text-xs text-white disabled:opacity-40"
          >
            {session.isFetching ? "重新连接中…" : "重新连接"}
          </button>
          {error && (
            <p className="mt-4 text-sm text-red-700">{error.message}</p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-5 py-10 text-left sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-5 border-b border-[var(--hairline)] pb-6">
        <div>
          <p className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-[var(--faint)]">
            Local-only culture report
          </p>
          <h1 className="mt-2 text-3xl font-semibold">AI 每日学习报告</h1>
          <p className="mt-2 text-sm text-neutral-500">
            未经你批准的内容不会进入正式记忆。
          </p>
        </div>
        <span className="font-mono-x text-xs text-[var(--faint)]">
          127.0.0.1 · 本机管理员
        </span>
      </header>

      {(report.isLoading || report.isFetching) && (
        <p className="py-16 text-center text-sm text-[var(--faint)]">
          正在读取隔离审核区…
        </p>
      )}

      {report.error && (
        <section className="mt-8 border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          {report.error.message}
        </section>
      )}

      {authorized && report.data && !report.error && (
        <>
          <section className="my-6 grid grid-cols-3 gap-px bg-[var(--hairline)]">
            {[
              ["待你审核", report.data.pendingCount],
              ["待 AI 重试", report.data.awaitingAiCount],
              ["24h 自动废弃", report.data.rejectedLast24h],
            ].map(([label, value]) => (
              <div key={label} className="bg-white px-3 py-5 text-center">
                <div className="font-mono-x text-2xl font-bold">{value}</div>
                <div className="mt-1 text-[10px] text-[var(--faint)]">
                  {label}
                </div>
              </div>
            ))}
          </section>

          {report.data.awaitingAiCount > 0 && (
            <div className="mb-6 flex items-center justify-between gap-4 border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
              <span>部分候选因模型暂不可用而保持隔离，尚未进入报告。</span>
              <button
                type="button"
                disabled={retryReview.isPending}
                onClick={() => retryReview.mutate({ limit: 10 })}
                className="shrink-0 border border-amber-400 px-3 py-2 font-mono-x disabled:opacity-40"
              >
                {retryReview.isPending ? "审查中…" : "重试 AI 审查"}
              </button>
            </div>
          )}

          <section className="space-y-4">
            {report.data.items.map(item => (
              <ReviewCard
                key={item.fingerprint}
                item={item}
                onSessionExpired={reconnect}
                onChanged={() => {
                  void report.refetch();
                }}
              />
            ))}
          </section>

          {report.data.items.length === 0 && (
            <div className="border border-dashed border-[var(--hairline)] py-20 text-center">
              <p className="text-sm text-neutral-500">今天没有待审核内容</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
