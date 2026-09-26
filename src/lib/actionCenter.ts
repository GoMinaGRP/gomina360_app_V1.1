/**
 * actionCenter — the unified "who owes what by when" engine (roadmap P1).
 *
 * One cross-module action register on top of the systems that already exist:
 *
 *  • NATIVE TASKS live in `action_tasks` — created manually, converted from a
 *    bell notification, or mirrored ("tracked") from a linked source so the
 *    assignee gets a personal deadline.
 *  • LINKED OPEN ITEMS are NOT copied: open audit issues, advisor follow-ups
 *    and today's incomplete critical checklists are queried live from their
 *    own tables and shown read-only in the Action Center, each with a deep
 *    link into the module that owns it. Mirroring a linked item creates a
 *    native task with sourceType/sourceId; when the source is later resolved
 *    (issue verified, follow-up closed) the daily sweep auto-completes every
 *    task still pointing at it — the source stays the single source of truth.
 *
 * Tenant isolation: every query is scoped to the caller's accessible
 * businesses / organization memberships, exactly like the audit and checklist
 * routes. A task's ownerId is the owning organization of its business (or of
 * its creator for organization-wide tasks), so cross-tenant reads are
 * structurally impossible.
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { pushAfterBell } from "@/lib/push";
import {
  actionTasks,
  advisorNotes,
  auditReviews,
  checklistEntries,
  notifications,
  organizationMembers,
  users,
} from "@/db/schema";
import { ownerOrgOfBusiness } from "@/lib/notify";

export const ACTION_OPEN_STATUSES = ["OPEN", "IN_PROGRESS"];
const OPEN_ISSUE_STATUSES = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED"];
const OPEN_FOLLOWUP_STATUSES = ["OPEN", "IN_PROGRESS"];

/** Local-calendar ISO date (YYYY-MM-DD) — the codebase convention. */
export function todayLocalISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function isValidISODate(s: unknown): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function normTaskPriority(p: unknown): string {
  const v = String(p || "MEDIUM").toUpperCase();
  return ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(v) ? v : "MEDIUM";
}

export function normTaskStatus(s: unknown): string {
  const v = String(s || "OPEN").toUpperCase();
  return ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(v) ? v : "OPEN";
}

/** TASK-2026-000148 — unique, collision-retried. */
export async function nextTaskNumber(): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 6; attempt++) {
    const n = Math.floor(100000 + Math.random() * 900000);
    const candidate = `TASK-${year}-${n}`;
    const [dupe] = await db
      .select({ id: actionTasks.id })
      .from(actionTasks)
      .where(eq(actionTasks.taskNumber, candidate))
      .limit(1);
    if (!dupe) return candidate;
  }
  return `TASK-${year}-${Date.now()}`; // practically unreachable fallback
}

/** Bell + OS push for one task event, deduped per (user, type, recordRef) so
 *  re-saves and sweep re-runs never double-notify. */
async function notifyTaskUser(
  userId: number,
  n: {
    type: string;
    title: string;
    body: string;
    recordRef: string;
    businessId?: number | null;
    branchCode?: string | null;
    actorName?: string | null;
    priority?: string | null;
    url?: string;
  },
  opts?: { push?: boolean },
): Promise<void> {
  try {
    const [dupe] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, Number(userId)),
          eq(notifications.type, n.type),
          eq(notifications.recordRef, n.recordRef),
        ),
      )
      .limit(1);
    if (dupe) return;
    const ownerId = n.businessId != null ? await ownerOrgOfBusiness(Number(n.businessId)) : null;
    await db.insert(notifications).values({
      userId: Number(userId),
      type: n.type,
      title: n.title.slice(0, 240),
      body: n.body.slice(0, 600) || null,
      recordType: "ACTION_TASK",
      recordId: null,
      recordRef: n.recordRef,
      businessId: n.businessId ?? null,
      branchCode: n.branchCode ?? null,
      actorName: n.actorName ?? null,
      priority: n.priority ?? null,
      ownerId,
    });
    if (opts?.push !== false) {
      pushAfterBell([Number(userId)], {
        type: n.type,
        title: n.title.slice(0, 240),
        body: n.body.slice(0, 600),
        url: n.url || "/?tab=ACTION_CENTER",
      });
    }
  } catch (e) {
    console.error("[actionCenter] notifyTaskUser failed:", e);
  }
}

export interface CreateTaskInput {
  title: string;
  detail?: string | null;
  businessId?: number | null;
  branchCode?: string | null;
  assignedUserId: number;
  assignedUserName?: string | null;
  createdByUserId?: number | null;
  createdByName?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  sourceType?: string | null;
  sourceId?: number | null;
  sourceRef?: string | null;
  sourceLabel?: string | null;
}

/** Insert one native task + notify the assignee (TASK_ASSIGNED). */
export async function createTask(input: CreateTaskInput): Promise<any> {
  const title = String(input.title || "").trim().slice(0, 200);
  if (!title) throw new Error("A task needs a title.");
  if (input.dueDate && !isValidISODate(input.dueDate)) throw new Error("dueDate must be YYYY-MM-DD.");
  const taskNumber = await nextTaskNumber();
  const ownerId =
    input.businessId != null
      ? (await ownerOrgOfBusiness(Number(input.businessId))) ?? 0
      : (await orgOfUser(input.createdByUserId)) ?? 0;
  const [task] = await db
    .insert(actionTasks)
    .values({
      taskNumber,
      ownerId,
      businessId: input.businessId != null ? Number(input.businessId) : null,
      branchCode: input.branchCode ? String(input.branchCode).slice(0, 40) : null,
      title,
      detail: input.detail ? String(input.detail).slice(0, 2000) : null,
      sourceType: String(input.sourceType || "MANUAL").toUpperCase(),
      sourceId: input.sourceId != null ? Number(input.sourceId) : null,
      sourceRef: input.sourceRef ? String(input.sourceRef).slice(0, 160) : null,
      sourceLabel: input.sourceLabel ? String(input.sourceLabel).slice(0, 200) : null,
      assignedUserId: Number(input.assignedUserId),
      assignedUserName: input.assignedUserName ? String(input.assignedUserName) : null,
      createdByUserId: input.createdByUserId != null ? Number(input.createdByUserId) : null,
      createdByName: input.createdByName ? String(input.createdByName) : null,
      priority: normTaskPriority(input.priority),
      status: "OPEN",
      dueDate: input.dueDate || null,
    })
    .returning();
  if (Number(input.assignedUserId) !== Number(input.createdByUserId)) {
    await notifyTaskUser(Number(input.assignedUserId), {
      type: "TASK_ASSIGNED",
      title: `Action assigned: ${title}`,
      body: `${input.createdByName || "A manager"} assigned you an action${input.dueDate ? ` due ${input.dueDate}` : ""} — ${normTaskPriority(input.priority)} priority.${input.sourceLabel ? ` From: ${input.sourceLabel}.` : ""} Open it in the Action Center.`,
      recordRef: taskNumber,
      businessId: input.businessId ?? null,
      branchCode: input.branchCode ?? null,
      actorName: input.createdByName ?? null,
      priority: normTaskPriority(input.priority),
    });
  }
  return task;
}

/** The organization(s) a user belongs to (first one, for org-wide tasks). */
export async function orgOfUser(userId: number | null | undefined): Promise<number | null> {
  if (userId == null) return null;
  const [m] = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, Number(userId)))
    .limit(1);
  return m ? Number(m.organizationId) : null;
}

/** Mark every still-open task linked to a now-resolved source as DONE —
 *  the auto-completion half of "the source stays the source of truth".
 *  Called by the daily ops sweep AND inline wherever a source resolves
 *  (audit verify, advisor follow-up close). */
export async function completeLinkedTasksForSource(
  sourceType: string,
  sourceId: number,
  byName: string | null,
  note?: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(actionTasks)
    .where(
      and(
        eq(actionTasks.sourceType, String(sourceType).toUpperCase()),
        eq(actionTasks.sourceId, Number(sourceId)),
        inArray(actionTasks.status, ACTION_OPEN_STATUSES),
      ),
    );
  let completed = 0;
  for (const t of rows) {
    await db
      .update(actionTasks)
      .set({
        status: "DONE",
        completedAt: new Date(),
        completedByName: byName || "GoMina 360",
        completionNote:
          (note ? `${note} ` : "") + `Auto-completed — the linked ${String(sourceType).toLowerCase().replaceAll("_", " ")} was resolved.`,
        updatedAt: new Date(),
      })
      .where(eq(actionTasks.id, t.id));
    completed++;
    if (Number(t.createdByUserId) && Number(t.createdByUserId) !== Number(t.assignedUserId)) {
      await notifyTaskUser(
        Number(t.createdByUserId),
        {
          type: "TASK_COMPLETED",
          title: `Action done: ${t.title}`,
          body: `${t.assignedUserName || "The assignee"} completed ${t.taskNumber} automatically — its linked item was resolved.`,
          recordRef: `${t.taskNumber}:done`,
          businessId: t.businessId,
          branchCode: t.branchCode,
          actorName: byName || "GoMina 360",
          priority: t.priority,
        },
        { push: false },
      );
    }
  }
  return completed;
}

// ─── Linked open items (read-only views over existing systems) ─────────────

export interface LinkedItem {
  kind: "AUDIT_ISSUE" | "ADVISOR_FOLLOW_UP" | "CHECKLIST";
  id: number;
  businessId: number | null;
  branchCode?: string | null;
  title: string;
  detail?: string | null;
  priority: string;
  dueDate?: string | null;
  assignedUserId?: number | null;
  assignedUserName?: string | null;
  /** Deep link the UI offers (opens the owning module). */
  openTab: string;
  openHint: string;
}

/** Open audit issues in scope (managers/owners see their businesses' issues;
 *  everyone additionally sees issues assigned to them). */
export async function linkedAuditIssues(
  allowedBusinessIds: number[] | null,
  userId: number,
  limit = 60,
): Promise<LinkedItem[]> {
  const scopeFilter =
    allowedBusinessIds === null
      ? undefined
      : allowedBusinessIds.length
        ? or(
            inArray(auditReviews.businessId, allowedBusinessIds),
            eq(auditReviews.assignedUserId, userId),
          )
        : eq(auditReviews.assignedUserId, userId);
  const rows = await db
    .select()
    .from(auditReviews)
    .where(
      and(
        inArray(auditReviews.status, OPEN_ISSUE_STATUSES),
        or(eq(auditReviews.action, "FLAGGED"), eq(auditReviews.action, "CORRECTION_REQUESTED")),
        scopeFilter,
      ),
    )
    .orderBy(desc(auditReviews.id))
    .limit(limit);
  return rows.map((r) => ({
    kind: "AUDIT_ISSUE" as const,
    id: r.id,
    businessId: r.businessId,
    branchCode: r.branchCode,
    title: r.issueTitle || r.recordTitle || `Issue on ${r.recordRef || "record"}`,
    detail: `${r.status === "CORRECTION_REQUIRED" ? "Correction required" : "Flagged"} · ${r.recordRef || r.recordType}${r.assignedUserName ? ` · assigned to ${r.assignedUserName}` : ""}`,
    priority: normTaskPriority(r.priority),
    dueDate: r.dueDate || null,
    assignedUserId: r.assignedUserId,
    assignedUserName: r.assignedUserName,
    openTab: "AUDIT",
    openHint: "Audit & Review center",
  }));
}

/** Open advisor follow-ups (OPEN/IN_PROGRESS) in the caller's businesses. */
export async function linkedAdvisorFollowUps(
  allowedBusinessIds: number[] | null,
  limit = 40,
): Promise<LinkedItem[]> {
  const rows = await db
    .select()
    .from(advisorNotes)
    .where(
      and(
        inArray(advisorNotes.followUpStatus, OPEN_FOLLOWUP_STATUSES),
        allowedBusinessIds === null
          ? undefined
          : allowedBusinessIds.length
            ? inArray(advisorNotes.businessId, allowedBusinessIds)
            : sql`false`,
      ),
    )
    .orderBy(desc(advisorNotes.id))
    .limit(limit);
  return rows.map((r) => ({
    kind: "ADVISOR_FOLLOW_UP" as const,
    id: r.id,
    businessId: r.businessId,
    branchCode: r.branchCode,
    title: r.title,
    detail: `Advisor follow-up (${r.followUpStatus.toLowerCase()}) · ${r.authorName} · ${r.noteDate}`,
    priority: normTaskPriority(r.priority),
    dueDate: r.followUpDueDate || null,
    assignedUserId: null,
    assignedUserName: null,
    openTab: "ADVISOR",
    openHint: "Advisor Console",
  }));
}

/** Today's incomplete checklist entries per business (critical first). */
export async function linkedChecklistSummary(
  allowedBusinessIds: number[] | null,
  todayIso: string,
): Promise<{ businessId: number; open: number; critical: number }[]> {
  const rows = await db
    .select({
      businessId: checklistEntries.businessId,
      total: sql<number>`count(*)::int`,
      critical: sql<number>`count(*) filter (where upper(${checklistEntries.priority}) = 'CRITICAL')::int`,
    })
    .from(checklistEntries)
    .where(
      and(
        eq(checklistEntries.checklistDate, todayIso),
        eq(checklistEntries.isCompleted, false),
        allowedBusinessIds === null
          ? undefined
          : allowedBusinessIds.length
            ? inArray(checklistEntries.businessId, allowedBusinessIds)
            : sql`false`,
      ),
    )
    .groupBy(checklistEntries.businessId);
  return rows.map((r) => ({
    businessId: Number(r.businessId),
    open: Number(r.total) || 0,
    critical: Number(r.critical) || 0,
  }));
}

// ─── SLA escalation (daily ops) ────────────────────────────────────────────

/** Re-notify overdue open tasks: the assignee always; the business's
 *  escalation watchers (managers, owner on HIGH/CRITICAL) on the first
 *  overdue day and then weekly. recordRef carries the escalation step so
 *  each level notifies exactly once per recipient. */
export async function escalateOverdueTasks(opts?: { businessIds?: number[] | null }): Promise<number> {
  const today = todayLocalISO();
  const rows = await db
    .select()
    .from(actionTasks)
    .where(
      and(
        inArray(actionTasks.status, ACTION_OPEN_STATUSES),
        sql`${actionTasks.dueDate} is not null and ${actionTasks.dueDate} < ${today}`,
      ),
    )
    .limit(500);
  let notified = 0;
  const { auditEscalationRecipients } = await import("@/lib/notify");
  for (const t of rows) {
    if (opts?.businessIds != null && opts.businessIds.length === 0) continue;
    if (
      opts?.businessIds != null &&
      t.businessId != null &&
      !opts.businessIds.map(Number).includes(Number(t.businessId))
    )
      continue;
    const daysOverdue = Math.max(1, Math.round((Date.parse(today) - Date.parse(String(t.dueDate))) / 86400000));
    const step = daysOverdue <= 7 ? "d1" : `w${Math.floor(daysOverdue / 7)}`;
    const recordRef = `task-overdue:${t.id}:${step}`;
    const [assignee] = await db.select().from(users).where(eq(users.id, t.assignedUserId)).limit(1);
    const body = `${t.taskNumber} (${t.priority}) is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past its ${t.dueDate} deadline. Assigned to ${t.assignedUserName || "staff"}. Open the Action Center to complete or re-plan it.`;
    if (assignee?.isActive !== false) {
      await notifyTaskUser(t.assignedUserId, {
        type: "TASK_OVERDUE",
        title: `Overdue action: ${t.title}`,
        body,
        recordRef,
        businessId: t.businessId,
        branchCode: t.branchCode,
        actorName: "GoMina 360",
        priority: t.priority === "CRITICAL" ? "CRITICAL" : "HIGH",
      });
      notified++;
    }
    if (t.businessId != null) {
      const watchers = await auditEscalationRecipients(Number(t.businessId), t.priority, {
        excludeIds: [t.assignedUserId],
      });
      for (const w of watchers) {
        await notifyTaskUser(
          Number(w.id),
          {
            type: "TASK_OVERDUE",
            title: `Overdue action watch: ${t.title}`,
            body,
            recordRef: `${recordRef}:watch`,
            businessId: t.businessId,
            branchCode: t.branchCode,
            actorName: "GoMina 360",
            priority: t.priority === "CRITICAL" ? "CRITICAL" : "HIGH",
          },
          { push: false },
        );
      }
    }
  }
  return notified;
}

/** Auto-complete open tasks whose linked audit issue / advisor follow-up has
 *  been resolved since the last sweep. Cheap: only open linked tasks. */
export async function autoCompleteLinkedTasks(): Promise<number> {
  const open = await db
    .select()
    .from(actionTasks)
    .where(
      and(
        inArray(actionTasks.status, ACTION_OPEN_STATUSES),
        or(eq(actionTasks.sourceType, "AUDIT_ISSUE"), eq(actionTasks.sourceType, "ADVISOR_FOLLOW_UP")),
      ),
    )
    .limit(300);
  let completed = 0;
  for (const t of open) {
    if (t.sourceType === "AUDIT_ISSUE" && t.sourceId != null) {
      const [issue] = await db
        .select({ status: auditReviews.status, resolvedByName: auditReviews.resolvedByName })
        .from(auditReviews)
        .where(eq(auditReviews.id, Number(t.sourceId)))
        .limit(1);
      if (issue && !OPEN_ISSUE_STATUSES.includes(String(issue.status).toUpperCase())) {
        completed += await completeLinkedTasksForSource("AUDIT_ISSUE", Number(t.sourceId), issue.resolvedByName || "Audit center", `Issue is ${issue.status}.`);
      }
    } else if (t.sourceType === "ADVISOR_FOLLOW_UP" && t.sourceId != null) {
      const [note] = await db
        .select({ followUpStatus: advisorNotes.followUpStatus, authorName: advisorNotes.authorName })
        .from(advisorNotes)
        .where(eq(advisorNotes.id, Number(t.sourceId)))
        .limit(1);
      if (note && !OPEN_FOLLOWUP_STATUSES.includes(String(note.followUpStatus).toUpperCase())) {
        completed += await completeLinkedTasksForSource("ADVISOR_FOLLOW_UP", Number(t.sourceId), note.authorName || "Advisor", `Follow-up is ${note.followUpStatus}.`);
      }
    }
  }
  return completed;
}

/** Stats block for the Action Center header. */
export async function taskStats(tasks: any[], todayIso: string) {
  const open = tasks.filter((t) => ACTION_OPEN_STATUSES.includes(t.status));
  return {
    open: open.length,
    overdue: open.filter((t) => t.dueDate && String(t.dueDate) < todayIso).length,
    dueToday: open.filter((t) => String(t.dueDate || "") === todayIso).length,
    noDate: open.filter((t) => !t.dueDate).length,
    doneRecent: tasks.filter(
      (t) => t.status === "DONE" && t.completedAt && Date.now() - new Date(t.completedAt).getTime() < 7 * 86400000,
    ).length,
  };
}
