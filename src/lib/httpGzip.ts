import { gzipSync } from "node:zlib";

/**
 * Server-side gzip for large JSON API payloads.
 *
 * Next.js' built-in `compress` only covers framework-rendered responses; a
 * route returning `new Response(body)` — the dashboard bootstrap — can ship
 * UNCOMPRESSED (233 KB over the wire in the demo tenant, more as data grows;
 * observed with `Cache-Control: no-store`). Vercel's edge may or may not
 * compress such responses depending on platform heuristics, so the route owns
 * compression itself: when the client sends `Accept-Encoding: gzip` we serve a
 * gzipped body with explicit `Content-Encoding`/`Content-Length` — guaranteed
 * smaller wire size on every host; proxies/CDNs pass it through untouched.
 */

export interface CompressedBody {
  body: string | Buffer;
  headers: Record<string, string>;
}

const MIN_BYTES = 1024;

export function compressJsonBody(
  request: Request,
  raw: string,
  extraHeaders: Record<string, string> = {}
): CompressedBody {
  const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") || "");
  if (acceptsGzip && raw.length >= MIN_BYTES) {
    const gz = gzipSync(Buffer.from(raw, "utf8"));
    return {
      body: gz,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": String(gz.length),
        Vary: "Accept-Encoding",
        ...extraHeaders,
      },
    };
  }
  return {
    body: raw,
    headers: { "Content-Type": "application/json", Vary: "Accept-Encoding", ...extraHeaders },
  };
}
