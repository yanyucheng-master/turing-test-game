import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type {
  CultureResponseMode,
  CultureReviewItem,
  CultureReviewReport,
} from "@contracts/types";
import {
  cultureCandidates,
  cultureObservations,
  type CultureCandidate,
} from "@db/schema";
import { env, hasDatabase } from "../lib/env";
import { getDb } from "../queries/connection";
import {
  cultureEvidenceScore,
  reviewCultureCandidate,
  type CultureReviewDecision,
} from "./cultureReviewer";

export interface CultureCue {
  candidateFingerprint: string;
  phrase: string;
  responseMode: CultureResponseMode;
  supportCount: number;
  openerEligible: boolean;
  origin: "learned" | "curated";
  promotedAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface PreparedPhrase {
  display: string;
  canonical: string;
  fingerprint: string;
}

interface CandidateState {
  fingerprint: string;
  phraseSources: Set<string>;
  reactionModes: Map<string, CultureResponseMode>;
  persistedSupportCount: number;
  persistedResponseMode: CultureResponseMode;
  status: CultureCandidateStatus;
  reviewPhrase: string | null;
  review: CultureReviewDecision | null;
  aiReviewedAt: number | null;
  humanReviewedAt: number | null;
  approvedFingerprint: string | null;
  origin: "learned" | "curated" | null;
  rejectionReason: CultureRejectionReason | null;
  firstSeenAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

type CultureCandidateStatus =
  | "candidate"
  | "pending_ai_review"
  | "pending_review"
  | "active"
  | "rejected"
  | "expired";

type CultureRejectionReason = "ai_hard_reject" | "ai_score" | "human_reject";

export interface CultureObservationResult {
  accepted: boolean;
  promoted: boolean;
  supportCount: number;
  reason?:
    | "unsafe_or_generic"
    | "source_unavailable"
    | "duplicate_source"
    | "pending_ai_review"
    | "pending_owner_review"
    | "rejected";
}

export const CULTURE_MIN_DISTINCT_SOURCES = 3;
export const CULTURE_OPENER_MIN_SOURCES = 5;
export const CULTURE_REVIEW_MIN_SCORE = 60;
export const CULTURE_CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const CULTURE_REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CULTURE_ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_CANDIDATES = 2_000;
const MAX_ACTIVE = 200;
const MAX_REVIEW_RETRIES_PER_REQUEST = 20;
const runtimeSalt = randomBytes(32).toString("hex");
const candidates = new Map<string, CandidateState>();
const active = new Map<string, CultureCue>();
const reviewPromises = new Map<string, Promise<void>>();
let initializePromise: Promise<void> | null = null;
let persistenceDisabledForTests = false;

const GENERIC_CANONICAL = new Set(
  [
    "你好",
    "您好",
    "嗨",
    "哈喽",
    "hello",
    "hi",
    "在吗",
    "在",
    "有人吗",
    "你是谁",
    "你是ai吗",
    "你是真人吗",
    "哈哈",
    "哈哈哈",
    "笑死",
    "真的假的",
    "然后呢",
    "什么意思",
    "啥意思",
    "不知道",
    "随便",
    "行吧",
    "好的",
    "嗯嗯",
    "谢谢",
  ].map(text => canonicalize(text))
);

const URL_OR_CONTACT =
  /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:微信|vx|v信|qq|扣扣|电话|手机|手机号|邮箱|联系我|加我)[：:\s]*[a-z0-9_-]{4,})/i;
const LONG_IDENTIFIER = /(?:\b1[3-9]\d{9}\b|\b\d{7,}\b|\b\d{17}[\dxX]\b)/;
const PRIVATE_OR_SECRET =
  /(?:身份证|住址|家庭住址|我叫[\u4e00-\u9fff]{2,4}|真实姓名|银行卡|验证码|密码|密钥|api[\s_-]*key|access[\s_-]*token|secret|sk-[a-z0-9]{8,})/i;
const PROMPT_INJECTION =
  /(?:忽略.{0,12}(?:指令|提示|规则)|系统提示词|开发者消息|system\s*prompt|developer\s*message|assistant\s*:|system\s*:|<\|(?:system|assistant|developer)\|>|```)/i;
const HIGH_RISK_CONTENT =
  /(?:裸照|约炮|强奸|性侵|自杀教程|杀人教程|炸弹制作|制毒|儿童色情|纳粹|种族灭绝)/i;

function canonicalize(text: string): string {
  return stripInvisible(text)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "")
    .replace(/[，。！？!?、,.;；:：'"“”‘’（）()[\]{}《》<>~～…·]/g, "");
}

function sanitizeDisplay(text: string): string {
  return stripInvisible(text).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stripInvisible(text: string): string {
  return Array.from(text)
    .filter(char => {
      const code = char.codePointAt(0) ?? 0;
      return !(
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        code === 0x2060 ||
        code === 0xfeff
      );
    })
    .join("");
}

function isSafeText(display: string): boolean {
  if (URL_OR_CONTACT.test(display)) return false;
  if (LONG_IDENTIFIER.test(display)) return false;
  if (PRIVATE_OR_SECRET.test(display)) return false;
  if (PROMPT_INJECTION.test(display)) return false;
  if (HIGH_RISK_CONTENT.test(display)) return false;
  return true;
}

function preparePhrase(text: string): PreparedPhrase | null {
  const display = sanitizeDisplay(text);
  const length = Array.from(display).length;
  if (length < 3 || length > 64) return null;
  if (!isSafeText(display)) return null;

  const canonical = canonicalize(display);
  if (Array.from(canonical).length < 3) return null;
  if (GENERIC_CANONICAL.has(canonical)) return null;
  if (!/[\p{L}\p{N}]/u.test(canonical)) return null;

  return {
    display,
    canonical,
    fingerprint: sha256(canonical),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFingerprint(
  sourceId: string,
  phraseFingerprint: string
): string | null {
  const clean = sourceId.trim();
  if (!clean || clean === "unknown") return null;
  const salt = env.cultureLearningSalt.trim() || runtimeSalt;
  // Scope the contributor hash to one candidate so observations cannot be
  // joined into a cross-phrase user profile.
  return createHmac("sha256", salt)
    .update(`${phraseFingerprint}:${clean}`)
    .digest("hex");
}

function persistenceEnabled(): boolean {
  return (
    !persistenceDisabledForTests &&
    hasDatabase() &&
    Boolean(env.cultureLearningSalt.trim())
  );
}

function candidateFor(fingerprint: string, now: number): CandidateState {
  let candidate = candidates.get(fingerprint);
  if (!candidate) {
    candidate = {
      fingerprint,
      phraseSources: new Set(),
      reactionModes: new Map(),
      persistedSupportCount: 0,
      persistedResponseMode: "play_along",
      status: "candidate",
      reviewPhrase: null,
      review: null,
      aiReviewedAt: null,
      humanReviewedAt: null,
      approvedFingerprint: null,
      origin: null,
      rejectionReason: null,
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt: now + CULTURE_CANDIDATE_TTL_MS,
    };
    candidates.set(fingerprint, candidate);
  }
  if (candidate.status === "rejected") return candidate;
  candidate.lastSeenAt = now;
  if (candidate.status === "candidate") {
    candidate.expiresAt = now + CULTURE_CANDIDATE_TTL_MS;
  } else if (
    candidate.status === "pending_ai_review" ||
    candidate.status === "pending_review"
  ) {
    candidate.expiresAt = now + CULTURE_REVIEW_TTL_MS;
  }
  return candidate;
}

function winningResponseMode(candidate: CandidateState): CultureResponseMode {
  const counts: Record<CultureResponseMode, number> = {
    play_along: 0,
    react_only: 0,
    clarify_light: 0,
  };
  for (const mode of candidate.reactionModes.values()) counts[mode] += 1;
  const ranked = (
    Object.entries(counts) as Array<[CultureResponseMode, number]>
  ).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : candidate.persistedResponseMode;
}

function candidateSupportCount(candidate: CandidateState): number {
  return Math.max(
    candidate.persistedSupportCount,
    candidate.phraseSources.size
  );
}

function hasPlayfulShape(phrase: string): boolean {
  return (
    /(哈哈哈|啊啊啊|？？？|!!!|！！！|笑死|离谱|绝绝子|尊嘟假嘟|栓q|破防|绷不住|抽象|整活|逆天|发疯|精神状态|已读乱回|小丑竟是我|yyds|xswl|[😂🤣🤡😅🥲😭]+)/iu.test(
      phrase
    ) || /(.)\1{2,}/u.test(phrase)
  );
}

function openerEligible(phrase: string, supportCount: number): boolean {
  const length = Array.from(phrase).length;
  if (length > 28 || /[?？]/.test(phrase)) return false;
  return (
    supportCount >= CULTURE_OPENER_MIN_SOURCES &&
    (hasPlayfulShape(phrase) || supportCount >= 7)
  );
}

function promoteInMemory(
  prepared: PreparedPhrase,
  candidate: CandidateState,
  supportCount: number,
  now: number,
  options: {
    allowAsOpener: boolean;
    origin: "learned" | "curated";
  }
): CultureCue {
  const existing = active.get(
    candidate.approvedFingerprint ?? prepared.fingerprint
  );
  const cue: CultureCue = {
    candidateFingerprint: candidate.fingerprint,
    phrase: existing?.phrase ?? prepared.display,
    responseMode: winningResponseMode(candidate),
    supportCount: Math.max(existing?.supportCount ?? 0, supportCount),
    openerEligible:
      options.allowAsOpener &&
      openerEligible(
        existing?.phrase ?? prepared.display,
        Math.max(existing?.supportCount ?? 0, supportCount)
      ),
    origin: options.origin,
    promotedAt: existing?.promotedAt ?? now,
    lastSeenAt: now,
    expiresAt: now + CULTURE_ACTIVE_TTL_MS,
  };
  active.set(prepared.fingerprint, cue);
  pruneInMemory(now);
  return cue;
}

function pruneInMemory(now = Date.now()): void {
  for (const [fingerprint, candidate] of candidates) {
    if (candidate.expiresAt <= now && !active.has(fingerprint)) {
      candidates.delete(fingerprint);
    }
  }
  for (const [fingerprint, cue] of active) {
    if (cue.expiresAt <= now) active.delete(fingerprint);
  }
  while (candidates.size > MAX_CANDIDATES) {
    const oldest = [...candidates.entries()].sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    )[0];
    if (!oldest) break;
    candidates.delete(oldest[0]);
  }
  while (active.size > MAX_ACTIVE) {
    const oldest = [...active.entries()].sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    )[0];
    if (!oldest) break;
    active.delete(oldest[0]);
  }
}

function classifyHumanReaction(text: string): CultureResponseMode | null {
  const display = sanitizeDisplay(text);
  if (!display || !isSafeText(display)) return null;
  if (/(什么意思|啥意思|没懂|没看懂|你在说啥|[?？])/.test(display)) {
    return "clarify_light";
  }
  if (Array.from(display).length <= 8) return "react_only";
  return "play_along";
}

export async function observeCulturePhrase(input: {
  sourceId: string;
  text: string;
  now?: number;
}): Promise<CultureObservationResult> {
  await initializeCultureMemory();
  const prepared = preparePhrase(input.text);
  if (!prepared) {
    return {
      accepted: false,
      promoted: false,
      supportCount: 0,
      reason: "unsafe_or_generic",
    };
  }
  const source = sourceFingerprint(input.sourceId, prepared.fingerprint);
  if (!source) {
    return {
      accepted: false,
      promoted: false,
      supportCount: 0,
      reason: "source_unavailable",
    };
  }

  const now = input.now ?? Date.now();
  pruneInMemory(now);

  const existingCue = active.get(prepared.fingerprint);
  if (existingCue) {
    existingCue.lastSeenAt = now;
    existingCue.expiresAt = now + CULTURE_ACTIVE_TTL_MS;
    const approvedCandidate = candidates.get(existingCue.candidateFingerprint);
    if (approvedCandidate) {
      approvedCandidate.lastSeenAt = now;
      approvedCandidate.expiresAt = existingCue.expiresAt;
      await persistCandidateReviewState(approvedCandidate, existingCue);
    }
    return {
      accepted: true,
      promoted: true,
      supportCount: existingCue.supportCount,
    };
  }

  const candidate = candidateFor(prepared.fingerprint, now);
  if (candidate.status === "rejected") {
    return {
      accepted: false,
      promoted: false,
      supportCount: candidateSupportCount(candidate),
      reason: "rejected",
    };
  }

  const duplicate = candidate.phraseSources.has(source);
  candidate.phraseSources.add(source);

  if (persistenceEnabled()) {
    const persistedSupportCount = await persistPhraseObservation(
      prepared,
      source,
      candidate,
      now
    );
    candidate.persistedSupportCount = Math.max(
      candidate.persistedSupportCount,
      persistedSupportCount
    );
  }

  const supportCount = candidateSupportCount(candidate);
  if (candidate.review && candidate.status === "pending_review") {
    const evidence = cultureEvidenceScore(supportCount);
    const evidenceDelta = evidence - candidate.review.scores.evidence;
    candidate.review.scores.evidence = evidence;
    candidate.review.scores.total += evidenceDelta;
    await persistCandidateReviewState(candidate);
  }
  if (
    supportCount >= CULTURE_MIN_DISTINCT_SOURCES &&
    (candidate.status === "candidate" ||
      candidate.status === "pending_ai_review")
  ) {
    candidate.reviewPhrase ??= prepared.display;
    await ensureCandidateAiReview(candidate, now);
  }
  const finalStatus =
    candidates.get(candidate.fingerprint)?.status ?? candidate.status;

  return {
    accepted: true,
    promoted: false,
    supportCount,
    reason:
      finalStatus === "rejected"
        ? "rejected"
        : finalStatus === "pending_review"
          ? "pending_owner_review"
          : finalStatus === "pending_ai_review"
            ? "pending_ai_review"
            : duplicate
              ? "duplicate_source"
              : undefined,
  };
}

export async function observeCultureReaction(input: {
  sourceId: string;
  trigger: string;
  response: string;
  now?: number;
}): Promise<void> {
  await initializeCultureMemory();
  const trigger = preparePhrase(input.trigger);
  const mode = classifyHumanReaction(input.response);
  const source = trigger
    ? sourceFingerprint(input.sourceId, trigger.fingerprint)
    : null;
  if (!trigger || !mode || !source) return;

  const now = input.now ?? Date.now();
  const cue = active.get(trigger.fingerprint);
  const knownCandidate =
    candidates.get(trigger.fingerprint) ??
    (cue ? candidates.get(cue.candidateFingerprint) : undefined);
  // Reactions alone never create a new phrase candidate. This prevents an AI
  // sentence from entering memory merely because one player answered it.
  if (!knownCandidate && !cue) return;

  const candidate = knownCandidate ?? candidateFor(trigger.fingerprint, now);
  candidate.reactionModes.set(source, mode);
  candidate.persistedResponseMode = winningResponseMode(candidate);
  candidate.lastSeenAt = now;
  if (cue) {
    const updated: CultureCue = {
      ...cue,
      responseMode: winningResponseMode(candidate),
      lastSeenAt: now,
    };
    active.set(trigger.fingerprint, updated);
  }

  if (persistenceEnabled()) {
    const persistedMode = await persistReactionObservation(
      cue?.candidateFingerprint ?? trigger.fingerprint,
      source,
      mode,
      now
    );
    if (persistedMode) {
      candidate.persistedResponseMode = persistedMode;
      if (cue) {
        active.set(trigger.fingerprint, {
          ...cue,
          responseMode: persistedMode,
          lastSeenAt: now,
        });
      }
    }
  }
}

function ngrams(text: string): Set<string> {
  const chars = Array.from(text);
  if (chars.length < 2) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (ratio >= 0.72) return 0.9;
  }
  const aa = ngrams(a);
  const bb = ngrams(b);
  let overlap = 0;
  for (const gram of aa) if (bb.has(gram)) overlap += 1;
  return (2 * overlap) / Math.max(1, aa.size + bb.size);
}

function noveltyScore(canonical: string): number {
  let best = 0;
  for (const cue of active.values()) {
    best = Math.max(best, diceSimilarity(canonical, canonicalize(cue.phrase)));
  }
  if (best >= 0.9) return 0;
  if (best >= 0.72) return 3;
  if (best >= 0.55) return 7;
  return 10;
}

async function ensureCandidateAiReview(
  candidate: CandidateState,
  now: number,
  force = false
): Promise<void> {
  if (!candidate.reviewPhrase) return;
  if (
    candidate.status !== "candidate" &&
    candidate.status !== "pending_ai_review"
  ) {
    return;
  }
  if (
    !force &&
    candidate.status === "pending_ai_review" &&
    candidate.aiReviewedAt &&
    now - candidate.aiReviewedAt < 60 * 60 * 1000
  ) {
    return;
  }

  const running = reviewPromises.get(candidate.fingerprint);
  if (running) return running;

  const task = (async () => {
    candidate.status = "pending_ai_review";
    candidate.aiReviewedAt = now;
    candidate.expiresAt = now + CULTURE_REVIEW_TTL_MS;
    await persistCandidateReviewState(candidate);

    const prepared = preparePhrase(candidate.reviewPhrase ?? "");
    if (!prepared) {
      candidate.status = "rejected";
      candidate.reviewPhrase = null;
      candidate.rejectionReason = "ai_hard_reject";
      await persistCandidateReviewState(candidate);
      return;
    }

    const decision = await reviewCultureCandidate({
      phrase: prepared.display,
      supportCount: candidateSupportCount(candidate),
      noveltyScore: noveltyScore(prepared.canonical),
    });
    if (!decision) {
      // Fail closed: the raw phrase remains quarantined and is never visible
      // to gameplay. A later observation or owner retry can run review again.
      await persistCandidateReviewState(candidate);
      return;
    }

    candidate.review = decision;
    if (
      decision.hardReject ||
      decision.scores.total < CULTURE_REVIEW_MIN_SCORE
    ) {
      candidate.status = "rejected";
      candidate.reviewPhrase = null;
      candidate.rejectionReason = decision.hardReject
        ? "ai_hard_reject"
        : "ai_score";
    } else {
      candidate.status = "pending_review";
      candidate.rejectionReason = null;
    }
    await persistCandidateReviewState(candidate);
  })().finally(() => {
    reviewPromises.delete(candidate.fingerprint);
  });

  reviewPromises.set(candidate.fingerprint, task);
  return task;
}

export class CultureReviewError extends Error {
  readonly code:
    | "not_found"
    | "not_pending"
    | "unsafe_edit"
    | "ai_review_unavailable"
    | "ai_rejected_edit"
    | "duplicate_active";

  constructor(code: CultureReviewError["code"], message: string) {
    super(message);
    this.name = "CultureReviewError";
    this.code = code;
  }
}

export async function getCultureReviewReport(
  now = Date.now()
): Promise<CultureReviewReport> {
  await initializeCultureMemory();
  pruneInMemory(now);

  const items: CultureReviewItem[] = [...candidates.values()]
    .filter(
      candidate =>
        candidate.status === "pending_review" &&
        Boolean(candidate.reviewPhrase) &&
        Boolean(candidate.review)
    )
    .map(candidate => {
      const review = candidate.review!;
      const phrase = candidate.reviewPhrase!;
      return {
        fingerprint: candidate.fingerprint,
        phrase,
        supportCount: candidateSupportCount(candidate),
        responseMode: winningResponseMode(candidate),
        scores: { ...review.scores },
        flags: [...review.flags],
        aiReason: review.aiReason,
        openerCandidate: openerEligible(
          phrase,
          candidateSupportCount(candidate)
        ),
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
        aiReviewedAt: candidate.aiReviewedAt ?? candidate.lastSeenAt,
      };
    })
    .sort(
      (a, b) =>
        b.aiReviewedAt - a.aiReviewedAt || b.supportCount - a.supportCount
    );

  return {
    generatedAt: now,
    pendingCount: items.length,
    awaitingAiCount: [...candidates.values()].filter(
      candidate => candidate.status === "pending_ai_review"
    ).length,
    rejectedLast24h: [...candidates.values()].filter(
      candidate =>
        candidate.status === "rejected" &&
        (candidate.humanReviewedAt ?? candidate.aiReviewedAt ?? 0) >=
          now - 24 * 60 * 60 * 1000
    ).length,
    items,
  };
}

export async function retryPendingCultureReviews(
  requestedLimit = 10,
  now = Date.now()
): Promise<CultureReviewReport> {
  await initializeCultureMemory();
  const limit = Math.max(
    1,
    Math.min(MAX_REVIEW_RETRIES_PER_REQUEST, Math.floor(requestedLimit))
  );
  const pending = [...candidates.values()]
    .filter(
      candidate =>
        candidate.status === "pending_ai_review" &&
        Boolean(candidate.reviewPhrase)
    )
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    .slice(0, limit);

  for (const candidate of pending) {
    await ensureCandidateAiReview(candidate, now, true);
  }
  return getCultureReviewReport(now);
}

export async function approveCultureCandidate(input: {
  fingerprint: string;
  editedPhrase?: string;
  allowAsOpener?: boolean;
  now?: number;
}): Promise<CultureCue> {
  await initializeCultureMemory();
  const candidate = candidates.get(input.fingerprint);
  if (!candidate) {
    throw new CultureReviewError("not_found", "待审核条目不存在或已过期");
  }
  if (
    candidate.status !== "pending_review" ||
    !candidate.reviewPhrase ||
    !candidate.review ||
    candidate.review.scores.total < CULTURE_REVIEW_MIN_SCORE
  ) {
    throw new CultureReviewError("not_pending", "该条目当前不可批准");
  }

  const original = preparePhrase(candidate.reviewPhrase);
  const prepared = preparePhrase(input.editedPhrase ?? candidate.reviewPhrase);
  if (!original || !prepared) {
    throw new CultureReviewError(
      "unsafe_edit",
      "修改后的表达未通过长度或硬安全检查"
    );
  }
  const edited = original.canonical !== prepared.canonical;
  if (edited) {
    const editReview = await reviewCultureCandidate({
      phrase: prepared.display,
      supportCount: 0,
      noveltyScore: noveltyScore(prepared.canonical),
    });
    if (!editReview) {
      throw new CultureReviewError(
        "ai_review_unavailable",
        "修改内容的 AI 复审暂时不可用，请稍后重试"
      );
    }
    if (editReview.hardReject) {
      throw new CultureReviewError(
        "ai_rejected_edit",
        "修改内容触发了 AI 安全否决，请调整后重试"
      );
    }
  }

  const conflict = active.get(prepared.fingerprint);
  if (conflict && conflict.candidateFingerprint !== candidate.fingerprint) {
    throw new CultureReviewError(
      "duplicate_active",
      "相同或近似表达已在正式记忆中"
    );
  }

  const now = input.now ?? Date.now();
  candidate.status = "active";
  candidate.reviewPhrase = prepared.display;
  candidate.approvedFingerprint = prepared.fingerprint;
  candidate.origin = edited ? "curated" : "learned";
  candidate.humanReviewedAt = now;
  candidate.rejectionReason = null;
  candidate.lastSeenAt = now;
  candidate.expiresAt = now + CULTURE_ACTIVE_TTL_MS;

  const cue = promoteInMemory(
    prepared,
    candidate,
    candidateSupportCount(candidate),
    now,
    {
      allowAsOpener: Boolean(input.allowAsOpener),
      origin: candidate.origin,
    }
  );
  await persistCandidateReviewState(candidate, cue);
  return { ...cue };
}

export async function rejectCultureCandidate(input: {
  fingerprint: string;
  now?: number;
}): Promise<void> {
  await initializeCultureMemory();
  const candidate = candidates.get(input.fingerprint);
  if (!candidate) {
    throw new CultureReviewError("not_found", "待审核条目不存在或已过期");
  }
  if (candidate.status !== "pending_review") {
    throw new CultureReviewError("not_pending", "该条目当前不可拒绝");
  }

  const now = input.now ?? Date.now();
  candidate.status = "rejected";
  candidate.reviewPhrase = null;
  candidate.humanReviewedAt = now;
  candidate.rejectionReason = "human_reject";
  candidate.lastSeenAt = now;
  candidate.expiresAt = now + CULTURE_REVIEW_TTL_MS;
  await persistCandidateReviewState(candidate);
}

export function findCultureCue(
  text: string,
  now = Date.now()
): CultureCue | null {
  pruneInMemory(now);
  const prepared = preparePhrase(text);
  if (!prepared) return null;

  let best: { cue: CultureCue; score: number } | null = null;
  for (const cue of active.values()) {
    const score = diceSimilarity(prepared.canonical, canonicalize(cue.phrase));
    if (score < 0.72 || (best && score <= best.score)) continue;
    best = { cue, score };
  }
  return best ? { ...best.cue } : null;
}

export function getCultureOpeners(now = Date.now()): string[] {
  pruneInMemory(now);
  return [...active.values()]
    .filter(cue => cue.openerEligible)
    .sort(
      (a, b) => b.supportCount - a.supportCount || b.lastSeenAt - a.lastSeenAt
    )
    .slice(0, 12)
    .map(cue => cue.phrase);
}

function parseReviewPayload(
  payload: string | null
): CultureReviewDecision | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<CultureReviewDecision>;
    const scores = parsed.scores;
    if (
      !scores ||
      !Number.isFinite(scores.total) ||
      !Number.isFinite(scores.safety) ||
      !Number.isFinite(scores.privacy) ||
      !Number.isFinite(scores.generality) ||
      !Number.isFinite(scores.fun) ||
      !Number.isFinite(scores.evidence) ||
      !Number.isFinite(scores.novelty) ||
      !Array.isArray(parsed.flags) ||
      typeof parsed.aiReason !== "string" ||
      typeof parsed.hardReject !== "boolean"
    ) {
      return null;
    }
    return parsed as CultureReviewDecision;
  } catch {
    return null;
  }
}

function candidateStatus(value: string): CultureCandidateStatus {
  switch (value) {
    case "candidate":
    case "pending_ai_review":
    case "pending_review":
    case "active":
    case "rejected":
    case "expired":
      return value;
    default:
      return "candidate";
  }
}

function rejectionReason(value: string | null): CultureRejectionReason | null {
  switch (value) {
    case "ai_hard_reject":
    case "ai_score":
    case "human_reject":
      return value;
    default:
      return null;
  }
}

function hydrateCandidateRow(row: CultureCandidate): CandidateState {
  const existing = candidates.get(row.fingerprint);
  const candidate: CandidateState = existing ?? {
    fingerprint: row.fingerprint,
    phraseSources: new Set(),
    reactionModes: new Map(),
    persistedSupportCount: 0,
    persistedResponseMode: row.responseMode,
    status: "candidate",
    reviewPhrase: null,
    review: null,
    aiReviewedAt: null,
    humanReviewedAt: null,
    approvedFingerprint: null,
    origin: null,
    rejectionReason: null,
    firstSeenAt: row.firstSeenAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
  candidate.persistedSupportCount = Math.max(
    candidate.persistedSupportCount,
    row.supportCount
  );
  candidate.persistedResponseMode = row.responseMode;
  candidate.status = candidateStatus(row.status);
  candidate.reviewPhrase = row.phrase;
  candidate.review = parseReviewPayload(row.reviewPayload);
  candidate.aiReviewedAt = row.aiReviewedAt?.getTime() ?? null;
  candidate.humanReviewedAt = row.humanReviewedAt?.getTime() ?? null;
  candidate.approvedFingerprint = row.approvedFingerprint;
  candidate.origin = row.origin;
  candidate.rejectionReason = rejectionReason(row.rejectionReason);
  candidate.firstSeenAt = Math.min(
    candidate.firstSeenAt,
    row.firstSeenAt.getTime()
  );
  candidate.lastSeenAt = Math.max(
    candidate.lastSeenAt,
    row.lastSeenAt.getTime()
  );
  candidate.expiresAt = row.expiresAt.getTime();
  candidates.set(row.fingerprint, candidate);
  return candidate;
}

export function initializeCultureMemory(): Promise<void> {
  if (initializePromise) return initializePromise;
  initializePromise = hydratePersistentCultureMemory();
  return initializePromise;
}

async function hydratePersistentCultureMemory(): Promise<void> {
  if (!persistenceEnabled()) return;
  const now = new Date();
  try {
    const db = getDb();
    const expired = await db
      .select({ fingerprint: cultureCandidates.fingerprint })
      .from(cultureCandidates)
      .where(lte(cultureCandidates.expiresAt, now));
    const expiredIds = expired.map(row => row.fingerprint);
    if (expiredIds.length) {
      await db
        .delete(cultureObservations)
        .where(inArray(cultureObservations.fingerprint, expiredIds));
      await db
        .delete(cultureCandidates)
        .where(inArray(cultureCandidates.fingerprint, expiredIds));
    }

    const rows = await db
      .select()
      .from(cultureCandidates)
      .where(
        and(
          inArray(cultureCandidates.status, [
            "pending_ai_review",
            "pending_review",
            "active",
            "rejected",
          ]),
          gt(cultureCandidates.expiresAt, now)
        )
      );
    for (const row of rows) {
      const candidate = hydrateCandidateRow(row);
      if (candidate.status !== "active" || !row.phrase) continue;
      const prepared = preparePhrase(row.phrase);
      if (!prepared || row.approvedFingerprint !== prepared.fingerprint) {
        continue;
      }
      active.set(prepared.fingerprint, {
        candidateFingerprint: row.fingerprint,
        phrase: prepared.display,
        responseMode: row.responseMode,
        supportCount: row.supportCount,
        openerEligible: row.openerEligible,
        origin: row.origin ?? "learned",
        promotedAt: row.promotedAt?.getTime() ?? row.firstSeenAt.getTime(),
        lastSeenAt: row.lastSeenAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
      });
    }
    pruneInMemory();
  } catch (error) {
    // A missing migration must never break matchmaking or chat.
    console.error("[culture-memory] hydrate failed:", error);
  }
}

async function persistPhraseObservation(
  prepared: PreparedPhrase,
  source: string,
  candidate: CandidateState,
  nowMs: number
): Promise<number> {
  const now = new Date(nowMs);
  const candidateExpiry = new Date(nowMs + CULTURE_CANDIDATE_TTL_MS);
  try {
    const db = getDb();
    await db
      .insert(cultureCandidates)
      .values({
        fingerprint: prepared.fingerprint,
        status: "candidate",
        phrase: null,
        supportCount: 0,
        responseMode: "play_along",
        openerEligible: false,
        expiresAt: candidateExpiry,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          lastSeenAt: now,
        },
      });

    const observationId = sha256(`${prepared.fingerprint}:phrase:${source}`);
    await db
      .insert(cultureObservations)
      .values({
        id: observationId,
        fingerprint: prepared.fingerprint,
        sourceFingerprint: source,
        kind: "phrase",
        responseMode: null,
        createdAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { createdAt: now },
      });

    const observations = await db
      .select({
        kind: cultureObservations.kind,
        source: cultureObservations.sourceFingerprint,
        responseMode: cultureObservations.responseMode,
      })
      .from(cultureObservations)
      .where(eq(cultureObservations.fingerprint, prepared.fingerprint));
    const phraseSources = new Set(
      observations.filter(row => row.kind === "phrase").map(row => row.source)
    );
    for (const row of observations) {
      if (row.kind === "reaction" && row.responseMode) {
        candidate.reactionModes.set(row.source, row.responseMode);
      }
    }

    const supportCount = phraseSources.size;
    await db
      .update(cultureCandidates)
      .set({
        supportCount,
        responseMode: winningResponseMode(candidate),
        lastSeenAt: now,
        expiresAt: new Date(candidate.expiresAt),
      })
      .where(eq(cultureCandidates.fingerprint, prepared.fingerprint));

    const [persisted] = await db
      .select()
      .from(cultureCandidates)
      .where(eq(cultureCandidates.fingerprint, prepared.fingerprint));
    if (persisted) hydrateCandidateRow(persisted);
    return supportCount;
  } catch (error) {
    console.error("[culture-memory] persist phrase failed:", error);
    return candidateSupportCount(candidate);
  }
}

async function persistCandidateReviewState(
  candidate: CandidateState,
  cue?: CultureCue
): Promise<void> {
  if (!persistenceEnabled()) return;
  const review =
    candidate.review && candidate.status === "rejected"
      ? { ...candidate.review, aiReason: "" }
      : candidate.review;
  try {
    const db = getDb();
    await db
      .update(cultureCandidates)
      .set({
        status: candidate.status,
        phrase:
          candidate.status === "pending_ai_review" ||
          candidate.status === "pending_review" ||
          candidate.status === "active"
            ? candidate.reviewPhrase
            : null,
        approvedFingerprint: candidate.approvedFingerprint,
        origin: candidate.origin,
        responseMode: cue?.responseMode ?? winningResponseMode(candidate),
        supportCount: candidateSupportCount(candidate),
        openerEligible: cue?.openerEligible ?? false,
        lastSeenAt: new Date(candidate.lastSeenAt),
        expiresAt: new Date(candidate.expiresAt),
        promotedAt: cue ? new Date(cue.promotedAt) : null,
        reviewPayload: review ? JSON.stringify(review) : null,
        aiReviewedAt: candidate.aiReviewedAt
          ? new Date(candidate.aiReviewedAt)
          : null,
        humanReviewedAt: candidate.humanReviewedAt
          ? new Date(candidate.humanReviewedAt)
          : null,
        rejectionReason: candidate.rejectionReason,
      })
      .where(eq(cultureCandidates.fingerprint, candidate.fingerprint));
  } catch (error) {
    console.error("[culture-memory] persist review state failed:", error);
  }
}

async function persistReactionObservation(
  fingerprint: string,
  source: string,
  mode: CultureResponseMode,
  nowMs: number
): Promise<CultureResponseMode | null> {
  try {
    const db = getDb();
    const id = sha256(`${fingerprint}:reaction:${source}`);
    await db
      .insert(cultureObservations)
      .values({
        id,
        fingerprint,
        sourceFingerprint: source,
        kind: "reaction",
        responseMode: mode,
        createdAt: new Date(nowMs),
      })
      .onDuplicateKeyUpdate({
        set: {
          responseMode: mode,
          createdAt: new Date(nowMs),
        },
      });

    const reactions = await db
      .select({
        source: cultureObservations.sourceFingerprint,
        responseMode: cultureObservations.responseMode,
      })
      .from(cultureObservations)
      .where(
        and(
          eq(cultureObservations.fingerprint, fingerprint),
          eq(cultureObservations.kind, "reaction")
        )
      );
    const bySource = new Map<string, CultureResponseMode>();
    for (const reaction of reactions) {
      if (reaction.responseMode) {
        bySource.set(reaction.source, reaction.responseMode);
      }
    }
    const counts: Record<CultureResponseMode, number> = {
      play_along: 0,
      react_only: 0,
      clarify_light: 0,
    };
    for (const responseMode of bySource.values()) counts[responseMode] += 1;
    const winner = (
      Object.entries(counts) as Array<[CultureResponseMode, number]>
    ).sort((a, b) => b[1] - a[1])[0];
    if (!winner || winner[1] === 0) return null;
    await db
      .update(cultureCandidates)
      .set({
        responseMode: winner[0],
        lastSeenAt: new Date(nowMs),
      })
      .where(eq(cultureCandidates.fingerprint, fingerprint));
    return winner[0];
  } catch (error) {
    console.error("[culture-memory] persist reaction failed:", error);
    return null;
  }
}

/** Test-only: reveals workflow state but never quarantined candidate text. */
export function __debugCultureMemory() {
  return {
    candidates: [...candidates.values()].map(candidate => ({
      fingerprint: candidate.fingerprint,
      status: candidate.status,
      sourceCount: candidateSupportCount(candidate),
      reactionCount: candidate.reactionModes.size,
      reviewScore: candidate.review?.scores.total ?? null,
      hasReviewPhrase: Boolean(candidate.reviewPhrase),
      rejectionReason: candidate.rejectionReason,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt,
      expiresAt: candidate.expiresAt,
    })),
    active: [...active.values()].map(cue => ({ ...cue })),
  };
}

export function __resetCultureMemoryForTests(): void {
  candidates.clear();
  active.clear();
  reviewPromises.clear();
  initializePromise = null;
  persistenceDisabledForTests = true;
}
