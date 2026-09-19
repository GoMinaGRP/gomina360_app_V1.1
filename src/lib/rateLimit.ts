import { NextResponse } from "next/server";

/**
 * rateLimit — tiny in-process sliding-window throttler for public/unauth
 * endpoints (A–Z audit M7). Account-level defenses already exist on login
 * (5 failures → lock) but nothing bound an IP: spraying across many accounts,
 * tracking-code enumeration, geocode scraping and storefront order spam all
 * rode free.
 *
 * Design: per-process Map of key → timestamps[pruned]. ONE process assumption
 * matches the embedded single-node deployment (same caveat as ttlCache — a
 * Redis-backed bus is the documented multi-instance upgrade).
 */

type Bucket = number[];
const buckets = new Map<string, Bucket>();

// Prune pass every ~2 min so idle keys never accumulate.
let sweepAt = 0;
function sweep(windowMs: number) {
  const now = Date.now();
  if (now - sweepAt < 120_000) return;
  sweepAt = now;
  const cutoff = now - windowMs;
  for (const [k, v] of buckets) {
    const kept = v.filter((t) => t > cutoff);
    if (kept.length === 0) buckets.delete(k);
    else buckets.set(k, kept);
  }
}

export type ThrottleOpts = { key: string; limit: number; windowMs: number };

/** Returns a 429 NextResponse when the limit is exceeded, else null. */
export function throttle(ip: string, opts: ThrottleOpts): NextResponse | null {
  const now = Date.now();
  sweep(opts.windowMs);
  const key = `${opts.key}:${ip}`;
  const cutoff = now - opts.windowMs;
  const arr = (buckets.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= opts.limit) {
    const retryAfterSec = Math.max(1, Math.ceil((arr[0] + opts.windowMs - now) / 1000));
    return NextResponse.json(
      { success: false, error: "Too many requests — please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }
  arr.push(now);
  buckets.set(key, arr);
  return null;
}

/** Best-effort client IP: first x-forwarded-for hop (proxy set), else hint. */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") || "unknown-ip";
}
