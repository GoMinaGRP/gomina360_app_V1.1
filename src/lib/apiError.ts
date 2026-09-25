import { NextResponse } from "next/server";

/**
 * apiError — the single, safe way to turn an unexpected thrown error into an
 * API response.
 *
 * Problem it fixes (A–Z audit M3): every route's catch block echoed raw
 * `error.message` to clients. Most messages are DELIBERATE business/validation
 * text (fine to surface) — but when the DB adapter or framework throws, the
 * message leaks schema internals ("relation \u201cfoo\u201d does not exist", constraint
 * names, absolute paths).
 *
 * Policy:
 *  - Deliberate business errors (throw new Error("user-friendly text")) are
 *    surfaced unchanged — UX and suites rely on them.
 *  - Database/adapter/framework internals are detected (Postgres SQLSTATE
 *    codes, drizzle/pg phrasing, module paths) and replaced with a generic
 *    message, while the full error is logged server-side.
 */

const INTERNAL_PATTERNS = [
  /relation\s+"[\w.]+"\s+does not exist/i,
  /column\s+"[\w.]+"\s+does not exist/i,
  /violates\s+(foreign key|unique|not-null|check|exclusion)\s+constraint/i,
  /duplicate key value violates/i,
  /syntax error at or near/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET/i,
  /cannot connect|connection refused|terminating connection/i,
  /\/home\/|\/opt\/|node_modules/i,
  /Cannot find module|MODULE_NOT_FOUND/i,
  /Prepared statement|cached plan/i,
];

export function isInternalErrorMessage(msg: string): boolean {
  if (!msg) return true;
  return INTERNAL_PATTERNS.some((p) => p.test(msg));
}

/**
 * Convert a caught error into a client response.
 * `fallbackStatus` stays 500 to keep existing response contracts.
 */
export function apiError(error: unknown, fallbackStatus = 500) {
  const msg = (error as any)?.message ?? String(error ?? "");
  // Deliberate access-control errors (e.g. the read-only Advisor gate) carry
  // their own HTTP status and a user-facing message — surface them verbatim.
  const status = (error as any)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return NextResponse.json({ success: false, error: msg || "Not permitted." }, { status });
  }
  const code = (error as any)?.code ?? null; // pg populates SQLSTATE here

  // Postgres SQLSTATE (5-char class) or known-internal phrasing → sanitize.
  const looksSqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
  if (looksSqlState || isInternalErrorMessage(msg)) {
    // Full detail into the server log for debugging — never to the client.
    console.error("[apiError sanitized]", { code, message: msg });
    return NextResponse.json(
      { success: false, error: "Unexpected server error — the team has been alerted. Please try again." },
      { status: fallbackStatus },
    );
  }

  return NextResponse.json({ success: false, error: msg || "Unexpected server error." }, { status: fallbackStatus });
}
