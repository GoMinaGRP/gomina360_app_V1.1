import { NextResponse } from "next/server";
import { dbFailureMessage } from "@/db";
import { getSessionInfo, accessibleBusinessIds } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    const info = await getSessionInfo(request);
    if (!info) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }
    const { passwordHash, failedLoginAttempts, lockedUntil, passwordChangedAt, ...safe } = info.user;
    const access = await accessibleBusinessIds(info.user);
    return NextResponse.json({ success: true, user: safe, accessibleBusinessIds: access });
  } catch (error: any) {
    // DB/driver failures must return JSON (same message as /api/auth/login),
    // never an uncaught 500 HTML page the client can't parse. Deployment
    // configuration failures get a specific, actionable message.
    console.error("[auth/me] service error:", error?.message || error);
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
