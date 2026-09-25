// Farm Advisor Notes — observations / recommendations / follow-ups linked to
// a farm unit, a farm day, optionally a flock/batch and any record.
//
//   GET    ?businessId=        → scoped notes + follow-up stats (advisor sees
//                                their assigned units; staff see their units)
//          ?noteId=            → one note + its immutable update thread
//          ?console=1          → cross-unit console summary (advisor: own
//                                assignments; OWNER/GM: whole organization)
//   POST   { businessId, noteDate, flockId?, batchId?, record link?, category,
//            priority, title, body, photo?, followUpDueDate? }
//          → analyzed by the shared GoMina AI engine + benchmark-KPI
//            corroboration, folded into business_insights, bell/push
//            notifications (escalation on HIGH/CRITICAL), audit trail.
//   PATCH  { id, action: "RESPOND" | "STATUS" | "EDIT", … }
//          → immutable advisor_note_updates rows + notifications + audit.
//
// Never a DELETE: notes are the farm's guidance history — a withdrawn note is
// CLOSED with a reason, never erased (the AI memory and audit trail stay true).

import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  advisorAssignments,
  advisorNoteUpdates,
  advisorNotes,
  aquacultureBatches,
  auditTrail,
  businesses,
  dailyNotes,
  businessInsights,
  checklistEntries,
  notifications,
  poultryFlocks,
  ADVISOR_FOLLOWUP_STATUSES,
  ADVISOR_NOTE_CATEGORIES,
  ADVISOR_NOTE_PRIORITIES,
} from "@/db/schema";
import {
  canAccessBusiness,
  accessibleBusinessIds,
  getSessionInfo,
  isFarmAdvisor,
  FORBIDDEN,
  UNAUTHENTICATED,
} from "@/lib/auth";
import { auditEscalationRecipients, ownerOrgOfBusiness } from "@/lib/notify";
import { pushAfterBell } from "@/lib/push";
import { apiError } from "@/lib/apiError";
import {
  analyzeAdvisorNote,
  corroborateAdvisorNote,
  type AdvisorCorroboration,
} from "@/lib/advisorAi";
import {
  foldNoteIntoInsights,
  rebuildInsights,
  type HistoryEntry,
  type InsightsState,
  type NoteAnalysis,
} from "@/lib/dailyNotesAi";
import { aquacultureFeedLogs, aquacultureHarvests, aquacultureWaterQualityLogs, poultryFeedLogs, poultryWeightLogs } from "@/db/schema";

const STAFF_NOTE_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

const isNoteStaff = (user: any) =>
  STAFF_NOTE_ROLES.includes(String(user?.role || "").toUpperCase()) || user?.canManageRecords === true;

/** May this session read advisor notes at all? (advisor / manager / records-
 *  authorized staff — workers monitor through their own workspace instead). */
async function canReadNotes(user: any): Promise<boolean> {
  return isFarmAdvisor(user) || isNoteStaff(user);
}

/* ── business insights upsert (shared with the daily-notes engine) ────── */

function toInsights(row: any): InsightsState {
  return {
    notesAnalyzed: row?.notesAnalyzed || 0,
    lastNoteDate: row?.lastNoteDate ?? null,
    rollingSummary: row?.rollingSummary ?? null,
    issueRegister: Array.isArray(row?.issueRegister) ? row.issueRegister : [],
    categoryTrends: row?.categoryTrends || {},
    history: Array.isArray(row?.history) ? row.history : [],
  };
}

async function upsertInsights(businessId: number, state: InsightsState) {
  const [existing] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
  const payload = {
    notesAnalyzed: state.notesAnalyzed,
    lastNoteDate: state.lastNoteDate,
    rollingSummary: state.rollingSummary,
    issueRegister: state.issueRegister,
    categoryTrends: state.categoryTrends,
    history: state.history,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(businessInsights).set(payload).where(eq(businessInsights.id, existing.id));
  } else {
    await db.insert(businessInsights).values({ businessId, ...payload });
  }
}

/** Rebuild the insights memory from BOTH note streams (daily + advisor) in
 *  chronological order — used after an in-window EDIT so the AI memory never
 *  carries a superseded analysis. */
async function rebuildInsightsWithAdvisorNotes(businessId: number) {
  const [daily, advisor] = await Promise.all([
    db.select().from(dailyNotes).where(eq(dailyNotes.businessId, businessId)),
    db.select().from(advisorNotes).where(eq(advisorNotes.businessId, businessId)),
  ]);
  const asAnalysis = (r: any): { noteDate: string; analysis: NoteAnalysis } => ({
    noteDate: r.noteDate,
    analysis: {
      summary: r.aiSummary || "",
      issues: (r.aiIssues as any[]) || [],
      severity: (r.aiSeverity as any) || "INFO",
      flags: (r.aiFlags as string[]) || [],
    },
  });
  const all = [...daily.map(asAnalysis), ...advisor.map(asAnalysis)].sort(
    (a, b) => (a.noteDate > b.noteDate ? 1 : a.noteDate < b.noteDate ? -1 : 0),
  );
  if (all.length === 0) {
    await db.delete(businessInsights).where(eq(businessInsights.businessId, businessId));
    return;
  }
  await upsertInsights(businessId, rebuildInsights(all));
}

/* ── record-link resolver (snapshot pattern from the audit center) ────── */

const RECORD_TYPES = [
  "CHECKLIST_ENTRY",
  "POULTRY_FEED_LOG",
  "POULTRY_WEIGHT_LOG",
  "AQUA_FEED_LOG",
  "AQUA_WATER_LOG",
  "AQUA_HARVEST",
  "DAILY_NOTE",
] as const;

async function resolveRecordLink(
  recordType: string,
  recordId: number,
  businessId: number,
): Promise<{ ref: string; title: string } | null> {
  const one = async (t: any, w: any) => (await db.select().from(t).where(w))[0] || null;
  switch (recordType) {
    case "CHECKLIST_ENTRY": {
      const r = await one(checklistEntries, and(eq(checklistEntries.id, recordId), eq(checklistEntries.businessId, businessId)));
      return r ? { ref: `CHK-${r.checklistDate}-${r.id}`, title: `${r.taskLabel} — ${r.checklistDate}` } : null;
    }
    case "POULTRY_FEED_LOG": {
      const r = await one(poultryFeedLogs, and(eq(poultryFeedLogs.id, recordId), eq(poultryFeedLogs.businessId, businessId)));
      return r ? { ref: `FDL-${r.id}`, title: `${r.batchNumber || "Flock"} feed — ${r.feedType} ${r.quantityKg} kg (${r.recordedDate})` } : null;
    }
    case "POULTRY_WEIGHT_LOG": {
      const r = await one(poultryWeightLogs, and(eq(poultryWeightLogs.id, recordId), eq(poultryWeightLogs.businessId, businessId)));
      return r ? { ref: `WGT-${r.id}`, title: `${r.batchNumber} sample ${r.avgWeightG} g (${r.recordedDate})` } : null;
    }
    case "AQUA_FEED_LOG": {
      const r = await one(aquacultureFeedLogs, and(eq(aquacultureFeedLogs.id, recordId), eq(aquacultureFeedLogs.businessId, businessId)));
      return r ? { ref: `AFF-${r.id}`, title: `${r.batchNumber || "Batch"} feed — ${r.quantityKg} kg (${r.recordedDate})` } : null;
    }
    case "AQUA_WATER_LOG": {
      const r = await one(aquacultureWaterQualityLogs, and(eq(aquacultureWaterQualityLogs.id, recordId), eq(aquacultureWaterQualityLogs.businessId, businessId)));
      return r ? { ref: `WQ-${r.id}`, title: `Water sample pH ${r.phLevel} · DO ${r.dissolvedOxygenMgL} mg/L (${r.sampleDate})` } : null;
    }
    case "AQUA_HARVEST": {
      const r = await one(aquacultureHarvests, and(eq(aquacultureHarvests.id, recordId), eq(aquacultureHarvests.businessId, businessId)));
      return r ? { ref: `HVT-${r.id}`, title: `Harvest ${r.batchNumber || ""} (${r.harvestDate || r.recordedDate || ""})`.trim() } : null;
    }
    case "DAILY_NOTE": {
      const r = await one(dailyNotes, and(eq(dailyNotes.id, recordId), eq(dailyNotes.businessId, businessId)));
      return r ? { ref: `DN-${r.id}`, title: `Daily note by ${r.userName} (${r.noteDate})` } : null;
    }
    default:
      return null;
  }
}

/* ── notifications (existing bell + push machinery) ───────────────────── */

async function bell(
  userIds: number[],
  row: {
    type: string;
    title: string;
    body: string;
    recordId: number;
    recordRef: string;
    businessId: number;
    branchCode?: string | null;
    actorName?: string | null;
    priority?: string | null;
  },
  url: string,
) {
  if (!userIds.length) return;
  const ownerId = await ownerOrgOfBusiness(Number(row.businessId));
  for (const uid of userIds) {
    await db.insert(notifications).values({
      userId: Number(uid),
      type: row.type,
      title: row.title.slice(0, 240),
      body: (row.body || "").slice(0, 600) || null,
      recordType: "ADVISOR_NOTE",
      recordId: Number(row.recordId),
      recordRef: row.recordRef,
      businessId: Number(row.businessId),
      branchCode: row.branchCode ?? null,
      actorName: row.actorName ?? null,
      priority: row.priority ?? null,
      ownerId: ownerId ?? null,
    });
  }
  pushAfterBell(userIds.map(Number), {
    type: row.type,
    title: row.title.slice(0, 240),
    body: (row.body || "").slice(0, 600),
    url,
  });
}

/* ── enrichment for list responses ────────────────────────────────────── */

async function enrich(rows: any[]) {
  if (!rows.length) return rows;
  const flockIds = [...new Set(rows.map((r) => Number(r.flockId)).filter(Boolean))];
  const batchIds = [...new Set(rows.map((r) => Number(r.batchId)).filter(Boolean))];
  const bizIds = [...new Set(rows.map((r) => Number(r.businessId)))];
  const [flocks, batches, bizs] = await Promise.all([
    flockIds.length ? db.select().from(poultryFlocks).where(inArray(poultryFlocks.id, flockIds)) : [],
    batchIds.length ? db.select().from(aquacultureBatches).where(inArray(aquacultureBatches.id, batchIds)) : [],
    db.select().from(businesses).where(inArray(businesses.id, bizIds)),
  ]);
  return rows.map((n) => {
    const flock = flocks.find((f: any) => Number(f.id) === Number(n.flockId));
    const batch = batches.find((b: any) => Number(b.id) === Number(n.batchId));
    const biz = bizs.find((b: any) => Number(b.id) === Number(n.businessId));
    return {
      ...n,
      flockLabel: flock ? `${flock.batchNumber} (${flock.birdType})` : null,
      batchLabel: batch ? `${batch.batchNumber} (${batch.species})` : null,
      businessName: biz?.name || null,
      businessCode: biz?.code || null,
    };
  });
}

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS"];

function statsOf(rows: any[]) {
  const day = today();
  return {
    total: rows.length,
    open: rows.filter((n) => n.followUpStatus === "OPEN").length,
    inProgress: rows.filter((n) => n.followUpStatus === "IN_PROGRESS").length,
    addressed: rows.filter((n) => n.followUpStatus === "ADDRESSED").length,
    closed: rows.filter((n) => n.followUpStatus === "CLOSED").length,
    overdue: rows.filter(
      (n) => OPEN_STATUSES.includes(String(n.followUpStatus)) && n.followUpDueDate && String(n.followUpDueDate) < day,
    ).length,
  };
}

/* ═══ GET ═════════════════════════════════════════════════════════════ */

export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    if (!(await canReadNotes(user))) {
      return FORBIDDEN("Advisor notes are visible to the advisor, managers and records-authorized staff.");
    }
    const { searchParams } = new URL(request.url);
    const noteId = Number(searchParams.get("noteId"));

    // Single note + immutable thread.
    if (noteId) {
      const [note] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, noteId));
      if (!note) return NextResponse.json({ success: false, error: "Note not found." }, { status: 404 });
      if (!(await canAccessBusiness(user, Number(note.businessId)))) {
        return FORBIDDEN("No access to this business.");
      }
      const updates = await db
        .select()
        .from(advisorNoteUpdates)
        .where(eq(advisorNoteUpdates.noteId, noteId))
        .orderBy(advisorNoteUpdates.id);
      return NextResponse.json({ success: true, note: (await enrich([note]))[0], updates });
    }

    // Cross-unit console summary.
    if (searchParams.get("console")) {
      const allowed = await accessibleBusinessIds(user);
      const bids = allowed === null ? null : allowed.length ? allowed : [-1];
      const rows = bids === null
        ? await db.select().from(advisorNotes).orderBy(desc(advisorNotes.id)).limit(500)
        : await db.select().from(advisorNotes).where(inArray(advisorNotes.businessId, bids)).orderBy(desc(advisorNotes.id)).limit(500);
      const enriched = await enrich(rows);
      const openFollowUps = enriched
        .filter((n: any) => OPEN_STATUSES.includes(String(n.followUpStatus)))
        .sort((a: any, b: any) => {
          const ao = a.followUpDueDate || "9999-12-31";
          const bo = b.followUpDueDate || "9999-12-31";
          return ao < bo ? -1 : ao > bo ? 1 : 0;
        });
      const units = new Map<number, any>();
      for (const n of enriched as any[]) {
        if (!units.has(Number(n.businessId))) {
          units.set(Number(n.businessId), {
            businessId: Number(n.businessId),
            businessName: n.businessName,
            businessCode: n.businessCode,
            total: 0,
            open: 0,
            overdue: 0,
            lastNoteDate: null,
          });
        }
        const u = units.get(Number(n.businessId));
        u.total++;
        if (OPEN_STATUSES.includes(String(n.followUpStatus))) u.open++;
        if (
          OPEN_STATUSES.includes(String(n.followUpStatus)) &&
          n.followUpDueDate &&
          String(n.followUpDueDate) < today()
        )
          u.overdue++;
        if (!u.lastNoteDate || String(n.noteDate) > String(u.lastNoteDate)) u.lastNoteDate = n.noteDate;
      }
      // The advisor's own assignments ride along (scope notes + expiry).
      let assignments: any[] = [];
      if (isFarmAdvisor(user)) {
        const rows2 = await db.select().from(advisorAssignments).where(eq(advisorAssignments.userId, Number(user.id)));
        const ids = [...new Set(rows2.map((r) => Number(r.businessId)))];
        const bizRows = ids.length ? await db.select().from(businesses).where(inArray(businesses.id, ids)) : [];
        const day = today();
        assignments = rows2.map((r) => {
          const biz = bizRows.find((b: any) => Number(b.id) === Number(r.businessId));
          const expired = !!r.validUntil && String(r.validUntil) < day;
          return {
            ...r,
            businessName: biz?.name || `Unit #${r.businessId}`,
            businessCode: biz?.code || null,
            businessCategory: biz?.category || null,
            expired,
            effective: r.isActive !== false && !expired,
          };
        });
      }
      return NextResponse.json({
        success: true,
        notes: enriched.slice(0, 60),
        openFollowUps: openFollowUps.slice(0, 60),
        units: [...units.values()],
        stats: statsOf(enriched),
        assignments,
      });
    }

    // Per-unit list.
    const businessId = Number(searchParams.get("businessId"));
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId (or noteId/console) required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(user, businessId))) {
      return FORBIDDEN("No access to this business.");
    }
    const status = searchParams.get("status");
    const rows = await db
      .select()
      .from(advisorNotes)
      .where(eq(advisorNotes.businessId, businessId))
      .orderBy(desc(advisorNotes.id));
    const filtered = status ? rows.filter((r) => String(r.followUpStatus) === status) : rows;
    return NextResponse.json({
      success: true,
      notes: await enrich(filtered),
      stats: statsOf(rows),
    });
  } catch (error: any) {
    return apiError(error);
  }
}

/* ═══ POST — create a note ════════════════════════════════════════════ */

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json();

    const businessId = Number(body?.businessId);
    if (!businessId) {
      return NextResponse.json({ success: false, error: "businessId required" }, { status: 400 });
    }
    if (!(await canAccessBusiness(user, businessId))) {
      return FORBIDDEN("No access to this business.");
    }

    // Who may file advisor notes: the advisor (through an active grant —
    // canAccessBusiness already resolved it) or records-authorized staff.
    if (!isFarmAdvisor(user) && !isNoteStaff(user)) {
      return FORBIDDEN("Only the Farm Advisor or authorized staff can file advisor notes.");
    }

    const category = String(body?.category || "GENERAL").toUpperCase();
    const priority = String(body?.priority || "MEDIUM").toUpperCase();
    if (!ADVISOR_NOTE_CATEGORIES.includes(category as any)) {
      return NextResponse.json({ success: false, error: "Invalid category." }, { status: 400 });
    }
    if (!ADVISOR_NOTE_PRIORITIES.includes(priority as any)) {
      return NextResponse.json({ success: false, error: "Invalid priority." }, { status: 400 });
    }

    const title = String(body?.title || "").trim().slice(0, 140);
    const noteBody = String(body?.body || "").trim().slice(0, 4000);
    if (title.length < 3) {
      return NextResponse.json({ success: false, error: "Give the note a short title (3+ characters)." }, { status: 400 });
    }
    if (noteBody.length < 10) {
      return NextResponse.json({ success: false, error: "Describe the observation or recommendation (10+ characters)." }, { status: 400 });
    }

    const day = today();
    const noteDate = String(body?.noteDate || day).slice(0, 10);
    if (!DATE_RE.test(noteDate) || noteDate > day) {
      return NextResponse.json({ success: false, error: "noteDate must be today or a past date (YYYY-MM-DD)." }, { status: 400 });
    }
    if (noteDate < new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) {
      return NextResponse.json({ success: false, error: "Notes can be back-dated at most 30 days." }, { status: 400 });
    }
    const followUpDueDate = body?.followUpDueDate ? String(body.followUpDueDate).slice(0, 10) : null;
    if (followUpDueDate && !DATE_RE.test(followUpDueDate)) {
      return NextResponse.json({ success: false, error: "followUpDueDate must be YYYY-MM-DD." }, { status: 400 });
    }
    const photo = typeof body?.photo === "string" && body.photo.startsWith("data:image/") ? body.photo.slice(0, 1_500_000) : null;

    // Optional flock / batch / record links — validated against the unit.
    const flockId = body?.flockId ? Number(body.flockId) : null;
    const batchId = body?.batchId ? Number(body.batchId) : null;
    if (flockId) {
      const [f] = await db
        .select({ id: poultryFlocks.id })
        .from(poultryFlocks)
        .where(and(eq(poultryFlocks.id, flockId), eq(poultryFlocks.businessId, businessId)));
      if (!f) return NextResponse.json({ success: false, error: "Linked flock does not belong to this unit." }, { status: 400 });
    }
    if (batchId) {
      const [b] = await db
        .select({ id: aquacultureBatches.id })
        .from(aquacultureBatches)
        .where(and(eq(aquacultureBatches.id, batchId), eq(aquacultureBatches.businessId, businessId)));
      if (!b) return NextResponse.json({ success: false, error: "Linked batch does not belong to this unit." }, { status: 400 });
    }
    let recordRef: string | null = null;
    let recordTitle: string | null = null;
    const recordType = body?.recordType ? String(body.recordType).toUpperCase() : null;
    const recordId = body?.recordId ? Number(body.recordId) : null;
    if (recordType && recordId) {
      if (!(RECORD_TYPES as readonly string[]).includes(recordType)) {
        return NextResponse.json({ success: false, error: "Invalid recordType." }, { status: 400 });
      }
      const link = await resolveRecordLink(recordType, recordId, businessId);
      if (!link) {
        return NextResponse.json({ success: false, error: "Linked record not found in this unit." }, { status: 400 });
      }
      recordRef = link.ref;
      recordTitle = link.title;
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!biz) return NextResponse.json({ success: false, error: "Business not found." }, { status: 404 });

    // ── GoMina AI: shared engine + advisor priors, then benchmark-KPI
    //    corroboration against the linked flock/batch's real data.
    const [insightRow] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
    const prior = toInsights(insightRow);
    const analysis = analyzeAdvisorNote({ title, body: noteBody, category, priority }, prior.history as HistoryEntry[]);
    let corroboration: AdvisorCorroboration | null = null;
    try {
      corroboration = await corroborateAdvisorNote({ businessId, flockId, batchId, noteText: `${title}. ${noteBody}` });
    } catch {
      corroboration = null; // corroboration is best-effort, never blocks the note
    }

    const [note] = await db
      .insert(advisorNotes)
      .values({
        businessId,
        branchCode: biz.code || null,
        noteDate,
        flockId,
        batchId,
        recordType: recordType || null,
        recordSource: null,
        recordId: recordId || null,
        recordRef,
        recordTitle,
        category,
        priority,
        title,
        body: noteBody,
        photo,
        followUpStatus: "OPEN",
        followUpDueDate,
        aiSummary: analysis.summary,
        aiIssues: analysis.issues,
        aiSeverity: analysis.severity,
        aiFlags: analysis.flags,
        aiCorroboration: corroboration,
        authorUserId: Number(user.id),
        authorName: String(user.name || "Advisor"),
        authorRole: String(user.role || "FARM_ADVISOR"),
      })
      .returning();

    // Fold into the unit's living AI memory (same pipeline as daily notes).
    const next = foldNoteIntoInsights(prior, { noteDate, analysis: { ...analysis } });
    await upsertInsights(businessId, next);

    // Immutable thread head + audit trail.
    await db.insert(advisorNoteUpdates).values({
      noteId: note.id,
      actorUserId: Number(user.id),
      actorName: String(user.name || "Advisor"),
      actorRole: String(user.role || "FARM_ADVISOR"),
      action: "ADD",
      statusFrom: null,
      statusTo: "OPEN",
      note: followUpDueDate ? `Follow-up due ${followUpDueDate}.` : null,
    });
    await db.insert(auditTrail).values({
      actorUserId: Number(user.id),
      actorName: String(user.name || "Advisor"),
      actorRole: String(user.role || "FARM_ADVISOR"),
      action: "ADVISOR_NOTE_ADDED",
      targetType: "RECORD",
      targetLabel: `${title} (${biz.name})`,
      recordType: "ADVISOR_NOTE",
      recordId: note.id,
      businessId,
      branchCode: biz.code || null,
      reason: category,
      detail: `${priority} ${category} note${flockId ? ` on flock #${flockId}` : ""}${batchId ? ` on batch #${batchId}` : ""} — AI severity ${analysis.severity}${corroboration ? `, corroboration ${corroboration.verdict}` : ""}`,
      ownerId: session.orgId ?? null,
    });

    // Bell + push: unit managers always; the org OWNER additionally on
    // HIGH/CRITICAL (the audit escalation pattern).
    try {
      const recipients = await auditEscalationRecipients(businessId, priority, {
        excludeIds: [Number(user.id)],
      });
      const staff = recipients.filter((r: any) => !isFarmAdvisor(r));
      await bell(
        staff.map((r: any) => Number(r.id)),
        {
          type: "ADVISOR_NOTE_ADDED",
          title: `Advisor note: ${title}`.slice(0, 240),
          body: `${user.name} filed a ${priority.toLowerCase()} ${category.toLowerCase().replace(/_/g, " ")} note on ${biz.name}.${analysis.severity !== "INFO" ? ` AI: ${analysis.severity}.` : ""}`,
          recordId: note.id,
          recordRef: `ADV-${note.id}`,
          businessId,
          branchCode: biz.code || null,
          actorName: String(user.name || "Advisor"),
          priority,
        },
        `/?tab=${encodeURIComponent(biz.code || "ADVISOR")}`,
      );
    } catch (e) {
      console.error("[advisor-notes] notification fan-out failed:", e);
    }

    return NextResponse.json({ success: true, note: (await enrich([note]))[0], analysis, corroboration });
  } catch (error: any) {
    return apiError(error);
  }
}

/* ═══ PATCH — respond / status / edit ═════════════════════════════════ */

export async function PATCH(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json();
    const id = Number(body?.id);
    const action = String(body?.action || "").toUpperCase();
    if (!id || !["RESPOND", "STATUS", "EDIT"].includes(action)) {
      return NextResponse.json({ success: false, error: "id and action (RESPOND | STATUS | EDIT) required." }, { status: 400 });
    }

    const [note] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, id));
    if (!note) return NextResponse.json({ success: false, error: "Note not found." }, { status: 404 });
    if (!(await canAccessBusiness(user, Number(note.businessId)))) {
      return FORBIDDEN("No access to this business.");
    }
    if (!(await canReadNotes(user))) {
      return FORBIDDEN("Only the advisor, managers and records-authorized staff work advisor notes.");
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(note.businessId)));
    const actor = {
      id: Number(user.id),
      name: String(user.name || "User"),
      role: String(user.role || "WORKER"),
    };
    const isAuthor = Number(note.authorUserId) === Number(user.id);
    const isOwnerOrManager = isNoteStaff(user);

    /* ── RESPOND: anyone with read access adds to the thread. ─────────── */
    if (action === "RESPOND") {
      const text = String(body?.note || "").trim().slice(0, 2000);
      if (text.length < 2) {
        return NextResponse.json({ success: false, error: "Write a short response first." }, { status: 400 });
      }
      const photo = typeof body?.photo === "string" && body.photo.startsWith("data:image/") ? body.photo.slice(0, 1_500_000) : null;
      await db.insert(advisorNoteUpdates).values({
        noteId: id,
        actorUserId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        action: "RESPOND",
        statusFrom: note.followUpStatus,
        statusTo: note.followUpStatus,
        note: text,
        photo,
      });
      // First staff response moves an OPEN follow-up to IN_PROGRESS.
      if (note.followUpStatus === "OPEN" && isOwnerOrManager && !isFarmAdvisor(user)) {
        await db
          .update(advisorNotes)
          .set({ followUpStatus: "IN_PROGRESS", updatedAt: new Date() })
          .where(eq(advisorNotes.id, id));
        await db.insert(advisorNoteUpdates).values({
          noteId: id,
          actorUserId: actor.id,
          actorName: actor.name,
          actorRole: actor.role,
          action: "STATUS_CHANGE",
          statusFrom: "OPEN",
          statusTo: "IN_PROGRESS",
          note: "Auto: staff response started the follow-up.",
        });
      }
      await db.insert(auditTrail).values({
        actorUserId: actor.id, actorName: actor.name, actorRole: actor.role,
        action: "ADVISOR_NOTE_RESPONSE", targetType: "RECORD",
        targetLabel: `Re: ${note.title}`, recordType: "ADVISOR_NOTE", recordId: id,
        businessId: Number(note.businessId), branchCode: biz?.code || null,
        ownerId: session.orgId ?? null, reason: null,
        detail: `${actor.name} responded to advisor note #${id}`,
      });
      // Notify the other side: author hears staff responses; the managers
      // hear the advisor's own clarifications.
      try {
        const targets: number[] = [];
        const urls: Record<number, string> = {};
        if (!isAuthor && note.authorUserId) {
          targets.push(Number(note.authorUserId));
          urls[Number(note.authorUserId)] = "/?tab=ADVISOR";
        }
        if (isFarmAdvisor(user) && isAuthor) {
          const recips = (await auditEscalationRecipients(Number(note.businessId), note.priority, { excludeIds: [actor.id] }))
            .filter((r: any) => !isFarmAdvisor(r));
          for (const r of recips) {
            targets.push(Number(r.id));
            urls[Number(r.id)] = `/?tab=${encodeURIComponent(biz?.code || "ADVISOR")}`;
          }
        }
        const perUser = targets.filter((t, i) => targets.indexOf(t) === i);
        for (const uid of perUser) {
          await bell([uid], {
            type: "ADVISOR_NOTE_RESPONSE",
            title: `Re: ${note.title}`.slice(0, 240),
            body: `${actor.name}: ${text.slice(0, 220)}`,
            recordId: id,
            recordRef: `ADV-${id}-resp-${Date.now()}`,
            businessId: Number(note.businessId),
            branchCode: biz?.code || null,
            actorName: actor.name,
            priority: note.priority,
          }, urls[uid] || "/?tab=ADVISOR");
        }
      } catch (e) {
        console.error("[advisor-notes] response notification failed:", e);
      }
      const [fresh] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, id));
      return NextResponse.json({ success: true, note: (await enrich([fresh]))[0] });
    }

    /* ── STATUS: follow-up lifecycle. ────────────────────────────────── */
    if (action === "STATUS") {
      if (!isAuthor && !isOwnerOrManager) {
        return FORBIDDEN("Only the advisor (own note) or authorized staff change the follow-up status.");
      }
      const statusTo = String(body?.status || "").toUpperCase();
      if (!ADVISOR_FOLLOWUP_STATUSES.includes(statusTo as any)) {
        return NextResponse.json({ success: false, error: "Invalid follow-up status." }, { status: 400 });
      }
      if (statusTo === note.followUpStatus) {
        return NextResponse.json({ success: false, error: `Follow-up is already ${statusTo}.` }, { status: 400 });
      }
      const reason = String(body?.note || "").trim().slice(0, 500) || null;
      await db
        .update(advisorNotes)
        .set({ followUpStatus: statusTo, updatedAt: new Date() })
        .where(eq(advisorNotes.id, id));
      await db.insert(advisorNoteUpdates).values({
        noteId: id,
        actorUserId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        action: "STATUS_CHANGE",
        statusFrom: note.followUpStatus,
        statusTo,
        note: reason,
      });
      await db.insert(auditTrail).values({
        actorUserId: actor.id, actorName: actor.name, actorRole: actor.role,
        action: "ADVISOR_FOLLOWUP_STATUS_CHANGED", targetType: "RECORD",
        targetLabel: `${note.title}: ${note.followUpStatus} → ${statusTo}`,
        recordType: "ADVISOR_NOTE", recordId: id,
        businessId: Number(note.businessId), branchCode: biz?.code || null,
        ownerId: session.orgId ?? null, reason: reason,
        detail: `Follow-up moved ${note.followUpStatus} → ${statusTo} by ${actor.name}`,
      });
      // Notify both sides of the follow-up.
      try {
        const targets = new Set<number>();
        const urls: Record<number, string> = {};
        if (!isAuthor && note.authorUserId) {
          targets.add(Number(note.authorUserId));
          urls[Number(note.authorUserId)] = "/?tab=ADVISOR";
        }
        for (const r of await auditEscalationRecipients(Number(note.businessId), note.priority, { excludeIds: [actor.id] })) {
          if (isFarmAdvisor(r)) continue;
          targets.add(Number(r.id));
          urls[Number(r.id)] = `/?tab=${encodeURIComponent(biz?.code || "ADVISOR")}`;
        }
        for (const uid of targets) {
          await bell([uid], {
            type: "ADVISOR_FOLLOWUP_STATUS",
            title: `Follow-up ${statusTo}: ${note.title}`.slice(0, 240),
            body: `${actor.name} moved the follow-up ${note.followUpStatus} → ${statusTo}${reason ? ` — ${reason}` : ""}.`,
            recordId: id,
            recordRef: `ADV-${id}-status-${statusTo}-${Date.now()}`,
            businessId: Number(note.businessId),
            branchCode: biz?.code || null,
            actorName: actor.name,
            priority: note.priority,
          }, urls[uid] || "/?tab=ADVISOR");
        }
      } catch (e) {
        console.error("[advisor-notes] status notification failed:", e);
      }
      const [fresh] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, id));
      return NextResponse.json({ success: true, note: (await enrich([fresh]))[0] });
    }

    /* ── EDIT: author within a 24h window, or the OWNER. ─────────────── */
    const mayEdit = (isAuthor && Date.now() - new Date(note.createdAt || Date.now()).getTime() < 24 * 3600_000) || user.role === "OWNER";
    if (!mayEdit) {
      return FORBIDDEN("Notes can be edited by their author within 24 hours; after that only the OWNER can revise them.");
    }
    const title = body?.title !== undefined ? String(body.title).trim().slice(0, 140) : note.title;
    const noteBodyText = body?.body !== undefined ? String(body.body).trim().slice(0, 4000) : note.body;
    const category = body?.category !== undefined ? String(body.category).toUpperCase() : note.category;
    const priority = body?.priority !== undefined ? String(body.priority).toUpperCase() : note.priority;
    const followUpDueDate =
      body?.followUpDueDate !== undefined
        ? body.followUpDueDate
          ? String(body.followUpDueDate).slice(0, 10)
          : null
        : note.followUpDueDate;
    if (title.length < 3 || noteBodyText.length < 10) {
      return NextResponse.json({ success: false, error: "Title (3+) and observation (10+) are required." }, { status: 400 });
    }
    if (!ADVISOR_NOTE_CATEGORIES.includes(category as any) || !ADVISOR_NOTE_PRIORITIES.includes(priority as any)) {
      return NextResponse.json({ success: false, error: "Invalid category or priority." }, { status: 400 });
    }

    // Re-run the AI on the revised text, then rebuild the unit's insights
    // memory from both note streams so nothing double-counts.
    const [insightRow] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, Number(note.businessId)));
    const prior = toInsights(insightRow);
    const analysis = analyzeAdvisorNote({ title, body: noteBodyText, category, priority }, prior.history as HistoryEntry[]);
    let corroboration: AdvisorCorroboration | null = (note.aiCorroboration as any) || null;
    try {
      corroboration = await corroborateAdvisorNote({
        businessId: Number(note.businessId),
        flockId: note.flockId,
        batchId: note.batchId,
        noteText: `${title}. ${noteBodyText}`,
      });
    } catch {
      /* keep previous snapshot */
    }

    await db
      .update(advisorNotes)
      .set({
        title,
        body: noteBodyText,
        category,
        priority,
        followUpDueDate,
        aiSummary: analysis.summary,
        aiIssues: analysis.issues,
        aiSeverity: analysis.severity,
        aiFlags: analysis.flags,
        aiCorroboration: corroboration,
        updatedAt: new Date(),
      })
      .where(eq(advisorNotes.id, id));
    await db.insert(advisorNoteUpdates).values({
      noteId: id,
      actorUserId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: "EDIT",
      statusFrom: note.followUpStatus,
      statusTo: note.followUpStatus,
      note: `Note revised (category ${category}, priority ${priority}).`,
    });
    await db.insert(auditTrail).values({
      actorUserId: actor.id, actorName: actor.name, actorRole: actor.role,
      action: "ADVISOR_NOTE_UPDATED", targetType: "RECORD",
      targetLabel: title, recordType: "ADVISOR_NOTE", recordId: id,
      businessId: Number(note.businessId), branchCode: biz?.code || null,
      ownerId: session.orgId ?? null, reason: null,
      detail: `Advisor note #${id} revised by ${actor.name}`,
    });
    await rebuildInsightsWithAdvisorNotes(Number(note.businessId));

    const [fresh] = await db.select().from(advisorNotes).where(eq(advisorNotes.id, id));
    return NextResponse.json({ success: true, note: (await enrich([fresh]))[0], analysis });
  } catch (error: any) {
    return apiError(error);
  }
}
