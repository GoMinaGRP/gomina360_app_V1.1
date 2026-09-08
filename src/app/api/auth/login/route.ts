import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  createSession,
  verifyPassword,
  SESSION_COOKIE,
  MAX_FAILED_LOGINS,
  LOCK_MINUTES,
  accessibleBusinessIds,
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

    const [user] = await db.select().from(users).where(eq(users.email, email));
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

    if (!verifyPassword(password, user.passwordHash)) {
      const failed = (user.failedLoginAttempts || 0) + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
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

    await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));

    const { token, expires } = await createSession(user.id);
    const access = await accessibleBusinessIds(user);

    const res = NextResponse.json({
      success: true,
      user: sanitize(user),
      accessibleBusinessIds: access,
      expiresAt: expires,
      // Header-channel fallback for cookie-hostile embedded contexts; the
      // client stores this in sessionStorage and reattaches it to /api calls.
      sessionToken: token,
    });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=${token}; ${COOKIE_BASE}`);
    return res;
  } catch (error: any) {
    // DB/driver failures land here — keep the detail server-side, give the
    // user an actionable message instead of a raw connection error.
    console.error("[auth/login] service error:", error?.message || error);
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
