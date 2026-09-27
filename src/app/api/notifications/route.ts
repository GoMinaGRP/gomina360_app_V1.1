// Notification bell — every signed-in user gets a bell on their dashboard.
// Audit issues & corrections routed to them, and responses routed to the
// reviewing auditor, land here in real time.

import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditReviews, notifications } from "@/db/schema";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { businesses } from "@/db/schema";

const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];
const OPEN_STATUSES = ["FLAGGED", "CORRECTION_REQUIRED", "OPEN"];

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const rows = await db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.id)).limit(60);
    const unreadCount = rows.filter((n) => !n.isRead).length;
    // Issues still waiting on ME (flagged or correction required) — two indexed
    // COUNT queries and no row transfer. This used to read the whole
    // audit_reviews table and issue one ownerOrgOfBusiness() lookup PER legacy
    // row on EVERY 30 s bell poll — an N+1 that grew with the audit trail.
    // The legacy workerName match additionally joins businesses once so the
    // tenant check (my organizations only) happens in SQL, not per row.
    const name = String(user.name || "").trim();
    const orgIds = Array.from(
      new Set<number>([
        ...((session.orgIds as number[] | undefined) || []).map((o) => Number(o)),
        ...(session.orgId != null ? [Number(session.orgId)] : []),
      ]),
    );
    const openCommon = [inArray(auditReviews.status, OPEN_STATUSES), inArray(auditReviews.action, ISSUE_ACTIONS)];
    const [mineRows, legacyRows] = await Promise.all([
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(auditReviews)
        .where(and(eq(auditReviews.assignedUserId, user.id), ...openCommon)),
      name && orgIds.length
        ? db
            .select({ c: sql<number>`count(*)::int` })
            .from(auditReviews)
            .innerJoin(businesses, eq(businesses.id, auditReviews.businessId))
            .where(
              and(
                isNull(auditReviews.assignedUserId),
                ilike(auditReviews.workerName, name),
                inArray(businesses.ownerId, orgIds),
                ...openCommon,
              ),
            )
        : Promise.resolve([{ c: 0 } as { c: number }]),
    ]);
    const openAssignedCount = Number(mineRows[0]?.c || 0) + Number(legacyRows[0]?.c || 0);
    return NextResponse.json({ success: true, notifications: rows, unreadCount, openAssignedCount });
  } catch (error: any) {
    return apiError(error);
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
    return apiError(error);
  }
}
