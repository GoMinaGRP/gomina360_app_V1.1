/**
 * Farm Advisor — advisory notes (the ONLY records an advisor may create).
 *
 *   GET    ?businessId=&flockId=&status=  → notes + replies, scoped to the
 *          caller (advisor ⇒ their grant; staff ⇒ their business access).
 *   POST   → the advisor files an observation / recommendation / follow-up /
 *            visit report / risk. The note is analysed by the existing GoMina
 *            AI daily-notes engine, folded into the business insights, and
 *            (when it requires action) escalated into the EXISTING audit issue
 *            pipeline so somebody must close it. Owner + managers are notified.
 *   PATCH  → { id, action }
 *            advisor: EDIT (24 h) | WITHDRAW | REPLY
 *            staff  : ACKNOWLEDGE | START | DONE | CLOSE | REPLY
 *
 * Every mutation writes to the immutable audit trail.
 */

import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  advisorNoteReplies,
  advisorNotes,
  auditIssueUpdates,
  auditReviews,
  businesses,
  poultryFlocks,
  users,
} from "@/db/schema";
import {
  accessibleBusinessIds,
  canAccessBusiness,
  getSessionInfo,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import {
  advisorGrantFor,
  grantCoversBranch,
  grantCoversFlock,
  isAdvisor,
} from "@/lib/advisorAccess";
import {
  advisoryRecipients,
  analyzeAdvisoryNote,
  notifyUsers,
  rebuildBusinessInsights,
  todayISO,
} from "@/lib/advisorServer";
import { auditLog } from "@/lib/audit";
import { apiError } from "@/lib/apiError";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { throttle, clientIp } from "@/lib/rateLimit";

const NOTE_TYPES = ["OBSERVATION", "RECOMMENDATION", "FOLLOW_UP", "VISIT_REPORT", "RISK"];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const MAX_BODY = 4000;
const MAX_PHOTOS = 4;
const MAX_PHOTO_CHARS = 900_000; // ~650 KB per data URL
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const STAFF_ACTIONS = ["ACKNOWLEDGE", "START", "DONE", "CLOSE", "REPLY"];
const ADVISOR_ACTIONS = ["EDIT", "WITHDRAW", "REPLY"];

const cleanPhotos = (v: any): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((p) => typeof p === "string" && p.startsWith("data:image/") && p.length <= MAX_PHOTO_CHARS)
    .slice(0, MAX_PHOTOS);

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const { searchParams } = new URL(request.url);
    const businessIdParam = searchParams.get("businessId");
    const businessId = businessIdParam ? Number(businessIdParam) : null;

    let ids: number[];
    if (businessId) {
      if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that business.");
      ids = [businessId];
    } else {
      ids = (await accessibleBusinessIds(me)) ?? [];
      if (!ids.length) {
        const rows = await db.select().from(advisorNotes).orderBy(desc(advisorNotes.id));
        return NextResponse.json({ success: true, notes: me.isSuperAdmin ? rows : [], replies: [] });
      }
    }

    let notes = await db.select().from(advisorNotes).where(inArray(advisorNotes.businessId, ids)).orderBy(desc(advisorNotes.id));

    // Advisors only ever see notes inside their own grant (branch + flock).
    if (isAdvisor(me)) {
      const out: any[] = [];
      for (const n of notes) {
        const grant = await advisorGrantFor(me, n.businessId);
        if (grant && grantCoversBranch(grant, n.branchCode) && grantCoversFlock(grant, n.flockId)) out.push(n);
      }
      notes = out;
    }

    const flockId = searchParams.get("flockId");
    if (flockId) notes = notes.filter((n) => Number(n.flockId) === Number(flockId));
    const status = searchParams.get("status");
    if (status) notes = notes.filter((n) => String(n.status) === status);

    const replies = notes.length
      ? await db.select().from(advisorNoteReplies).where(inArray(advisorNoteReplies.noteId, notes.map((n) => n.id)))
      : [];

    return NextResponse.json({ success: true, notes, replies });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;

    const limited = throttle(clientIp(request), { key: `advisor-note:${me.id}`, limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    const body = await request.json();
    const businessId = Number(body.businessId);
    const title = String(body.title || "").trim();
    const text = String(body.body || "").trim();
    if (!businessId || !title || !text) {
      return NextResponse.json({ success: false, error: "businessId, title and body are required." }, { status: 400 });
    }
    if (text.length > MAX_BODY) {
      return NextResponse.json({ success: false, error: `Notes are limited to ${MAX_BODY} characters.` }, { status: 400 });
    }
    if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You do not have access to that business.");

    // Only the farm's advisor (or the Owner/managers, who may record advisory
    // outcomes on the advisor's behalf) may file notes.
    const grant = await advisorGrantFor(me, businessId);
    if (isAdvisor(me) && !grant) return FORBIDDEN("Your advisory access to this farm is not active.");

    const noteType = NOTE_TYPES.includes(String(body.noteType)) ? String(body.noteType) : "OBSERVATION";
    const priority = PRIORITIES.includes(String(body.priority)) ? String(body.priority) : "MEDIUM";
    const observationDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.observationDate || ""))
      ? String(body.observationDate)
      : todayISO();
    if (observationDate > todayISO()) {
      return NextResponse.json({ success: false, error: "A note cannot be dated in the future." }, { status: 400 });
    }

    // Flock / branch must sit inside the advisor's grant.
    let flock: any = null;
    if (body.flockId) {
      const [f] = await db.select().from(poultryFlocks).where(eq(poultryFlocks.id, Number(body.flockId)));
      if (!f || Number(f.businessId) !== businessId) {
        return NextResponse.json({ success: false, error: "That flock does not belong to this farm." }, { status: 400 });
      }
      if (isAdvisor(me) && !grantCoversFlock(grant, f.id)) {
        return FORBIDDEN("That flock is outside your advisory scope.");
      }
      flock = f;
    }
    const branchCode = flock?.branchCode ?? (body.branchCode ? String(body.branchCode) : null);
    if (isAdvisor(me) && !grantCoversBranch(grant, branchCode)) {
      return FORBIDDEN("That branch is outside your advisory scope.");
    }

    const requiresAction = body.requiresAction === true;
    let assigned: any = null;
    if (requiresAction && body.assignedUserId) {
      const [u] = await db.select().from(users).where(eq(users.id, Number(body.assignedUserId)));
      if (u && (await canAccessBusiness(u, businessId))) assigned = u;
    }

    const analysis = await analyzeAdvisoryNote(businessId, title, text, observationDate);

    const [row] = await db
      .insert(advisorNotes)
      .values({
        businessId,
        branchCode,
        flockId: flock?.id ?? null,
        batchNumber: flock?.batchNumber ?? (body.batchNumber ? String(body.batchNumber) : null),
        visitId: body.visitId ? Number(body.visitId) : null,
        noteType,
        title: title.slice(0, 200),
        body: text,
        observationDate,
        priority,
        category: body.category ? String(body.category).toUpperCase().slice(0, 40) : null,
        recordType: body.recordType ? String(body.recordType) : null,
        recordSource: body.recordSource ? String(body.recordSource) : null,
        recordId: body.recordId ? Number(body.recordId) : null,
        recordRef: body.recordRef ? String(body.recordRef) : null,
        recordTitle: body.recordTitle ? String(body.recordTitle) : null,
        photos: cleanPhotos(body.photos),
        requiresAction,
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || "")) ? String(body.dueDate) : null,
        assignedUserId: assigned?.id ?? null,
        assignedUserName: assigned?.name ?? null,
        assignedUserRole: assigned?.role ?? null,
        status: "SUBMITTED",
        aiSummary: analysis.summary,
        aiIssues: analysis.issues,
        aiSeverity: analysis.severity,
        aiFlags: analysis.flags,
        authorUserId: me.id,
        authorName: me.name,
        authorRole: me.role,
        ownerId: await ownerOrgOfBusiness(businessId),
      })
      .returning();

    // ── Accountability: reuse the EXISTING audit issue pipeline ──────────
    let issueId: number | null = null;
    if (requiresAction) {
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
      const [issue] = await db
        .insert(auditReviews)
        .values({
          recordType: row.recordType || "ADVISORY_NOTE",
          recordSource: row.recordSource || "advisor_notes",
          recordId: row.recordId || row.id,
          recordRef: row.recordRef || `ADV-${row.id}`,
          recordTitle: row.title,
          module: "OPERATIONS",
          origin: "ADVISORY",
          businessId,
          branchCode,
          action: "CORRECTION_REQUESTED",
          status: "FLAGGED",
          priority,
          issueTitle: `Advisory: ${row.title}`.slice(0, 200),
          reason: `Farm Advisor recommendation (${noteType.toLowerCase().replace("_", " ")}) — ${analysis.summary}`,
          comment: text.slice(0, 1000),
          assignedUserId: assigned?.id ?? null,
          assignedUserName: assigned?.name ?? null,
          assignedUserRole: assigned?.role ?? null,
          reviewerUserId: me.id,
          reviewerName: me.name,
          reviewerRole: me.role,
        })
        .returning();
      issueId = issue.id;
      await db.insert(auditIssueUpdates).values({
        issueId: issue.id,
        actorUserId: me.id,
        actorName: me.name,
        actorRole: me.role,
        action: "REQUEST_CORRECTION",
        statusFrom: null,
        statusTo: "FLAGGED",
        note: `Raised from Farm Advisor note #${row.id}${biz ? ` on ${biz.name}` : ""}`,
      });
      await db.update(advisorNotes).set({ linkedIssueId: issue.id }).where(eq(advisorNotes.id, row.id));
    }

    // ── Notifications: Owner + managers (advisor excluded) ───────────────
    const recipients = await advisoryRecipients(businessId, priority, [me.id]);
    const extra = assigned?.id && !recipients.includes(Number(assigned.id)) ? [Number(assigned.id)] : [];
    await notifyUsers([...recipients, ...extra], {
      type: analysis.severity === "URGENT" || priority === "CRITICAL" ? "ADVISOR_URGENT" : "ADVISOR_NOTE_ADDED",
      title: `Farm Advisor: ${row.title}`.slice(0, 200),
      body: `${analysis.summary}${requiresAction ? " · action required" : ""}`,
      businessId,
      branchCode,
      recordType: "ADVISOR_NOTE",
      recordId: row.id,
      recordRef: `ADV-${row.id}`,
      actorName: me.name,
      priority,
      url: "/?tab=ADVISORY",
    });
    if (assigned?.id) {
      await notifyUsers([Number(assigned.id)], {
        type: "ADVISOR_FOLLOWUP_ASSIGNED",
        title: `Advisory follow-up assigned: ${row.title}`.slice(0, 200),
        body: row.dueDate ? `Due ${row.dueDate}.` : "Please action and close this advisory item.",
        businessId,
        branchCode,
        recordType: "ADVISOR_NOTE",
        recordId: row.id,
        recordRef: `ADV-${row.id}`,
        actorName: me.name,
        priority,
        url: "/?tab=ADVISORY",
      });
    }

    await auditLog(
      me, "ADVISOR_NOTE_CREATE", "RECORD", row.title, "ADVISOR_NOTE", row.id, businessId, branchCode,
      `${noteType} · ${priority} · AI ${analysis.severity}${issueId ? ` · escalated as issue #${issueId}` : ""}`,
      session.orgId ?? null,
    );

    return NextResponse.json({ success: true, note: { ...row, linkedIssueId: issueId }, analysis });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const id = Number(body.id);
    const action = String(body.action || "").toUpperCase();
    if (!id || !action) return NextResponse.json({ success: false, error: "id and action are required." }, { status: 400 });

    const [note] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, id));
    if (!note) return NextResponse.json({ success: false, error: "Note not found." }, { status: 404 });
    if (!(await canAccessBusiness(me, note.businessId))) return FORBIDDEN("You do not have access to that business.");

    const mine = Number(note.authorUserId) === Number(me.id);
    if (isAdvisor(me)) {
      if (!ADVISOR_ACTIONS.includes(action)) return FORBIDDEN("Advisors may edit, withdraw or reply to their own notes only.");
      if (!mine) return FORBIDDEN("You can only change your own advisory notes.");
      const grant = await advisorGrantFor(me, note.businessId);
      if (!grant) return FORBIDDEN("Your advisory access to this farm is not active.");
    } else if (!STAFF_ACTIONS.includes(action)) {
      return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
    }

    const statusFrom = note.status;
    let statusTo = note.status;
    const patch: any = { updatedAt: new Date() };
    let trailAction = `ADVISOR_NOTE_${action}`;
    let replyBody: string | null = body.body ? String(body.body).slice(0, 2000) : null;

    switch (action) {
      case "EDIT": {
        const age = note.createdAt ? Date.now() - new Date(note.createdAt).getTime() : 0;
        if (age > EDIT_WINDOW_MS) {
          return FORBIDDEN("Advisory notes can only be edited within 24 hours — add a reply instead, so the record of the advice stays honest.");
        }
        if (note.withdrawnAt) return FORBIDDEN("This note was withdrawn.");
        if (body.title) patch.title = String(body.title).slice(0, 200);
        if (body.body) patch.body = String(body.body).slice(0, MAX_BODY);
        if (body.priority && PRIORITIES.includes(String(body.priority))) patch.priority = String(body.priority);
        if (body.dueDate !== undefined) patch.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || "")) ? String(body.dueDate) : null;
        if (body.photos !== undefined) patch.photos = cleanPhotos(body.photos);
        if (patch.title || patch.body) {
          const analysis = await analyzeAdvisoryNote(note.businessId, patch.title || note.title, patch.body || note.body, note.observationDate);
          patch.aiSummary = analysis.summary;
          patch.aiIssues = analysis.issues;
          patch.aiSeverity = analysis.severity;
          patch.aiFlags = analysis.flags;
        }
        replyBody = "Note edited by the advisor.";
        break;
      }
      case "WITHDRAW": {
        patch.withdrawnAt = new Date();
        patch.status = "CLOSED";
        statusTo = "CLOSED";
        replyBody = body.body ? String(body.body).slice(0, 2000) : "Advisor withdrew this note.";
        break;
      }
      case "ACKNOWLEDGE": {
        patch.status = "ACKNOWLEDGED";
        patch.acknowledgedByUserId = me.id;
        patch.acknowledgedByName = me.name;
        patch.acknowledgedAt = new Date();
        statusTo = "ACKNOWLEDGED";
        break;
      }
      case "START": {
        patch.status = "IN_PROGRESS";
        statusTo = "IN_PROGRESS";
        break;
      }
      case "DONE": {
        patch.status = "DONE";
        statusTo = "DONE";
        break;
      }
      case "CLOSE": {
        patch.status = "CLOSED";
        patch.closedByUserId = me.id;
        patch.closedByName = me.name;
        patch.closedAt = new Date();
        patch.closureNote = body.closureNote ? String(body.closureNote).slice(0, 1000) : replyBody;
        statusTo = "CLOSED";
        break;
      }
      case "REPLY":
        if (!replyBody) return NextResponse.json({ success: false, error: "A reply needs a message." }, { status: 400 });
        break;
      default:
        return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
    }

    const [row] = await db.update(advisorNotes).set(patch).where(eq(advisorNotes.id, id)).returning();
    await db.insert(advisorNoteReplies).values({
      noteId: id,
      actorUserId: me.id,
      actorName: me.name,
      actorRole: me.role,
      action,
      statusFrom,
      statusTo,
      body: replyBody,
      photo: typeof body.photo === "string" && body.photo.startsWith("data:image/") && body.photo.length <= MAX_PHOTO_CHARS ? body.photo : null,
    });

    // Keep the linked audit issue in step (single pipeline, no duplication).
    if (note.linkedIssueId && ["DONE", "CLOSE", "WITHDRAW"].includes(action)) {
      const issueStatus = action === "WITHDRAW" ? "VERIFIED" : action === "CLOSE" ? "VERIFIED" : "RESOLVED";
      await db.update(auditReviews).set({
        status: issueStatus,
        resolvedByUserId: me.id,
        resolvedByName: me.name,
        resolvedAt: new Date(),
        resolutionNote: replyBody,
      }).where(eq(auditReviews.id, note.linkedIssueId));
      await db.insert(auditIssueUpdates).values({
        issueId: note.linkedIssueId,
        actorUserId: me.id,
        actorName: me.name,
        actorRole: me.role,
        action: action === "DONE" ? "MARK_RESOLVED" : "VERIFY",
        statusFrom: null,
        statusTo: issueStatus,
        note: replyBody,
      });
    }

    // Withdrawn advice must stop colouring the AI's memory of the business.
    if (action === "WITHDRAW") await rebuildBusinessInsights(note.businessId);

    // Route the event to the other side of the conversation.
    const targets = isAdvisor(me)
      ? await advisoryRecipients(note.businessId, note.priority, [me.id])
      : [Number(note.authorUserId)].filter((x) => x !== Number(me.id));
    await notifyUsers(targets, {
      type: action === "REPLY" ? "ADVISOR_NOTE_REPLY" : "ADVISOR_NOTE_UPDATE",
      title: `Advisory note ${action.toLowerCase()}: ${note.title}`.slice(0, 200),
      body: replyBody || `Status: ${statusTo}`,
      businessId: note.businessId,
      branchCode: note.branchCode,
      recordType: "ADVISOR_NOTE",
      recordId: note.id,
      recordRef: `ADV-${note.id}`,
      actorName: me.name,
      priority: note.priority,
      url: "/?tab=ADVISORY",
    });

    await auditLog(
      me, trailAction, "RECORD", note.title, "ADVISOR_NOTE", note.id, note.businessId, note.branchCode,
      `${statusFrom} → ${statusTo}${replyBody ? ` · ${replyBody.slice(0, 160)}` : ""}`,
      session.orgId ?? null,
    );

    return NextResponse.json({ success: true, note: row });
  } catch (error: any) {
    return apiError(error);
  }
}
