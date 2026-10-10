/**
 * dailyOps — GoMina's heartbeat (roadmap P2).
 *
 * Until now every "scheduled" behaviour (checklist generation, overdue
 * sweeps) only ran when somebody opened the app — a pull-based pattern that
 * leaves digests, escalations and stock alerts invisible on quiet days. This
 * module is the single daily pipeline both schedulers converge on:
 *
 *   1. Vercel Cron  → GET /api/cron/daily  (vercel.json, 06:00 UTC = 06:00
 *      Ghana — guarded by CRON_SECRET when set, plus the platform's own
 *      cron header).
 *   2. Pull-based fallback → /api/init fires runDailyOps("init") — a global
 *      system marker (`daily-ops:<date>`) makes the whole pipeline run at
 *      most once per calendar day no matter how many sessions open.
 *
 * The pipeline (every step idempotent, failure-isolated, marker-gated):
 *   a. ensure today's checklists exist (same engine /api/init uses);
 *   b. low-stock sweep — normalize inventory statuses + reorder alerts;
 *   c. auto-complete action tasks whose linked source was resolved;
 *   d. SLA escalation — overdue tasks and overdue audit issues re-notify
 *      assignee + watchers (first day, then weekly);
 *   e. per-user daily digest bell row (+ push) — only when there is
 *      something to say.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  actionTasks,
  auditReviews,
  businesses,
  notifications,
  organizationMembers,
  userBusinessAccess,
  users,
} from "@/db/schema";
import { getSystemMarker, setSystemMarker, latestMarkerWithPrefix } from "@/lib/systemMarkers";
import { ensureTodayFor } from "@/lib/checklistGen";
import { sweepLowStock, lowStockItemsForBusiness } from "@/lib/lowStock";
import { draftLowStockRequisitions } from "@/lib/procurement";
import { sweepDunning } from "@/lib/customerInsights";
import { sweepDocumentExpiry } from "@/lib/documents";
import { autoCompleteLinkedTasks, escalateOverdueTasks, todayLocalISO, ACTION_OPEN_STATUSES } from "@/lib/actionCenter";
import { pushAfterBell } from "@/lib/push";
import { ownerOrgOfBusiness } from "@/lib/notify";

const OPEN_ISSUE_STATUSES = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED"];

export interface DailyOpsResult {
  ran: boolean;
  skipped?: boolean;
  date: string;
  source: string;
  checklistBusinesses?: number;
  lowStock?: { businessId: number; lowCount: number; outCount: number; notified: number }[];
  tasksAutoCompleted?: number;
  tasksEscalated?: number;
  issuesEscalated?: number;
  digests?: { userId: number; sent: boolean; reason?: string }[];
  draftedRequisitions?: number;
  dunningSent?: number;
  documentsExpiring?: number;
  steps?: { step: string; ok: boolean; error?: string }[];
}

/** SLA escalation for audit issues that carry a corrective-action due date:
 *  notify the assignee always; escalation watchers weekly (recordRef steps). */
export async function escalateOverdueAuditIssues(): Promise<number> {
  const today = todayLocalISO();
  const rows = await db
    .select()
    .from(auditReviews)
    .where(
      and(
        inArray(auditReviews.status, OPEN_ISSUE_STATUSES),
        sql`${auditReviews.dueDate} is not null and ${auditReviews.dueDate} < ${today}`,
      ),
    )
    .limit(300);
  let notified = 0;
  const { auditEscalationRecipients } = await import("@/lib/notify");
  for (const r of rows) {
    const daysOverdue = Math.max(1, Math.round((Date.parse(today) - Date.parse(String(r.dueDate))) / 86400000));
    const step = daysOverdue <= 7 ? "d1" : `w${Math.floor(daysOverdue / 7)}`;
    const recordRef = `issue-overdue:${r.id}:${step}`;
    const body = `Issue "${r.issueTitle || r.recordRef}" is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past its ${r.dueDate} corrective-action deadline (${r.status}).${r.assignedUserName ? ` Assigned to ${r.assignedUserName}.` : ""} Open Audit & Review to respond and resolve.`;
    if (r.assignedUserId) {
      notified += await insertDedupedNotification({
        userId: Number(r.assignedUserId),
        type: "AUDIT_ISSUE_OVERDUE",
        title: `Overdue issue: ${r.issueTitle || r.recordRef}`,
        body,
        recordRef,
        businessId: r.businessId,
        branchCode: r.branchCode,
        actorName: "GoMina 360",
        priority: String(r.priority || "HIGH").toUpperCase() === "CRITICAL" ? "CRITICAL" : "HIGH",
      });
    }
    const watchers = await auditEscalationRecipients(r.businessId, r.priority, { excludeIds: [r.assignedUserId] });
    for (const w of watchers) {
      await insertDedupedNotification({
        userId: Number(w.id),
        type: "AUDIT_ISSUE_OVERDUE",
        title: `Overdue issue watch: ${r.issueTitle || r.recordRef}`,
        body,
        recordRef: `${recordRef}:watch`,
        businessId: r.businessId,
        branchCode: r.branchCode,
        actorName: "GoMina 360",
        priority: "HIGH",
      });
    }
  }
  return notified;
}

/** Bell insert deduped on (userId, type, recordRef); optional OS push. */
async function insertDedupedNotification(n: {
  userId: number;
  type: string;
  title: string;
  body: string;
  recordRef: string;
  businessId?: number | null;
  branchCode?: string | null;
  actorName?: string | null;
  priority?: string | null;
  recordType?: string | null;
  recordId?: number | null;
  url?: string;
  push?: boolean;
}): Promise<number> {
  const [dupe] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, Number(n.userId)),
        eq(notifications.type, n.type),
        eq(notifications.recordRef, n.recordRef),
      ),
    )
    .limit(1);
  if (dupe) return 0;
  const ownerId = n.businessId != null ? await ownerOrgOfBusiness(Number(n.businessId)) : null;
  await db.insert(notifications).values({
    userId: Number(n.userId),
    type: n.type,
    title: n.title.slice(0, 240),
    body: n.body.slice(0, 600) || null,
    recordType: n.recordType ?? null,
    recordId: n.recordId ?? null,
    recordRef: n.recordRef,
    businessId: n.businessId ?? null,
    branchCode: n.branchCode ?? null,
    actorName: n.actorName ?? null,
    priority: n.priority ?? null,
    ownerId,
  });
  if (n.push !== false) {
    pushAfterBell([Number(n.userId)], {
      type: n.type,
      title: n.title.slice(0, 240),
      body: n.body.slice(0, 600),
      url: n.url || "/?tab=ACTION_CENTER",
    });
  }
  return 1;
}

/** The businesses a user can act on, computed the same way /api/init scopes
 *  them (workers: assignment + grants; executives: their organizations). */
async function businessIdsForDailyUser(u: any): Promise<number[]> {
  const role = String(u.role || "").toUpperCase();
  if (role === "OWNER" || role === "GENERAL_MANAGER" || u.isSuperAdmin) {
    if (u.isSuperAdmin) {
      const rows = await db.select({ id: businesses.id }).from(businesses);
      return rows.map((r) => Number(r.id));
    }
    const orgs = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, Number(u.id)));
    const orgIds = orgs.map((m) => Number(m.organizationId));
    if (!orgIds.length) return [];
    const biz = await db
      .select({ id: businesses.id, ownerId: businesses.ownerId })
      .from(businesses);
    return biz.filter((b) => orgIds.includes(Number(b.ownerId))).map((b) => Number(b.id));
  }
  const ids = new Set<number>();
  if (u.assignedBusinessId != null) ids.add(Number(u.assignedBusinessId));
  const grants = await db
    .select({ businessId: userBusinessAccess.businessId })
    .from(userBusinessAccess)
    .where(eq(userBusinessAccess.userId, Number(u.id)));
  for (const g of grants) ids.add(Number(g.businessId));
  return Array.from(ids);
}

/** Compose and land one user's daily digest (skipped when nothing to say). */
async function sendDailyDigest(u: any, today: string, lowStockByBusiness: Map<number, number>): Promise<{ sent: boolean; reason?: string }> {
  const myBusinessIds = await businessIdsForDailyUser(u);
  const lines: string[] = [];

  // Open actions assigned to this user
  const tasks = await db
    .select()
    .from(actionTasks)
    .where(and(eq(actionTasks.assignedUserId, Number(u.id)), inArray(actionTasks.status, ACTION_OPEN_STATUSES)))
    .limit(500);
  const overdue = tasks.filter((t) => t.dueDate && String(t.dueDate) < today);
  const dueToday = tasks.filter((t) => String(t.dueDate || "") === today);
  if (tasks.length) {
    lines.push(`• ${tasks.length} open action${tasks.length === 1 ? "" : "s"} assigned to you${overdue.length ? ` (${overdue.length} overdue)` : ""}${dueToday.length ? ` (${dueToday.length} due today)` : ""}`);
  }

  // Audit issues awaiting this user's response
  const issues = await db
    .select({ id: auditReviews.id })
    .from(auditReviews)
    .where(and(eq(auditReviews.assignedUserId, Number(u.id)), inArray(auditReviews.status, OPEN_ISSUE_STATUSES)))
    .limit(200);
  if (issues.length) lines.push(`• ${issues.length} audit issue${issues.length === 1 ? "" : "s"} awaiting your response`);

  // Low stock across the user's businesses
  const lowBiz = myBusinessIds.filter((id) => (lowStockByBusiness.get(id) || 0) > 0);
  if (lowBiz.length) {
    lines.push(`• ${lowBiz.length} of your businesses have items at or below the reorder point`);
  }

  // Unread notifications from the last 24h
  const unreadRows = await db.execute(
    sql`select count(*)::int as c from notifications where user_id = ${Number(u.id)} and is_read = false and created_at > now() - interval '24 hours' and type <> 'DAILY_DIGEST'`,
  );
  const unread = Number(((unreadRows as any).rows ?? unreadRows)[0]?.c ?? 0) || 0;
  if (unread > 0) lines.push(`• ${unread} unread notification${unread === 1 ? "" : "s"} since yesterday`);

  if (!lines.length) return { sent: false, reason: "nothing to report" };
  const body = `Your GoMina day at a glance:\n${lines.join("\n")}\nOpen the Action Center to work the list.`;
  await insertDedupedNotification({
    userId: Number(u.id),
    type: "DAILY_DIGEST",
    title: `Daily recap — ${today}`,
    body,
    recordRef: `digest:${Number(u.id)}:${today}`,
    actorName: "GoMina 360",
    url: "/?tab=ACTION_CENTER",
  });
  return { sent: true };
}

/** The whole daily pipeline. `source`: "cron" (Vercel Cron), "init"
 *  (pull-based fallback on first session of the day), "manual" (owner-forced
 *  run — bypasses the once-per-day marker). */
export async function runDailyOps(opts: { source: "cron" | "init" | "manual" }): Promise<DailyOpsResult> {
  const today = todayLocalISO();
  const steps: { step: string; ok: boolean; error?: string }[] = [];
  const result: DailyOpsResult = { ran: true, date: today, source: opts.source, steps };

  const markerKey = `daily-ops:${today}`;
  const alreadyRan = (await getSystemMarker(markerKey)) != null;
  if (alreadyRan && opts.source !== "manual") {
    return { ran: false, skipped: true, date: today, source: opts.source };
  }

  // a. Today's checklists exist (idempotent engine shared with /api/init).
  try {
    await ensureTodayFor(null, today);
    steps.push({ step: "checklists", ok: true });
  } catch (e) {
    steps.push({ step: "checklists", ok: false, error: String((e as any)?.message || e) });
  }

  // b. Low-stock sweep across every business that has inventory.
  let lowStockMap = new Map<number, number>();
  try {
    const sweeps = await sweepLowStock(null, { actorName: "Daily ops" });
    result.lowStock = sweeps.map((s) => ({ businessId: s.businessId, lowCount: s.lowCount, outCount: s.outCount, notified: s.notified }));
    for (const s of sweeps) lowStockMap.set(s.businessId, s.lowCount + s.outCount);
    steps.push({ step: "low-stock", ok: true });
  } catch (e) {
    steps.push({ step: "low-stock", ok: false, error: String((e as any)?.message || e) });
  }

  // b2. R2 — low-stock → draft purchase requisitions (marker-gated per
  // business+day; managers review before submitting for approval).
  try {
    const drafted = await draftLowStockRequisitions({ businessIds: null });
    result.draftedRequisitions = drafted.length;
    steps.push({ step: "low-stock-pr", ok: true });
  } catch (e) {
    steps.push({ step: "low-stock-pr", ok: false, error: String((e as any)?.message || e) });
  }

  // b3. R3 — dunning sweep: overdue credit sales escalate T+1 → T+7 → T+30
  // (marker-gated per sale+stage, so each chase fires exactly once).
  try {
    const fired = await sweepDunning();
    result.dunningSent = fired.length;
    steps.push({ step: "dunning", ok: true });
  } catch (e) {
    steps.push({ step: "dunning", ok: false, error: String((e as any)?.message || e) });
  }

  // b4. R4 — document expiry sweep: licences/permits/insurance warn the unit
  // at 30 / 7 / 0 days out (marker-gated per document+window).
  try {
    const expiring = await sweepDocumentExpiry();
    result.documentsExpiring = expiring.length;
    steps.push({ step: "doc-expiry", ok: true });
  } catch (e) {
    steps.push({ step: "doc-expiry", ok: false, error: String((e as any)?.message || e) });
  }

  // c. Auto-complete tasks whose linked source was resolved.
  try {
    result.tasksAutoCompleted = await autoCompleteLinkedTasks();
    steps.push({ step: "auto-complete", ok: true });
  } catch (e) {
    steps.push({ step: "auto-complete", ok: false, error: String((e as any)?.message || e) });
  }

  // d. SLA escalation — tasks, then dated audit issues.
  try {
    result.tasksEscalated = await escalateOverdueTasks();
    steps.push({ step: "task-escalation", ok: true });
  } catch (e) {
    steps.push({ step: "task-escalation", ok: false, error: String((e as any)?.message || e) });
  }
  try {
    result.issuesEscalated = await escalateOverdueAuditIssues();
    steps.push({ step: "issue-escalation", ok: true });
  } catch (e) {
    steps.push({ step: "issue-escalation", ok: false, error: String((e as any)?.message || e) });
  }

  // e. Per-user digest — only users with something on their plate get a row.
  try {
    const allUsers = await db.select().from(users).limit(500);
    const active = allUsers.filter((u) => u.isActive !== false);
    const digests: { userId: number; sent: boolean; reason?: string }[] = [];
    for (const u of active) {
      try {
        digests.push({ userId: Number(u.id), ...(await sendDailyDigest(u, today, lowStockMap)) });
      } catch (e) {
        digests.push({ userId: Number(u.id), sent: false, reason: String((e as any)?.message || e) });
      }
    }
    result.digests = digests;
    steps.push({ step: "digest", ok: true });
  } catch (e) {
    steps.push({ step: "digest", ok: false, error: String((e as any)?.message || e) });
  }

  // Marker LAST: a crashed pipeline retries on the next trigger of the day.
  await setSystemMarker(markerKey, `${opts.source}@${new Date().toISOString()}`);
  return result;
}

/** Re-export for the on-demand inventory check endpoint. */
/**
 * F-14 · when did the scheduler last COMPLETE a sweep?
 *
 * Vercel neither retries a failed cron nor alerts on one, so the only
 * evidence that overdue Action Center activities were processed is the
 * `daily-ops:<date>` marker, written solely on a fully successful run.
 * Surfacing it turns a silently stalled sweep into a readable fact.
 *
 * `ageHours` is the useful number: > 26h means yesterday's sweep never
 * finished (or CRON_SECRET is unset, so the fire 401s and the only thing
 * keeping the app alive is the /api/init pull fallback).
 */
export async function lastDailyOps(): Promise<{
  ranAt: string | null;
  date: string | null;
  source: string | null;
  ageHours: number | null;
  stale: boolean;
}> {
  const [row] = await latestMarkerWithPrefix("daily-ops:", 1);
  if (!row) return { ranAt: null, date: null, source: null, ageHours: null, stale: true };
  const ranAt = row.createdAt ? new Date(row.createdAt).toISOString() : null;
  const m = /^daily-ops:(\d{4}-\d{2}-\d{2})$/.exec(row.key);
  // marker value is "<source>@<iso>"; setSystemMarker never overwrites, and
  // each day has its own key, so this row's value is that run's source.
  const source = String(row.value || "").split("@")[0] || null;
  const ageHours = row.createdAt ? (Date.now() - new Date(row.createdAt).getTime()) / 3600000 : null;
  return {
    ranAt,
    date: m ? m[1] : null,
    source,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    stale: ageHours == null ? true : ageHours > 26,
  };
}

export { lowStockItemsForBusiness };
