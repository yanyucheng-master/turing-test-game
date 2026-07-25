/** Simple in-memory token buckets keyed by IP + action. */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const activeGamesByIp = new Map<string, Set<string>>();
const MAX_ACTIVE_GAMES = 2;
const PRUNE_EVERY_MS = 60_000;
let lastPruneAt = 0;

/** Prefer platform-owned client IP headers; do not trust spoofable XFF alone. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function pruneStale(): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
  for (const [ip, set] of activeGamesByIp) {
    if (set.size === 0) activeGamesByIp.delete(ip);
  }
}

/** Returns true if the request is allowed. */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  pruneStale();
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

export function canRegisterActiveGame(ip: string, gameId: string): boolean {
  pruneStale();
  const set = activeGamesByIp.get(ip);
  if (!set) return true;
  if (set.has(gameId)) return true;
  return set.size < MAX_ACTIVE_GAMES;
}

export function registerActiveGame(ip: string, gameId: string): boolean {
  pruneStale();
  let set = activeGamesByIp.get(ip);
  if (!set) {
    set = new Set();
    activeGamesByIp.set(ip, set);
  }
  if (!set.has(gameId) && set.size >= MAX_ACTIVE_GAMES) return false;
  set.add(gameId);
  return true;
}

export function releaseActiveGame(ip: string, gameId: string): void {
  const set = activeGamesByIp.get(ip);
  if (!set) return;
  set.delete(gameId);
  if (set.size === 0) activeGamesByIp.delete(ip);
}

/** Test helper */
export function __resetRateLimitsForTests() {
  buckets.clear();
  activeGamesByIp.clear();
  lastPruneAt = 0;
}
