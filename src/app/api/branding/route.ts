import { NextResponse } from "next/server";
import { getPool } from "@/db";
import { getSessionInfo, accessibleBusinessIds } from "@/lib/auth";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * GET /api/branding — the company crest + per-business logos.
 *
 * These base64 data URLs (~50-120 KB together in the demo tenant) used to ride
 * inside EVERY /api/init payload — re-downloaded on login, on every dashboard
 * refresh and after every single save. The init payload now carries only a
 * content-hashed `brandingVersion`; the blobs are served here with:
 *   • ETag = the same content hash ⇒ a 304 (zero bytes) whenever unchanged
 *   • Cache-Control: private, max-age=7d ⇒ the browser keeps them across
 *     sessions and only revalidates
 *   • the client also mirrors the payload in localStorage keyed by the
 *     version, so a matching version hydrates with ZERO network at all.
 *
 * Scope: exactly the businesses the caller can access (identical tenant
 * scoping as init) + the company settings of the caller's organization.
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) {
      return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    }
    const me = session.user;
    const allowed = await accessibleBusinessIds(me, session.orgIds); // null ⇒ Super Admin (all)
    const bids: number[] | null = allowed === null ? null : allowed.length ? allowed : [-1];
    const orgIdForSettings = me.isSuperAdmin
      ? (session.orgId ?? 1)
      : (session.orgId ?? (session.orgIds || [])[0] ?? null);

    const ids = bids === null ? "" : ` WHERE "id" IN (${bids.map((n) => Math.trunc(Number(n))).filter(Number.isFinite).join(",") || "-1"})`;
    const results = (await getPool().query(
      `SELECT "id", "logo", "branch_logos", md5(coalesce(logo, '') || coalesce(branch_logos::text, '')) AS "h" FROM "businesses"${ids} ORDER BY "id" ASC;` +
        (orgIdForSettings != null
          ? `SELECT "company_logo", md5(coalesce(company_logo, '')) AS "h" FROM "company_settings" WHERE "organization_id" = ${Math.trunc(Number(orgIdForSettings))} LIMIT 1;`
          : `SELECT NULL AS "company_logo", '' AS "h" WHERE FALSE;`)
    )) as unknown as any[];

    const bizRows = (results[0].rows as any[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
    const companyRow = (results[1].rows as any[])[0] ?? { company_logo: null, h: "" };

    // Same version derivation as init's brandingVersionOf (md5s computed in
    // PG, so the two can never drift).
    const parts = [String(companyRow.h ?? "")];
    const businesses: Record<string, { logo: string | null; branchLogos: any }> = {};
    for (const b of bizRows) {
      parts.push(`${Number(b.id)}:${b.h ?? ""}`);
      businesses[String(Number(b.id))] = {
        logo: b.logo ?? null,
        branchLogos: b.branch_logos ?? null,
      };
    }
    const v = createHash("sha1").update(parts.join("|")).digest("hex");

    // Unchanged content ⇒ 304, zero bytes.
    const etag = `"${v}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400" },
      });
    }

    const raw = JSON.stringify({
      success: true,
      v,
      companyLogo: companyRow.company_logo ?? null,
      businesses,
    });
    const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") || "");
    if (acceptsGzip && raw.length >= 1024) {
      const gz = gzipSync(Buffer.from(raw, "utf8"));
      return new Response(new Uint8Array(gz), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": String(gz.length),
          Vary: "Accept-Encoding",
          ETag: etag,
          "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
        },
      });
    }
    return new Response(raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        Vary: "Accept-Encoding",
        ETag: etag,
        "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
      },
    });
  } catch (error: any) {
    console.error("Error in /api/branding:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to load branding" },
      { status: 500 }
    );
  }
}
