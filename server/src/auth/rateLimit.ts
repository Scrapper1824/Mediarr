/**
 * Login brute-force protection. Failures are counted per client IP and per username, so neither one
 * attacker trying many passwords nor many attackers trying one account get far.
 */
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_PER_IP = 10;
const MAX_PER_USER = 5;

interface Bucket {
  failures: number[];
  lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = { failures: [], lockedUntil: 0 }));
  return b;
}

const keysFor = (ip: string, username: string) => [
  { key: `ip:${ip}`, max: MAX_PER_IP },
  { key: `user:${username.toLowerCase()}`, max: MAX_PER_USER },
];

/** Seconds until another attempt is allowed, or 0. */
export function lockedFor(ip: string, username: string, nowMs = Date.now()): number {
  let wait = 0;
  for (const { key } of keysFor(ip, username)) {
    const b = buckets.get(key);
    if (b && b.lockedUntil > nowMs) wait = Math.max(wait, Math.ceil((b.lockedUntil - nowMs) / 1000));
  }
  return wait;
}

export function recordFailure(ip: string, username: string, nowMs = Date.now()) {
  for (const { key, max } of keysFor(ip, username)) {
    const b = bucket(key);
    b.failures = b.failures.filter((t) => nowMs - t < WINDOW_MS);
    b.failures.push(nowMs);
    if (b.failures.length >= max) {
      b.lockedUntil = nowMs + LOCK_MS;
      b.failures = [];
    }
  }
}

export function recordSuccess(ip: string, username: string) {
  for (const { key } of keysFor(ip, username)) buckets.delete(key);
}

/** For tests. */
export function resetRateLimits() {
  buckets.clear();
}

// Forget stale entries so the map can't grow without bound.
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.lockedUntil < t && b.failures.every((f) => t - f > WINDOW_MS)) buckets.delete(k);
}, 10 * 60_000).unref();
