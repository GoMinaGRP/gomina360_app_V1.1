/**
 * Farm Advisor — shared server helpers (data assembly, notifications, trail).
 *
 * Everything here REUSES the platform's existing systems:
 *   • notifications + web push      → lib/notify.ts, lib/push.ts
 *   • immutable audit trail         → lib/audit.ts
 *   • note analysis & insights      → lib/dailyNotesAi.ts (the same engine the
 *                                     staff Daily Notes run through)
 *   • benchmarks / digest           → lib/advisorAi.ts (+ lib/poultryPerformance.ts)
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  advisorNotes,
  advisorVisits,
  businesses,
  businessInsights,
  checklistEntries,
  dailyNotes,
  notifications,
  poultryChecklists,
  poultryFeedLogs,
  poultryFlocks,
  poultryHealthRecords,
  poultryProduction,
  poultryWaterLogs,
  poultryWeightLogs,
  users,
} from "@/db/schema";
import { auditEscalationRecipients, ownerOrgOfBusiness } from "./notify";
import { pushAfterBell } from "./push";
import {
  analyzeNote,
  foldNoteIntoInsights,
  rebuildInsights,
  EMPTY_INSIGHTS,
  type InsightsState,
} from "./dailyNotesAi";
import { buildAdvisoryDigest, type AdvisoryDigest } from "./advisorAi";
import {
  filterFlockRowsForGrant,
  filterFlocksForGrant,
  grantCoversBranch,
  grantCoversFlock,
  stripMoneyRows,
  type AdvisorGrant,
} from "./advisorAccess";

/* ── farm data assembly (read-only, grant-scoped, cost-aware) ───────────── */

export async function loadFarmData(businessId: number) {
  const [flocks, feedLogs, waterLogs, healthRecords, production, weightLogs, pChecks, gChecks] = await Promise.all([
    db.select().from(poultryFlocks).where(eq(poultryFlocks.businessId, businessId)),
    db.select().from(poultryFeedLogs).where(eq(poultryFeedLogs.businessId, businessId)),
    db.select().from(poultryWaterLogs).where(eq(poultryWaterLogs.businessId, businessId)),
    db.select().from(poultryHealthRecords).where(eq(poultryHealthRecords.businessId, businessId)),
    db.select().from(poultryProduction).where(eq(poultryProduction.businessId, businessId)),
    db.select().from(poultryWeightLogs).where(eq(poultryWeightLogs.businessId, businessId)),
    db.select().from(poultryChecklists).where(eq(poultryChecklists.businessId, businessId)),
    db.select().from(checklistEntries).where(eq(checklistEntries.businessId, businessId)),
  ]);
  return {
    flocks,
    feedLogs,
    waterLogs,
    healthRecords,
    production,
    weightLogs,
    checklistEntries: [...pChecks, ...gChecks],
  };
}

/** Narrow a farm dataset to what a grant allows, stripping money when the
 *  grant is cost-blind. Used by the advisor data feed AND by /api/poultry. */
export function scopeFarmDataToGrant(data: any, grant: AdvisorGrant | null) {
  if (!grant) {
    return { flocks: [], feedLogs: [], waterLogs: [], healthRecords: [], production: [], weightLogs: [], checklistEntries: [] };
  }
  const money = <T extends Record<string, any>>(rows: T[]) => (grant.showCosts ? rows : stripMoneyRows(rows));
  return {
    flocks: money(filterFlocksForGrant(data.flocks || [], grant)),
    feedLogs: money(filterFlockRowsForGrant(data.feedLogs || [], grant)),
    waterLogs: money(filterFlockRowsForGrant(data.waterLogs || [], grant)),
    healthRecords: money(filterFlockRowsForGrant(data.healthRecords || [], grant)),
    production: money(filterFlockRowsForGrant(data.production || [], grant)),
    weightLogs: money(filterFlockRowsForGrant(data.weightLogs || [], grant)),
    checklistEntries: (data.checklistEntries || []).filter((c: any) => grantCoversBranch(grant, c.branchCode)),
  };
}

/* ── notifications (reuse of the existing bell + push) ─────────────────── */

export async function notifyUsers(
  userIds: number[],
  n: {
    type: string;
    title: string;
    body?: string | null;
    businessId?: number | null;
    branchCode?: string | null;
    recordType?: string | null;
    recordId?: number | null;
    recordRef?: string | null;
    actorName?: string | null;
    priority?: string | null;
    url?: string;
  },
) {
  const ids = [...new Set(userIds.map(Number).filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) return;
  const ownerId = n.businessId != null ? await ownerOrgOfBusiness(Number(n.businessId)) : null;
  await db.insert(notifications).values(
    ids.map((userId) => ({
      userId,
      type: n.type,
      title: n.title.slice(0, 240),
      body: (n.body || "").slice(0, 600) || null,
      recordType: n.recordType ?? null,
      recordId: n.recordId ?? null,
      recordRef: n.recordRef ?? null,
      businessId: n.businessId ?? null,
      branchCode: n.branchCode ?? null,
      actorName: n.actorName ?? null,
      priority: n.priority ?? null,
      ownerId,
    })),
  );
  pushAfterBell(ids, {
    type: n.type,
    title: n.title.slice(0, 240),
    body: (n.body || "").slice(0, 600),
    url: n.url || "/?tab=ADVISORY",
  });
}

/** Owner + managers who should see advisory activity on a farm. */
export async function advisoryRecipients(businessId: number, priority: string, excludeIds: (number | null)[] = []) {
  const rows = await auditEscalationRecipients(businessId, priority, { unassigned: true, excludeIds });
  return rows.map((r) => Number(r.id));
}

/* ── AI: analyse a note with the SAME engine as staff daily notes ──────── */

function toInsights(row: any): InsightsState {
  if (!row) return JSON.parse(JSON.stringify(EMPTY_INSIGHTS));
  return {
    notesAnalyzed: row.notesAnalyzed || 0,
    lastNoteDate: row.lastNoteDate ?? null,
    rollingSummary: row.rollingSummary ?? null,
    issueRegister: Array.isArray(row.issueRegister) ? row.issueRegister : [],
    categoryTrends: row.categoryTrends || {},
    history: Array.isArray(row.history) ? row.history : [],
  };
}

async function saveInsights(businessId: number, state: InsightsState) {
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
  if (existing) await db.update(businessInsights).set(payload).where(eq(businessInsights.id, existing.id));
  else await db.insert(businessInsights).values({ businessId, ...payload });
}

/**
 * Analyse an advisory note and fold it into the business' living memory —
 * exactly like a staff daily note, so the Owner's rolling narrative, issue
 * register and category trends absorb professional observations too.
 */
export async function analyzeAdvisoryNote(businessId: number, title: string, body: string, noteDate: string) {
  const [row] = await db.select().from(businessInsights).where(eq(businessInsights.businessId, businessId));
  const state = toInsights(row);
  const text = `${title}. ${body}`;
  const analysis = analyzeNote(text, state.history);
  const next = foldNoteIntoInsights(state, { noteDate, analysis });
  await saveInsights(businessId, next);
  return analysis;
}

/** Recompute a business' insights from the surviving staff notes (used when an
 *  advisory note is withdrawn, so history never lies). */
export async function rebuildBusinessInsights(businessId: number) {
  const rows = await db
    .select()
    .from(dailyNotes)
    .where(eq(dailyNotes.businessId, businessId));
  // Re-analyse the surviving staff notes in chronological order (the advisory
  // note being withdrawn simply stops contributing).
  const ordered = rows.sort((a, b) => String(a.noteDate).localeCompare(String(b.noteDate)));
  const replay: { noteDate: string; analysis: ReturnType<typeof analyzeNote> }[] = [];
  let history: InsightsState["history"] = [];
  for (const r of ordered) {
    const analysis = analyzeNote(r.content, history);
    replay.push({ noteDate: r.noteDate, analysis });
    history = foldNoteIntoInsights({ ...EMPTY_INSIGHTS, history }, { noteDate: r.noteDate, analysis }).history;
  }
  const state = rebuildInsights(replay);
  await saveInsights(businessId, state);
}

/* ── digest ────────────────────────────────────────────────────────────── */

export async function generateDigest(
  businessId: number,
  opts: { windowDays?: number; grant?: AdvisorGrant | null; toDate?: string } = {},
): Promise<AdvisoryDigest> {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const raw = await loadFarmData(businessId);
  const data = opts.grant ? scopeFarmDataToGrant(raw, opts.grant) : raw;
  let notes = await db.select().from(advisorNotes).where(eq(advisorNotes.businessId, businessId));
  if (opts.grant) {
    notes = notes.filter(
      (n) => grantCoversBranch(opts.grant!, n.branchCode) && grantCoversFlock(opts.grant!, n.flockId),
    );
  }
  return buildAdvisoryDigest({
    businessId,
    businessName: biz?.name,
    windowDays: opts.windowDays,
    toDate: opts.toDate,
    flocks: data.flocks,
    feedLogs: data.feedLogs,
    waterLogs: data.waterLogs,
    healthRecords: data.healthRecords,
    production: data.production,
    weightLogs: data.weightLogs,
    checklistEntries: data.checklistEntries,
    notes,
  });
}

/* ── misc ──────────────────────────────────────────────────────────────── */

export async function advisorUserRows(userIds: number[]) {
  if (!userIds.length) return [];
  return db.select().from(users).where(inArray(users.id, userIds));
}

export async function recentVisits(businessIds: number[]) {
  if (!businessIds.length) return [];
  return db
    .select()
    .from(advisorVisits)
    .where(inArray(advisorVisits.businessId, businessIds))
    .orderBy(desc(advisorVisits.id));
}

export const todayISO = () => new Date().toLocaleDateString("en-CA");

export async function noteById(id: number) {
  const [row] = await db.select().from(advisorNotes).where(and(eq(advisorNotes.id, Number(id))));
  return row || null;
}
