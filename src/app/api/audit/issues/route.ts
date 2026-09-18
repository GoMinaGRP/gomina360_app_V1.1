// My Audit Issues — the assigned user's side of the issue workflow.
// Any signed-in user can open this: it returns ONLY the issues routed to
// them (assigned_user_id = me, or a legacy name-matched flag), each still
// linked to the original checklist / activity / record. Responding (with
// notes + photo evidence) moves the issue to UNDER_REVIEW; completing the
// correction moves it to RESOLVED — both land on the reviewer's bell and on
// the immutable audit trail.

import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { businesses, auditIssueUpdates, auditReviews, auditTrail, notifications } from "@/db/schema";
import { pushAfterBell } from "@/lib/push";
import { getSessionInfo, resolveUserOrgIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";

const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];
const normStatus = (s: string | null | undefined) => (s === "OPEN" ? "FLAGGED" : s || "INFO");

/** Legacy workerName-matched issues must never cross tenants: the fuzzy name
 *  path only applies when the issue's business sits in an organization the
 *  signed-in user belongs to (direct assignment by userId is already exact). */
function ownsByName(row: any, user: any, bizOrg: Map<number, number | null>, orgIds: Set<number>) {
  if (row.assignedUserId != null) return false;
  if (!row.workerName || row.workerName.toLowerCase() !== (user.name || "").toLowerCase()) return false;
  const org = row.businessId != null ? bizOrg.get(Number(row.businessId)) : null;
  return org != null && orgIds.has(Number(org));
}

async function myIssues(user: any) {
  // SQL-scoped: only rows plausibly mine (exact assignment or exact name
  // match); the org guard below decides which name matches actually count.
  const name = String(user.name || "").trim();
  const all = await db
    .select()
    .from(auditReviews)
    .where(
      name
        ? or(eq(auditReviews.assignedUserId, user.id), ilike(auditReviews.workerName, name))
        : eq(auditReviews.assignedUserId, user.id),
    )
    .orderBy(desc(auditReviews.id))
    .limit(400);
  const bizIds = [...new Set(all.map((a) => a.businessId).filter((x): x is number => x != null))];
  const bizOrg: Map<number, number | null> = new Map();
  await Promise.all(bizIds.map(async (b) => bizOrg.set(Number(b), await ownerOrgOfBusiness(Number(b)))));
  const orgIds = new Set<number>((await resolveUserOrgIds(user)).map(Number));
  if (user.orgId != null) orgIds.add(Number(user.orgId));
  return all
    .filter((r) => ISSUE_ACTIONS.includes(r.action))
    .filter((r) => r.assignedUserId === user.id || ownsByName(r, user, bizOrg, orgIds))
    .map((r) => ({ ...r, status: normStatus(r.status) }));
}

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const issues = await myIssues(user);
    const threads: Record<number, any[]> = {};
    if (issues.length > 0) {
      const ids = issues.map((i) => i.id);
      const upd = await db
        .select()
        .from(auditIssueUpdates)
        .where(inArray(auditIssueUpdates.issueId, ids))
        .orderBy(desc(auditIssueUpdates.id))
        .limit(800);
      for (const u of upd) (threads[u.issueId] ||= []).unshift(u);
    }
    const bizRows = await db.select({ id: businesses.id, name: businesses.name, code: businesses.code }).from(businesses);
    const bizMap: Record<number, { name: string; code: string }> = {};
    for (const b of bizRows) bizMap[b.id] = { name: b.name, code: b.code };
    return NextResponse.json({ success: true, issues, threads, bizMap });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;
    const body = await request.json();
    const action = String(body.action || "").toUpperCase(); // RESPOND | MARK_RESOLVED
    if (!["RESPOND", "MARK_RESOLVED"].includes(action)) {
      return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
    }
    const [row] = await db.select().from(auditReviews).where(eq(auditReviews.id, Number(body.issueId)));
    if (!row) return NextResponse.json({ success: false, error: "Issue not found." }, { status: 404 });
    // Org guard on the legacy name-match: acting on someone else's issue with
    // merely the same display name (another tenant) must 403.
    const rowBizOrg: Map<number, number | null> = new Map();
    if (row.businessId != null) rowBizOrg.set(Number(row.businessId), await ownerOrgOfBusiness(Number(row.businessId)));
    const myOrgIds = new Set<number>((await resolveUserOrgIds(user)).map(Number));
    if (user.orgId != null) myOrgIds.add(Number(user.orgId));
    const mine = row.assignedUserId === user.id || ownsByName(row, user, rowBizOrg, myOrgIds);
    if (!mine) return FORBIDDEN("This issue is assigned to a different user.");
    const from = normStatus(row.status);
    if (!ISSUE_ACTIONS.includes(row.action) || from === "VERIFIED") {
      return NextResponse.json({ success: false, error: "This issue is already verified & closed." }, { status: 400 });
    }
    const note = String(body.note || "").trim();
    if (!note) {
      return NextResponse.json({ success: false, error: "Write a response note so the auditor can review it." }, { status: 400 });
    }
    const evidence = String(body.evidence || "").trim();
    const photo = String(body.photo || "");
    if (photo && !photo.startsWith("data:image/")) {
      return NextResponse.json({ success: false, error: "Photo must be an image file." }, { status: 400 });
    }
    // RESPOND: provide an answer & evidence and send it back for review.
    // MARK_RESOLVED: correction completed — ready for verification.
    const to = action === "RESPOND" ? "UNDER_REVIEW" : "RESOLVED";
    if (action === "MARK_RESOLVED") {
      // The assignee's work is done — retire every earlier bell item for this
      // issue (their assignment notice + manager/Owner watches). The fresh
      // "Marked resolved" notice below is the reviewer's open action item.
      await db.update(notifications).set({ isRead: true }).where(eq(notifications.issueId, row.id));
    }
    const [updated] = await db.update(auditReviews)
      .set({
        status: to,
        responseNote: note,
        responseEvidence: evidence || null,
        responsePhoto: photo || null,
        responseByName: user.name,
        responseAt: new Date(),
      })
      .where(eq(auditReviews.id, row.id))
      .returning();
    await db.insert(auditIssueUpdates).values({
      issueId: row.id,
      actorUserId: user.id, actorName: user.name, actorRole: user.role,
      action: action === "RESPOND" ? "MARK_REVIEW" : "MARK_RESOLVED",
      statusFrom: from, statusTo: to,
      note, evidence: evidence || null, photo: photo || null,
    });
    await db.insert(auditTrail).values({
      actorUserId: user.id, actorName: user.name, actorRole: user.role,
      action: action === "RESPOND" ? "RESPOND" : "MARK_RESOLVED",
      targetType: "RECORD", targetLabel: row.recordRef || row.recordTitle,
      recordType: row.recordType, recordId: row.recordId,
      businessId: row.businessId, branchCode: row.branchCode,
      reason: row.reason, detail: `${from} → ${to}: ${note}`,
      ownerId: row.businessId != null ? await ownerOrgOfBusiness(Number(row.businessId)) : (user.orgId ?? null),
    });
    const issueNotifType = action === "RESPOND" ? "AUDIT_ISSUE_RESPONSE" : "AUDIT_ISSUE_RESOLVED";
    const prio = String(row.priority || "MEDIUM").toUpperCase();
    const issueNotifTitle = `${action === "RESPOND" ? "Response ready for review" : "Marked resolved"} [${prio}]: ${row.issueTitle || row.recordRef}`;
    await db.insert(notifications).values({
      userId: row.reviewerUserId,
      type: issueNotifType,
      title: issueNotifTitle,
      body: `${note.slice(0, 520)}\nRequired action: open the Audit Command Center and verify to close (or request another correction).`,
      issueId: row.id, recordType: row.recordType, recordId: row.recordId, recordRef: row.recordRef,
      businessId: row.businessId, branchCode: row.branchCode, actorName: user.name,
      ownerId: row.businessId != null ? await ownerOrgOfBusiness(Number(row.businessId)) : (user.orgId ?? null),
    });
    pushAfterBell([Number(row.reviewerUserId)], {
      type: issueNotifType,
      title: issueNotifTitle,
      body: note.slice(0, 600),
      url: "/?tab=AUDIT",
    });
    return NextResponse.json({ success: true, review: updated });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
