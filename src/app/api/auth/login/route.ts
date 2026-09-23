import { throttle, clientIp } from "@/lib/rateLimit";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, dbFailureMessage } from "@/db";
import { mapRawRow } from "@/lib/rawRowMapper";
import { users } from "@/db/schema";
import {
  createSession,
  verifyPassword,
  SESSION_COOKIE,
  MAX_FAILED_LOGINS,
  LOCK_MINUTES,
  accessibleBusinessIds,
  deviceLabel,
  hashClientIp,
} from "@/lib/auth";

// Session cookie tuned for the EMBEDDED preview (the app runs inside an
// iframe on a different site):
// - SameSite=None + Secure is REQUIRED for the browser to store/send the
//   cookie in a cross-site iframe at all. The old SameSite=Lax cookie was
//   silently dropped there → every API call ran anonymous → 401 → the app
//   "blinked and bounced back to the login page" after a successful login.
// - Partitioned (CHIPS) keeps the cookie working as Chrome/Safari phase out
//   unpartitioned third-party cookies; engines that don't know the attribute
//   ignore it.
// Loopback (localhost / 127.0.0.1) is a "potentially trustworthy" origin, so
// Secure cookies still work over plain http in local development.
const COOKIE_BASE = `Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${7 * 24 * 3600}`;

export async function POST(request: Request) {
  let operation = "request parsing";
  // M7: IP-level throttle — 30 attempts / minute per IP (in front of the
  // per-account 5-fail lock, so spraying many accounts from one host stalls;
  // generous enough for whole offices on one NAT and for the E2E suites).
  const limited = throttle(clientIp(request), { key: "login", limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: "Email and password are required." },
        { status: 400 }
      );
    }

    operation = "user lookup";
    // ONE combined query: the user row plus the org memberships (with org
    // status) aggregated server-side. The previous flow ran these as two
    // sequential round trips — on a remote (deployed) database every extra
    // sequential query is a fixed RTT on the login critical path.
    const lookupRes = (await db.execute(sql`
      SELECT to_jsonb(u) AS "__user",
        COALESCE((
          SELECT json_agg(jsonb_build_object('organizationId', m.organization_id, 'isPrimary', m.is_primary, 'status', o.status))
          FROM organization_members m
          LEFT JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = u.id
        ), '[]'::json) AS "__memberships"
      FROM users u
      WHERE u.email = ${email}
    `)) as any;
    const rawLookup: any = lookupRes?.rows?.[0];
    const user = rawLookup ? mapRawRow(users, rawLookup.__user) : null;
    const memberships: any[] = rawLookup && Array.isArray(rawLookup.__memberships) ? rawLookup.__memberships : [];
    // Uniform error to avoid leaking which accounts exist.
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Invalid email or password." },
        { status: 401 }
      );
    }
    if (user.isActive === false) {
      return NextResponse.json(
        { success: false, error: "This account is deactivated. Contact the OWNER." },
        { status: 403 }
      );
    }

    // Platform-level suspension / removal: members of a SUSPENDED organization
    // cannot authenticate (temporary, reversible). Members of a DELETED
    // organization are locked out too — deletion permanently revokes platform
    // access while preserving every row of their data (Super-Admin restorable).
    // The Super Admin's primary org stays ACTIVE by construction.
    {
      const stat = (m: any) => (m.status || "ACTIVE").toUpperCase();
      if (memberships.length > 0) {
        if (memberships.every((m) => stat(m) === "DELETED")) {
          return NextResponse.json(
            { success: false, error: "This organization's workspace was removed from the platform. Contact the platform administrator." },
            { status: 403 }
          );
        }
        if (memberships.every((m) => stat(m) === "SUSPENDED")) {
          return NextResponse.json(
            { success: false, error: "This organization's workspace is suspended. Contact the platform administrator." },
            { status: 403 }
          );
        }
      }
    }

    // Brute-force lockout
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const mins = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 60000);
      return NextResponse.json(
        { success: false, error: `Account temporarily locked. Try again in ${mins} minute(s).` },
        { status: 423 }
      );
    }

    if (!user.passwordHash) {
      return NextResponse.json(
        { success: false, error: "No password set for this account yet. Ask the OWNER to set one." },
        { status: 403 }
      );
    }

    operation = "password verification";
    if (!verifyPassword(password, user.passwordHash)) {
      const failed = (user.failedLoginAttempts || 0) + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      operation = "failed-login counter update";
      await db
        .update(users)
        .set({
          failedLoginAttempts: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null,
        })
        .where(eq(users.id, user.id));
      return NextResponse.json(
        {
          success: false,
          error: lock
            ? `Too many failed attempts — account locked for ${LOCK_MINUTES} minutes.`
            : `Invalid email or password. ${MAX_FAILED_LOGINS - failed} attempt(s) left.`,
        },
        { status: 401 }
      );
    }

    operation = "login-state reset";
    // Only write when there is actually something to reset — the common
    // successful login otherwise paid an UPDATE round trip on every sign-in.
    if ((user.failedLoginAttempts || 0) > 0 || user.lockedUntil) {
      await db
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    // Session creation + business-access resolution run in ONE parallel wave
    // (the access scope is derived from the memberships already fetched —
    // no second membership read).
    const loginOrgIds = memberships.map((m) => Number(m.organizationId)).filter(Number.isFinite);
    // Legacy users with a primary org but no membership row keep the raw-row
    // resolveUserOrgIds fallback so their login scope is unchanged.
    const orgIdsForAccess =
      loginOrgIds.length || !user.primaryOrgId ? loginOrgIds : [Number(user.primaryOrgId)];
    const userForAccess = { ...user, organizationIds: orgIdsForAccess };
    const { label: sessLabel, raw: sessAgent } = deviceLabel(request);
    operation = "session creation";
    const [session, access] = await Promise.all([
      createSession(user.id, {
        deviceLabel: sessLabel,
        userAgent: sessAgent,
        ipHash: hashClientIp(request),
        initialBusinessId: user.assignedBusinessId ?? null,
      }),
      accessibleBusinessIds(userForAccess, orgIdsForAccess),
    ]);

    const res = NextResponse.json({
      success: true,
      user: sanitize(user),
      accessibleBusinessIds: access,
      expiresAt: session.expires,
      // Header-channel fallback for cookie-hostile embedded contexts; the
      // client stores this in sessionStorage and reattaches it to /api calls.
      sessionToken: session.token,
    });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=${session.token}; ${COOKIE_BASE}`);
    return res;
  } catch (error: any) {
    // DB/driver failures land here — keep the detail server-side, give the
    // user an actionable message instead of a raw connection error. A
    // DEPLOYMENT configuration failure (no DATABASE_URL on Vercel, a
    // 127.0.0.1/localhost URL, or a schema that was never pushed) gets a
    // specific message; genuinely transient outages keep the generic copy.
    const root = error?.cause?.message ? error.cause : error;
    // Keep credentials and query parameters out of logs while preserving the
    // operation and PostgreSQL diagnostics needed to fix the actual failure.
    console.error("[auth/login] service error:", {
      operation,
      message: root?.message || error?.message || String(error),
      code: root?.code || error?.code || null,
      detail: root?.detail || null,
      schema: root?.schema || null,
      table: root?.table || null,
      column: root?.column || null,
      constraint: root?.constraint || null,
    });
    const specific = dbFailureMessage(error);
    if (specific) {
      return NextResponse.json({ success: false, error: specific }, { status: 500 });
    }
    return NextResponse.json(
      { success: false, error: "Sign-in service is temporarily unavailable (database connection). Please wait a moment and retry." },
      { status: 500 }
    );
  }
}

function sanitize(u: any) {
  const {
    passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe
  } = u;
  return safe;
}
