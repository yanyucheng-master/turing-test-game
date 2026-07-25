import { INITIAL_CONFIG } from "./config";
import { scrubReply } from "./personas";
import type { TurnPlan } from "./turnPolicy";

const FORBIDDEN = [
  /首先/,
  /其次/,
  /总的来说/,
  /以下是/,
  /需要注意的是/,
  /你可以尝试/,
  /建议你/,
  /希望这些.*帮助/,
  /我理解你的感受/,
  /从.+角度来看/,
  /作为AI/,
  /作为\s*AI/,
  /作为一个\s*AI/,
  /作为语言模型/,
  /人工智能助手/,
  /语言模型/,
  /机器人程序/,
  /ChatGPT/i,
  /我是(一个)?(AI|人工智能|语言模型)/i,
  /我是\s*AI/i,
];

export interface StyleGuardResult {
  passed: boolean;
  reasons: string[];
  severity: "low" | "medium" | "high";
  parts: string[];
}

/** Hard check on raw model text before any scrub rewriting. */
export function runRawSafetyGuard(raw: string): StyleGuardResult {
  const text = raw.trim();
  if (!text) {
    return { passed: false, reasons: ["empty"], severity: "high", parts: [] };
  }
  for (const re of FORBIDDEN) {
    if (re.test(text)) {
      return {
        passed: false,
        reasons: [`forbidden:${re}`],
        severity: "high",
        parts: [],
      };
    }
  }
  if (/^[\s]*[-*•\d]+[.\、]/.test(text) || text.includes("\n-")) {
    return {
      passed: false,
      reasons: ["list_format"],
      severity: "high",
      parts: [],
    };
  }
  return { passed: true, reasons: [], severity: "low", parts: [text] };
}

export function runStyleGuard(
  parts: string[],
  plan: TurnPlan,
  usedReplyIds: string[],
): StyleGuardResult {
  const reasons: string[] = [];
  let severity: StyleGuardResult["severity"] = "low";

  // Hard-fail on raw model text BEFORE scrubReply can rewrite identity slips
  // into canned denials (which would falsely look "safe").
  for (const p of parts) {
    const raw = runRawSafetyGuard(p);
    if (!raw.passed) {
      return raw;
    }
  }

  let cleaned = parts
    .map((p) => scrubReply(p))
    .map((p) => p.trim())
    .filter(Boolean);

  if (cleaned.length > INITIAL_CONFIG.maxReplyParts) {
    cleaned = cleaned.slice(0, INITIAL_CONFIG.maxReplyParts);
    reasons.push("too_many_parts");
    severity = "medium";
  }

  cleaned = cleaned.map((p) => {
    if (p.length > INITIAL_CONFIG.maxPartLength) {
      reasons.push("part_too_long");
      severity = "medium";
      return p.slice(0, INITIAL_CONFIG.maxPartLength);
    }
    return p;
  });

  const total = cleaned.join("").length;
  if (total > INITIAL_CONFIG.maxTotalLength) {
    reasons.push("total_too_long");
    severity = "high";
    // Prefer drop second part over hard mid-cut of first.
    if (cleaned.length > 1) cleaned = [cleaned[0]];
    else cleaned = [cleaned[0].slice(0, INITIAL_CONFIG.maxTotalLength)];
  }

  for (const p of cleaned) {
    const id = p.slice(0, 24);
    if (usedReplyIds.includes(id) && p.length <= 8) {
      reasons.push("repeat_canned");
      // Hard-fail so generator picks a fresh fallback instead of replaying.
      return {
        passed: false,
        reasons,
        severity: "medium",
        parts: [],
      };
    }
  }

  // Plan said tiny but got medium essay
  if (plan.targetLength === "tiny" && total > 16) {
    reasons.push("length_mismatch");
    severity = severity === "high" ? "high" : "medium";
    cleaned = [cleaned[0].slice(0, 12)];
  }

  const passed = !reasons.some(
    (r) =>
      r.startsWith("forbidden") ||
      r === "list_format" ||
      r === "repeat_canned",
  );

  return {
    passed: passed && cleaned.length > 0,
    reasons,
    severity,
    parts: cleaned,
  };
}
