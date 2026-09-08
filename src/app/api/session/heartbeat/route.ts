import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { userSessions } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Session presence heartbeat — drives the live ONLINE chip in the
 * Signed-In Staff console.
 *
 * The app fires this on load / pageshow / visibility-return (active: true)
 * and via sendBeacon on pagehide/tab-hidden (active: false). "active:false"
 * PARKS the session (revoked_at) without ending it — closing the laptop lid
 * or the browser window means "not at the desk", not "signed out". Any real
 * API call automatically un-parks (see getSessionInfo), so presence can
 * never get stuck: a truly-active user always reads online again within a
 * beat, and only the CALLER'S OWN session is ever touched.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();

    // sendBeacon posts arrive as application/json blobs; tolerate bad bodies —
    // a presence beat must never throw into the console.
    const body = await request.json().catch(() => ({}));
    const active = body?.active !== false;

    const values: any = { lastSeenAt: new Date() };
    if (active) {
      values.revokedAt = null;
    } else {
      // Only stamp the park time once (first close), so reopening/closing
      // multiple tabs keeps the earliest honest "went away" time.
      values.revokedAt = new Date();
    }

    await db
      .update(userSessions)
      .set(values)
      .where(and(eq(userSessions.id, session.sessionId), isNull(userSessions.endedAt)));

    return NextResponse.json({ success: true, online: active });
  } catch (e: any) {
    console.error("session heartbeat error", e);
    return NextResponse.json({ success: false, error: e?.message || "Heartbeat failed" }, { status: 500 });
  }
}
