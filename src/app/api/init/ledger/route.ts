import { NextResponse } from "next/server";
import { readFullLedgerTransactions, toLedgerTransaction } from "@/lib/initSnapshot";
import { ttlGet, ttlSet } from "@/lib/ttlCache";
import { getSessionInfo, accessibleBusinessIds, filterByAccess, isFarmAdvisor } from "@/lib/auth";
import { jsonETag, notModified, PRIVATE_REVALIDATE } from "@/lib/httpCache";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * GET /api/init/ledger — the COMPLETE operational transaction history for the
 * viewer, in the same shape and under the same access rules as the
 * `transactions` array of /api/init.
 *
 * /api/init ships only the recent window (see LEDGER_WINDOW_DAYS in
 * initSnapshot.ts). The client calls this endpoint in the background when the
 * bootstrap reports `ledger.complete === false`, so all-time totals and history
 * screens still see every row. Response is gzip + ETag and cached per viewer
 * for a short TTL, so unchanged data costs a 304 with no body.
 */
const LEDGER_TTL_MS = 10_000;

interface LedgerCacheEntry {
  raw: string;
  gz: Buffer | null;
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) {
      return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    }
    const me = session.user;

    // Farm advisors never receive ledger rows (mirrors /api/init).
    if (isFarmAdvisor(me)) {
      return NextResponse.json({ success: true, transactions: [] }, { headers: { "Cache-Control": PRIVATE_REVALIDATE } });
    }

    const allowed = await accessibleBusinessIds(me, session.orgIds); // null ⇒ Super Admin (all)
    const bids: number[] | null = allowed === null ? null : allowed.length ? allowed : [-1];

    const scopeKey = createHash("sha1")
      .update(JSON.stringify({
        u: me.id,
        r: me.role,
        b: allowed === null ? "ALL" : [...allowed].sort((a, b) => a - b),
      }))
      .digest("base64url")
      .slice(0, 16);
    const cacheKey = `init-ledger:v1:${scopeKey}`;
    const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") || "");

    let entry = ttlGet<LedgerCacheEntry>(cacheKey);
    if (entry === undefined) {
      const rows = filterByAccess(await readFullLedgerTransactions(bids), allowed);
      // Worker: own recorded sales only — same rule as /api/init.
      const visible = String(me.role || "").toUpperCase() === "WORKER"
        ? rows.filter((t: any) => String(t.recordedBy || "") === String(me.name || "\u0000"))
        : rows;
      const raw = JSON.stringify({ success: true, transactions: visible.map(toLedgerTransaction) });
      const gz = acceptsGzip && raw.length >= 1024 ? gzipSync(Buffer.from(raw, "utf8")) : null;
      entry = { raw, gz };
      ttlSet(cacheKey, entry, LEDGER_TTL_MS);
    }

    const etag = jsonETag(entry.raw);
    const notModifiedHit = notModified(request, etag);
    if (notModifiedHit) return notModifiedHit;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": PRIVATE_REVALIDATE,
      ETag: etag,
      Vary: "Accept-Encoding",
    };
    if (entry.gz && acceptsGzip) {
      headers["Content-Encoding"] = "gzip";
      headers["Content-Length"] = String(entry.gz.length);
      return new Response(new Uint8Array(entry.gz), { status: 200, headers });
    }
    return new Response(entry.raw, { status: 200, headers });
  } catch (error: any) {
    console.error("Error in /api/init/ledger:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to load transaction history" },
      { status: 500 }
    );
  }
}
