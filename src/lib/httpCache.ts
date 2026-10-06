import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * Conditional-request helpers for read-only JSON endpoints.
 *
 * Why: every screen re-downloaded its full JSON on every visit — /api/init
 * (26 KB gzipped), /api/audit (75 KB uncompressed), /api/users, … — because the
 * responses carried `Cache-Control: no-store` and no validator. With an ETag
 * and `private, no-cache` the browser keeps the body, revalidates on the next
 * visit, and an unchanged payload costs a 304 with no body at all.
 *
 * Why `private, no-cache` (not `no-store`) and not `max-age`:
 *  • `private` — these payloads are per-viewer (tenant-scoped); a shared proxy
 *    must never reuse them.
 *  • `no-cache` — the browser MAY store, but MUST revalidate before using, so a
 *    user can never see data older than their last request.
 *  • no `max-age` — no window in which a stale payload could be served without
 *    asking the server first.
 *
 * Correctness: the ETag is a hash of the exact JSON body, so any change in the
 * data (including a permission change that alters the payload) changes the
 * validator and the client gets a fresh 200. Mutation routes that invalidate
 * the server-side caches therefore also force a new ETag automatically.
 */

/** Weak validator for a JSON payload (hash of the exact bytes we would send). */
export function jsonETag(raw: string): string {
  return `W/"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"`;
}

/** Default cache policy for per-viewer read-only JSON. */
export const PRIVATE_REVALIDATE = "private, no-cache, must-revalidate";

/**
 * Returns a 304 response when the caller already has this payload, otherwise
 * null (caller sends the full response with the ETag header added).
 */
export function notModified(
  request: Request,
  etag: string,
  headers: Record<string, string> = {}
): Response | null {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return null;
  // A client may send a list of validators (or "*"); accept both.
  const matches = ifNoneMatch
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === etag || v === "*" || v === etag.replace(/^W\//, ""));
  if (!matches) return null;
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      "Cache-Control": PRIVATE_REVALIDATE,
      Vary: "Accept-Encoding",
      ...headers,
    },
  });
}

/**
 * One-shot JSON responder for read-only endpoints: serialises once, answers a
 * matching `If-None-Match` with 304 (no body), otherwise sends the payload
 * gzipped when the client accepts it and tags it with a private revalidating
 * cache header. Replaces the plain `NextResponse.json(body)` on GET routes.
 */
export function cachedJson(request: Request, body: unknown, init: ResponseInit = {}): Response {
  const raw = JSON.stringify(body);
  const etag = jsonETag(raw);
  const miss = notModified(request, etag);
  if (miss) return miss;

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", PRIVATE_REVALIDATE);
  headers.set("ETag", etag);
  headers.set("Vary", "Accept-Encoding");
  const status = init.status ?? 200;
  if (status !== 200) return new Response(raw, { ...init, status, headers: { ...Object.fromEntries(headers), "Cache-Control": "no-store" } });

  if (/\bgzip\b/i.test(request.headers.get("accept-encoding") || "") && raw.length >= 1024) {
    const gz = gzipSync(Buffer.from(raw, "utf8"));
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(gz.length));
    return new Response(new Uint8Array(gz), { status, headers });
  }
  return new Response(raw, { status, headers });
}
