import "dotenv/config";

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  /** Reserved; not required for gameplay. */
  appId: optional("APP_ID", "turing-test"),
  appSecret: optional("APP_SECRET", "dev-only-not-a-secret"),
  isProduction: process.env.NODE_ENV === "production",
  /** Empty = skip MySQL; match/chat/finish still work in memory. */
  databaseUrl: optional("DATABASE_URL"),
  /**
   * Stable HMAC salt for anonymous culture-learning contributor fingerprints.
   * Without it, learning still works in-process but is not persisted.
   */
  cultureLearningSalt: optional("CULTURE_LEARNING_SALT"),
  /**
   * Owner-only token for the culture review API and page.
   * Keep this server-side and use at least 24 random characters.
   */
  cultureReviewToken: optional("CULTURE_REVIEW_TOKEN"),
  /** Optional evaluator model; falls back to DEFAULT_AI_MODEL. */
  cultureReviewModel: optional("CULTURE_REVIEW_MODEL"),
};

export function hasDatabase(): boolean {
  return Boolean(env.databaseUrl.trim());
}
