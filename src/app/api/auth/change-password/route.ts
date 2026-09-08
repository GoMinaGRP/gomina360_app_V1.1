import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { userSessions } from "@/db/schema";
import { getSessionInfo, setUserPassword, verifyPassword } from "@/lib/auth";

// Self-service password change. Any signed-in user (OWNER, managers,
// workers) may change THEIR OWN password from the account menu. The account
// being changed is always the session user — there is deliberately no
// "userId" input, so this route can never be used to touch somebody else's
// account. Resetting OTHER users' passwords stays in /api/users behind the
// OWNER permission (spoof-protected, returns 403 for everyone else).
export const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  try {
    const info = await getSessionInfo(request);
    if (!info) {
      return NextResponse.json(
        { success: false, error: "Sign in required." },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const confirmPassword = String(body.confirmPassword || "");

    if (!currentPassword || !newPassword || !confirmPassword) {
      return NextResponse.json(
        { success: false, error: "Current password, new password and confirmation are all required." },
        { status: 400 }
      );
    }
    if (newPassword !== confirmPassword) {
      return NextResponse.json(
        { success: false, error: "New passwords do not match. Re-type the confirmation." },
        { status: 400 }
      );
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { success: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters long.` },
        { status: 400 }
      );
    }
    if (newPassword === currentPassword) {
      return NextResponse.json(
        { success: false, error: "New password must be different from your current password." },
        { status: 400 }
      );
    }

    const me = info.user;
    if (!me.passwordHash) {
      return NextResponse.json(
        { success: false, error: "This account has no password yet. Ask the OWNER to set one first." },
        { status: 403 }
      );
    }
    if (!verifyPassword(currentPassword, me.passwordHash)) {
      // Identity is proven by the CURRENT password — refuse anything else.
      // 403 (not 401) so the app's global 401 handler does not sign the
      // user out; the modal simply shows the inline error.
      return NextResponse.json(
        { success: false, error: "Current password is incorrect." },
        { status: 403 }
      );
    }

    // Apply immediately: new hash now, lockout counters cleared.
    await setUserPassword(me.id, newPassword);

    // Sign out every OTHER session/device for this account so the new
    // password takes hold everywhere at once. The session that performed
    // the change stays alive — the user is not bounced to the login page.
    const otherSessions = await db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(and(eq(userSessions.userId, me.id), ne(userSessions.id, info.sessionId)));
    if (otherSessions.length) {
      await db
        .delete(userSessions)
        .where(and(eq(userSessions.userId, me.id), ne(userSessions.id, info.sessionId)));
    }

    return NextResponse.json({
      success: true,
      message: "Password updated. It takes effect immediately; other devices were signed out.",
      revokedOtherSessions: otherSessions.length,
    });
  } catch (err: any) {
    console.error("change-password error", err);
    return NextResponse.json(
      { success: false, error: "Password service is temporarily unavailable. Please try again." },
      { status: 500 }
    );
  }
}
