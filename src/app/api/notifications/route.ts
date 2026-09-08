// Notification bell — every signed-in user gets a bell on their dashboard.
// Audit issues & corrections routed to them, and responses routed to the
// reviewing auditor, land here in real time.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditReviews, notifications } from "@/db/schema";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.id)).limit(60);
    const unreadCount = rows.filter((n) => !n.isRead).length;
    // Issues still waiting on ME (flagged or correction required).
    const all = await db.select().from(auditReviews);
    const openAssignedCount = all.filter(
      (r) => ISSUE_ACTIONS.includes(r.action) &&
        (r.assignedUserId === user.id || (r.assignedUserId == null && r.workerName && r.workerName.toLowerCase() === (user.name || "").toLowerCase())) &&
        ["FLAGGED", "CORRECTION_REQUIRED", "OPEN"].includes(r.status)
    ).length;
    return NextResponse.json({ success: true, notifications: rows, unreadCount, openAssignedCount });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const mine = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    const ids: number[] = body.all === true ? mine.map((n) => n.id) : (Array.isArray(body.ids) ? body.ids.map(Number) : []);
    const target = new Set(ids.filter((id) => mine.some((n) => n.id === id)));
    for (const id of target) {
      await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, id));
    }
    return NextResponse.json({ success: true, marked: target.size });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
