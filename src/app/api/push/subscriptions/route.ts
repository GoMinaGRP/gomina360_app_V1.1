import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { removeSubscription } from "@/lib/push";

/**
 * Browser push subscriptions for the signed-in user — one row per device.
 * POST upserts by endpoint (Rotate/resume-safe); DELETE removes the device.
 */
export async function GET(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  const subs = await db
    .select({ endpoint: pushSubscriptions.endpoint, userAgent: pushSubscriptions.userAgent, createdAt: pushSubscriptions.createdAt })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, session.user.id));
  return NextResponse.json({ success: true, subscriptions: subs });
}

export async function POST(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const body = await request.json();
    const endpoint = String(body.endpoint || "").trim();
    const p256dh = String(body?.keys?.p256dh || body.p256dh || "").trim();
    const auth = String(body?.keys?.auth || body.auth || "").trim();
    if (!endpoint || !endpoint.startsWith("https://") || !p256dh || !auth) {
      return NextResponse.json({ success: false, error: "A valid push subscription (endpoint + keys) is required." }, { status: 400 });
    }
    const userAgent = String(body.userAgent || request.headers.get("user-agent") || "").slice(0, 240) || null;
    const [existing] = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1);
    if (existing) {
      // Rotations & re-subscribes: refresh keys + ownership together.
      await db
        .update(pushSubscriptions)
        .set({ userId: session.user.id, p256dh, auth, userAgent, lastSeenAt: new Date() })
        .where(eq(pushSubscriptions.id, existing.id));
    } else {
      await db.insert(pushSubscriptions).values({
        userId: session.user.id,
        endpoint,
        p256dh,
        auth,
        userAgent,
      });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const body = await request.json().catch(() => ({}));
    const endpoint = String(body.endpoint || "").trim();
    if (!endpoint) {
      return NextResponse.json({ success: false, error: "endpoint is required." }, { status: 400 });
    }
    await removeSubscription(endpoint, session.user.id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
