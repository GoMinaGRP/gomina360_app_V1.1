import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPushSettings } from "@/db/schema";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { PUSH_CATEGORIES } from "@/lib/push";

/**
 * Per-user notification settings — master switch + per-category toggles
 * (orders, approvals, alerts, tasks, messages, reports). GET auto-creates
 * the row with everything ON the first time a user opens the settings.
 */
export async function GET(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    let [row] = await db.select().from(userPushSettings).where(eq(userPushSettings.userId, session.user.id));
    if (!row) {
      [row] = await db.insert(userPushSettings).values({ userId: session.user.id }).returning();
    }
    return NextResponse.json({ success: true, settings: toClient(row) });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const session = await getSessionInfo(request);
  if (!session) return UNAUTHENTICATED();
  try {
    const body = await request.json().catch(() => ({}));
    let [row] = await db.select().from(userPushSettings).where(eq(userPushSettings.userId, session.user.id));
    if (!row) {
      [row] = await db.insert(userPushSettings).values({ userId: session.user.id }).returning();
    }
    const patch: any = { updatedAt: new Date() };
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    for (const cat of PUSH_CATEGORIES) {
      if (body[cat] !== undefined) patch[cat] = Boolean(body[cat]);
    }
    const [updated] = await db
      .update(userPushSettings)
      .set(patch)
      .where(eq(userPushSettings.userId, session.user.id))
      .returning();
    return NextResponse.json({ success: true, settings: toClient(updated) });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function toClient(row: any) {
  return {
    enabled: row.enabled !== false,
    orders: row.orders !== false,
    approvals: row.approvals !== false,
    alerts: row.alerts !== false,
    tasks: row.tasks !== false,
    messages: row.messages !== false,
    reports: row.reports !== false,
    updatedAt: row.updatedAt,
  };
}
