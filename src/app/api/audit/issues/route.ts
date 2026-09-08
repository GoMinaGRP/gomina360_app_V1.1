// My Audit Issues — the assigned user's side of the issue workflow.
// Any signed-in user can open this: it returns ONLY the issues routed to
// them (assigned_user_id = me, or a legacy name-matched flag), each still
// linked to the original checklist / activity / record. Responding (with
// notes + photo evidence) moves the issue to UNDER_REVIEW; completing the
// correction moves it to RESOLVED — both land on the reviewer's bell and on
// the immutable audit trail.

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, auditIssueUpdates, auditReviews, auditTrail, notifications } from "@/db/schema";
import { pushAfterBell } from "@/lib/push";
import { getSessionInfo, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

const ISSUE_ACTIONS = ["FLAGGED", "CORRECTION_REQUESTED"];
const normStatus = (s: string | null | undefined) => (s === "OPEN" ? "FLAGGED" : s || "INFO");
// States where the ball is in the assigned user's court.
const ACTIONABLE = ["FLAGGED", "CORRECTION_REQUIRED"];

async function myIssues(user: any) {
  const all = await db.select().from(auditReviews).orderBy(desc(auditReviews.id)).limit(800);
  return all
    .filter((r) => ISSUE_ACTIONS.includes(r.action))
    .filter((r) => r.assignedUserId === user.id || (r.assignedUserId == null && r.workerName && r.workerName.toLowerCase() === (user.name || "").toLowerCase()))
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
      const ids = new Set(issues.map((i) => i.id));
      const upd = await db.select().from(auditIssueUpdates).orderBy(desc(auditIssueUpdates.id)).limit(800);
      for (const u of upd) {
        if (!ids.has(u.issueId)) continue;
        (threads[u.issueId] ||= []).unshift(u);
      }
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
    const mine = row.assignedUserId === user.id || (row.assignedUserId == null && row.workerName && row.workerName.toLowerCase() === (user.name || "").toLowerCase());
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
    });
    const issueNotifType = action === "RESPOND" ? "AUDIT_ISSUE_RESPONSE" : "AUDIT_ISSUE_RESOLVED";
    const issueNotifTitle = `${action === "RESPOND" ? "Response ready for review" : "Marked resolved"}: ${row.issueTitle || row.recordRef}`;
    await db.insert(notifications).values({
      userId: row.reviewerUserId,
      type: issueNotifType,
      title: issueNotifTitle,
      body: note.slice(0, 600),
      issueId: row.id, recordType: row.recordType, recordId: row.recordId, recordRef: row.recordRef,
      businessId: row.businessId, branchCode: row.branchCode, actorName: user.name,
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
