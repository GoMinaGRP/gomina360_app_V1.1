// Notification bell — every signed-in user gets a bell on their dashboard.
// Audit issues & corrections routed to them, and responses routed to the
// reviewing auditor, land here in real time.

import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { auditReviews, notifications } from "@/db/schema";
import { getSessionInfo, resolveUserOrgIds, UNAUTHENTICATED } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";

const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];
const OPEN_STATUSES = ["FLAGGED", "CORRECTION_REQUIRED", "OPEN"];

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.id)).limit(60);
    const unreadCount = rows.filter((n) => !n.isRead).length;
    // Issues still waiting on ME (flagged or correction required) — SQL-scoped
    // instead of a full-table scan, and the legacy workerName match is
    // additionally limited to MY organization(s) so a same-name user in
    // another tenant never inflates (or peeks at) my open-work counter.
    const name = String(user.name || "").trim();
    const all = await db
      .select()
      .from(auditReviews)
      .where(
        and(
          name
            ? or(eq(auditReviews.assignedUserId, user.id), ilike(auditReviews.workerName, name))
            : eq(auditReviews.assignedUserId, user.id),
          inArray(auditReviews.status, OPEN_STATUSES),
        ),
      );
    const orgIds = new Set<number>();
    if (all.some((r) => r.assignedUserId == null)) {
      for (const o of await resolveUserOrgIds(user)) orgIds.add(Number(o));
      if (user.orgId != null) orgIds.add(Number(user.orgId));
    }
    let openAssignedCount = 0;
    for (const r of all) {
      if (!ISSUE_ACTIONS.includes(r.action)) continue;
      if (r.assignedUserId === user.id) { openAssignedCount++; continue; }
      if (r.assignedUserId != null || r.businessId == null) continue;
      const org = await ownerOrgOfBusiness(Number(r.businessId));
      if (org != null && orgIds.has(Number(org))) openAssignedCount++;
    }
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
    // One batched UPDATE scoped to the caller's own rows (the userId=me guard
    // lives inside the WHERE, so no cross-user write is ever possible).
    if (body.all === true) {
      const updated = await db
        .update(notifications)
        .set({ isRead: true })
        .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)))
        .returning({ id: notifications.id });
      return NextResponse.json({ success: true, marked: updated.length });
    }
    const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter((x: number) => Number.isFinite(x)) : [];
    if (ids.length === 0) return NextResponse.json({ success: true, marked: 0 });
    const updated = await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, user.id), inArray(notifications.id, ids.slice(0, 200))))
      .returning({ id: notifications.id });
    return NextResponse.json({ success: true, marked: updated.length });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
