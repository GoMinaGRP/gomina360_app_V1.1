/**
 * Tiny per-process TTL cache for expensive, shareable reads (the public
 * marketplace catalog). In-memory, non-persistent — safe by construction:
 * misses always fall through to the database, and entries expire on their
 * own, so data can never go permanently stale. Server-only.
 */
const store = new Map<string, { value: any; expiresAt: number }>();

export function ttlGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function ttlSet(key: string, value: any, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  // Prevent unbounded growth across long-lived processes.
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  }
}

export function ttlInvalidate(prefix: string): void {
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}
