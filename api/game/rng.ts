/** Tiny seeded PRNG (mulberry32) for reproducible persona rhythm. */

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type RngHost = { rngState: number };

/** Advance session RNG and return [0, 1). */
export function nextRng(host: RngHost): number {
  let s = (host.rngState + 0x6d2b79f5) >>> 0;
  host.rngState = s;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function pickWeighted<T>(
  host: RngHost,
  items: Array<{ w: number; v: T }>,
): T {
  const sum = items.reduce((a, b) => a + b.w, 0);
  let r = nextRng(host) * (sum || 1);
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

export function pickOne<T>(host: RngHost, pool: T[]): T {
  if (!pool.length) throw new Error("empty pool");
  return pool[Math.floor(nextRng(host) * pool.length) % pool.length];
}
