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
};

export function hasDatabase(): boolean {
  return Boolean(env.databaseUrl.trim());
}
