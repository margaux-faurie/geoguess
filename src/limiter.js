// Sliding-window rate limiter. Per Worker instance or per Node process: a best-effort brake, not a global quota.
// Stale keys are dropped lazily, at most once per window, so memory follows the traffic of the last window.

export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = 0;
  return {
    /** True if `key` may proceed at time `t` (and counts it); false if it is over the limit. */
    allow(key, t) {
      if (t - lastSweep > windowMs) {
        lastSweep = t;
        for (const [k, times] of hits) if (!times.some((x) => t - x < windowMs)) hits.delete(k);
      }
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        if (recent.length) hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    /** Number of keys currently held (for tests). */
    size: () => hits.size,
  };
}
