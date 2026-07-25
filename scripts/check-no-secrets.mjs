/**
 * Fail CI/local check if tracked source looks like it contains API keys.
 * Does not inspect gitignored files such as .env.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  /\bsk-[a-zA-Z0-9]{16,}\b/,
  /\bgsk_[a-zA-Z0-9]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxai-[a-zA-Z0-9]{20,}\b/,
  /DEFAULT_AI_API_KEY\s*=\s*["']?(sk-|gsk_)/i,
  /Bearer\s+(sk-|gsk_)[a-zA-Z0-9_-]+/i,
];

const files = execSync("git ls-files", { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter(
    (f) =>
      !f.endsWith("package-lock.json") &&
      !f.endsWith("check-no-secrets.mjs") &&
      !f.includes("node_modules"),
  );

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const re of patterns) {
    if (re.test(text)) {
      hits.push(`${file} matches ${re}`);
      break;
    }
  }
}

if (hits.length) {
  console.error("[secrets] possible API key material in tracked files:");
  for (const h of hits) console.error(" -", h);
  process.exit(1);
}

console.log("[secrets] no API key patterns in tracked files");
