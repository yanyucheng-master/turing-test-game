/** Simple in-memory token buckets keyed by IP + action. */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const activeGamesByIp = new Map<string, Set<string>>();

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

/** Returns true if the request is allowed. */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

export function registerActiveGame(ip: string, gameId: string): boolean {
  let set = activeGamesByIp.get(ip);
  if (!set) {
    set = new Set();
    activeGamesByIp.set(ip, set);
  }
  if (!set.has(gameId) && set.size >= 2) return false;
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
}
