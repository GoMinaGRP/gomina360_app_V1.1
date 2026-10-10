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
import { isPlatformRequestActionable } from "@/lib/platformRequests";
import { pushAfterBell } from "@/lib/push";
import {
  actionTasks,
  advisorNotes,
  approvalRequests,
  auditReviews,
  businesses,
  checklistEntries,
  customerTrackings,
  inventoryItems,
  notifications,
  organizationMembers,
  platformRequests,
  transportMaintenance,
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
    recordId?: number | null;
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
      recordType: "action_tasks",
      // Carrying the task id is what lets the bell focus the exact action. It
      // was `null` here, so clicking any task notification opened the Action
      // Center with nothing selected.
      recordId: n.recordId ?? null,
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
  // Every state change routes through ONE transition table (see
  // notifyTaskTransition) instead of a chain of `if (status === …)` blocks.
  // The previous chain knew only about DONE, so CANCELLED and reopen were
  // silent, and its two "don't tell them about their own work" subtractions
  // cancelled each other out — a task with no explicit assignee (which defaults
  // the assignee to the creator) produced ZERO bell rows for anybody.
  await notifyTaskTransition({
    event: "raised",
    task: {
      id: task.id,
      taskNumber: task.taskNumber,
      title: task.title,
      businessId: input.businessId ?? null,
      branchCode: input.branchCode ?? null,
      assignedUserId: Number(input.assignedUserId),
      assignedUserName: input.assignedUserName ?? null,
      createdByUserId: input.createdByUserId != null ? Number(input.createdByUserId) : null,
      createdByName: input.createdByName ?? null,
      priority: normTaskPriority(input.priority),
      dueDate: input.dueDate || null,
      sourceLabel: input.sourceLabel ?? null,
    },
    actorName: input.createdByName ?? null,
    actorUserId: input.createdByUserId != null ? Number(input.createdByUserId) : null,
  });

  return task;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ACTION CENTER TRANSITION TABLE
 *
 * Every notification the Action Center emits is declared here, once, as
 * `(event → recipients)`. Nothing else in the app decides who hears about a
 * task — before this table, that decision lived as a chain of
 * `if (status === "DONE")` blocks in `api/tasks/route.ts` and two
 * `continue`-on-the-assignee guards in `createTask()`, and every transition
 * without a branch was silent.
 *
 *   raised     → assignee + workspace principals        (F-02: was zero rows
 *                 when the assignee defaulted to the creator)
 *   started    → assignee + creator + principals
 *   done       → creator + assignee + principals        (was: creator only)
 *   cancelled  → assignee + creator + principals        (F-03: was silent)
 *   reopened   → assignee + creator + principals        (F-04: was silent)
 *   overdue    → assignee + principals                  (was: assignee + a
 *                 SEPARATE ":watch" row for the same event — F-05)
 *
 * Two invariants hold for every row:
 *   • a user appears at most once per event (dedupe is on the EVENT's
 *     `recordRef`, which is `task:<id>:<event>` — identical for everyone);
 *   • workspace principals are resolved through `bellAudience.ts`, never by a
 *     hand-rolled membership read, so a platform Super Admin and a
 *     manage-delegated manager hear about the action exactly as they hear about
 *     every other event in their My Workspace.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type TaskEvent = "raised" | "started" | "done" | "cancelled" | "reopened" | "overdue";

interface TaskEventDef {
  type: string;
  /** Who hears about it, relative to the task. */
  to: ("assignee" | "creator" | "principals")[];
  title: (t: TaskBellShape) => string;
  body: (t: TaskBellShape) => string;
  /** Push only the assignee — the rest are context, not urgency. */
  pushAssigneeOnly?: boolean;
  priority?: string | null;
}

export interface TaskBellShape {
  id: number;
  taskNumber: string;
  title: string;
  businessId: number | null;
  branchCode: string | null;
  assignedUserId: number | null;
  assignedUserName: string | null;
  createdByUserId: number | null;
  createdByName: string | null;
  priority: string | null;
  dueDate: string | null;
  sourceLabel?: string | null;
  daysOverdue?: number;
}

const who = (t: TaskBellShape) => t.assignedUserName || "the assignee";
const creator = (t: TaskBellShape) => t.createdByName || "a manager";
const due = (t: TaskBellShape) => (t.dueDate ? `, due ${t.dueDate}` : "");

export const TASK_EVENTS: Record<TaskEvent, TaskEventDef> = {
  raised: {
    type: "TASK_ASSIGNED",
    to: ["assignee", "principals"],
    title: (t) => `Action raised: ${t.title}`,
    body: (t) =>
      `${creator(t)} raised ${t.priority || "NORMAL"} priority for ${who(t)}${due(t)}.` +
      (t.sourceLabel ? ` From: ${t.sourceLabel}.` : "") +
      ` Open it in the Action Center.`,
    pushAssigneeOnly: true,
  },
  started: {
    type: "TASK_STARTED",
    to: ["assignee", "creator", "principals"],
    title: (t) => `Action started: ${t.title}`,
    body: (t) => `${who(t)} picked up ${t.taskNumber}${due(t)}.`,
  },
  done: {
    type: "TASK_COMPLETED",
    to: ["assignee", "creator", "principals"],
    title: (t) => `Action done: ${t.title}`,
    body: (t) => `${who(t)} completed ${t.taskNumber}.`,
  },
  cancelled: {
    type: "TASK_CANCELLED",
    to: ["assignee", "creator", "principals"],
    title: (t) => `Action cancelled: ${t.title}`,
    body: (t) => `${t.taskNumber} was cancelled — it is no longer required.`,
    priority: "HIGH",
    pushAssigneeOnly: true,
  },
  reopened: {
    type: "TASK_REOPENED",
    to: ["assignee", "creator", "principals"],
    title: (t) => `Action reopened: ${t.title}`,
    body: (t) => `${t.taskNumber} is back on the plate${due(t)} — it was reopened and still needs to be done.`,
    priority: "HIGH",
    pushAssigneeOnly: true,
  },
  overdue: {
    type: "TASK_OVERDUE",
    to: ["assignee", "principals"],
    title: (t) => `Overdue action: ${t.title}`,
    body: (t) =>
      `${t.taskNumber} (${t.priority || "NORMAL"}) is ${t.daysOverdue ?? 1} day${(t.daysOverdue ?? 1) === 1 ? "" : "s"} past its ${t.dueDate} deadline.` +
      ` Assigned to ${who(t)}. Open the Action Center to complete or re-plan it.`,
    pushAssigneeOnly: true,
  },
};

/**
 * Emit one event's notification to its audience. The recipient set is computed
 * once, deduped, and every recipient gets the SAME `recordRef` — so the row is
 * identified by the event rather than by the recipient's role in it.
 *
 * Never throws: a bell failure must never block the state change.
 */
export async function notifyTaskTransition(input: {
  event: TaskEvent;
  task: TaskBellShape;
  actorName?: string | null;
  actorUserId?: number | null;
  /** Suppress the push entirely (used by the daily sweep). */
  push?: boolean;
  completionNote?: string | null;
  /**
   * Override the event identity. Used by the overdue escalation, whose
   * `d1` / `w3` window keeps the event distinct across escalation stages while
   * STILL being identical for every recipient.
   */
  recordRef?: string;
}): Promise<number> {
  const def = TASK_EVENTS[input.event];
  if (!def) return 0;
  const t = input.task;
  try {
    const audience = new Map<number, "assignee" | "other">();
    if (def.to.includes("assignee") && t.assignedUserId != null) {
      audience.set(Number(t.assignedUserId), "assignee");
    }
    if (def.to.includes("creator") && t.createdByUserId != null) {
      if (!audience.has(Number(t.createdByUserId))) audience.set(Number(t.createdByUserId), "other");
    }
    if (def.to.includes("principals") && t.businessId != null) {
      // Canonical resolver — the Owner's bell is the record of their workspace,
      // so principals are ADDED, never subtracted, not even when they are the
      // actor or the assignee.
      const { workspacePrincipals } = await import("@/lib/bellAudience");
      for (const p of await workspacePrincipals(Number(t.businessId))) {
        if (!audience.has(Number(p.id))) audience.set(Number(p.id), "other");
      }
    }
    if (!audience.size) return 0;

    const recordRef = input.recordRef || `task:${t.id}:${input.event}`;
    const title = def.title(t).slice(0, 240);
    const rawBody = def.body(t) + (input.completionNote ? ` — ${String(input.completionNote).slice(0, 200)}` : "");
    let sent = 0;
    for (const [userId, role] of audience) {
      await notifyTaskUser(
        userId,
        {
          type: def.type,
          title: role === "assignee" && input.event !== "raised" ? title : title,
          body: rawBody.slice(0, 600),
          recordRef,
          recordId: t.id,
          businessId: t.businessId,
          branchCode: t.branchCode,
          actorName: input.actorName ?? null,
          priority: def.priority ?? t.priority ?? null,
        },
        // Only the assignee's push carries urgency; the rest are context.
        input.push === false || def.pushAssigneeOnly
          ? role === "assignee"
            ? { push: input.push !== false }
            : { push: false }
          : {},
      );
      sent++;
    }
    return sent;
  } catch (e) {
    console.error("[actionCenter] notifyTaskTransition failed:", e);
    return 0;
  }
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
    // Same transition table as a human-driven completion, so an auto-completed
    // action reaches the same audience a manual one does.
    await notifyTaskTransition({
      event: "done",
      push: false,
      actorName: byName || "GoMina 360",
      task: {
        id: Number(t.id),
        taskNumber: t.taskNumber,
        title: t.title,
        businessId: t.businessId ?? null,
        branchCode: t.branchCode ?? null,
        assignedUserId: t.assignedUserId == null ? null : Number(t.assignedUserId),
        assignedUserName: t.assignedUserName ?? null,
        createdByUserId: t.createdByUserId == null ? null : Number(t.createdByUserId),
        createdByName: t.createdByName ?? null,
        priority: t.priority ?? null,
        dueDate: t.dueDate ?? null,
      },
    });
  }
  return completed;
}

// ─── Linked open items (read-only views over existing systems) ─────────────

export interface LinkedItem {
  kind: "AUDIT_ISSUE" | "ADVISOR_FOLLOW_UP" | "CHECKLIST" | "APPROVAL" | "LOW_STOCK" | "ORDER" | "MAINTENANCE" | "PLATFORM_REQUEST";
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
  /** Optional identifier the target module focuses on open (e.g. a platform
   *  request reference), so the click lands ON the item and not merely near it. */
  openRef?: string | null;
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
      sql`exists (select 1 from businesses b where b.id = ${auditReviews.businessId})`,
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
        sql`exists (select 1 from businesses b where b.id = ${advisorNotes.businessId})`,
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
        // P0.1: only LIVE businesses surface linked items — orphaned rows
        // (a unit deleted out-of-band, e.g. a direct-DB purge) must never
        // reach the Action Center as "Business #NNN" chips.
        sql`exists (select 1 from businesses b where b.id = ${checklistEntries.businessId})`,
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

// ─── R1: pending approvals as linked Action Center items ──────────────────

const APPROVAL_ACTION_LABELS: Record<string, string> = {
  EXPENSE: "Expense",
  PURCHASE_ORDER: "Purchase order",
  PURCHASE_REQUISITION: "Requisition",
  INVENTORY_ADJUSTMENT: "Stock adjustment",
  DISCOUNT: "Discount",
  DELETION: "Deletion",
  DATA_EXPORT: "Data export",
};

/** Pending approval requests the caller is entitled to decide — surfaced in
 *  the Action Center's linked zone so approvers see them beside tasks. */
export async function linkedApprovals(
  user: { id: number; role?: string | null; isSuperAdmin?: boolean; organizationIds?: number[] },
  allowedBusinessIds: number[] | null,
  limit = 40,
): Promise<LinkedItem[]> {
  const { pendingRequestsForApprover } = await import("@/lib/approvals");
  const rows = await pendingRequestsForApprover(user as any, allowedBusinessIds);
  return rows.slice(0, limit).map((r) => ({
    kind: "APPROVAL" as const,
    id: Number(r.id),
    businessId: Number(r.businessId),
    branchCode: r.branchCode,
    title: `${APPROVAL_ACTION_LABELS[String(r.action).toUpperCase()] || r.action} approval — ${r.targetLabel || `#${r.targetId}`}`,
    detail: `${r.requestedByName || "Staff"} · ${
      r.amountGhs != null && Number(r.amountGhs) > 0 ? `GH₵ ${Number(r.amountGhs).toFixed(2)} · ` : ""
    }awaiting decision`,
    priority: "HIGH",
    dueDate: null,
    assignedUserId: null,
    assignedUserName: r.requestedByName,
    openTab: "ACTION_CENTER",
    openHint: "Approvals inbox",
  }));
}

/**
 * Platform registration requests awaiting the platform team (SUPER ADMIN ONLY).
 *
 * These are PLATFORM-level records: they belong to no tenant, so they are never
 * derived from a business scope — an organization OWNER, GM or BM must not see
 * them anywhere, including here. That is why this source is gated on the Super
 * Admin flag rather than on `allowedBusinessIds`.
 *
 * The list is LIVE: it is recomputed from `platform_requests` on every read, so
 * the Action Center can never disagree with the review queue. A request leaves
 * the list the moment it stops being actionable — rejected, closed, or approved
 * AND provisioned (see `isPlatformRequestActionable`).
 */
export async function linkedPlatformRequests(
  user: { id: number; role?: string | null; isSuperAdmin?: boolean },
  limit = 40,
): Promise<LinkedItem[]> {
  if (!user?.isSuperAdmin) return [];
  const { platformRequests } = await import("@/db/schema");
  const { isPlatformRequestActionable, purposeLabel, businessTypeLabel, platformRequestBellTitle } = await import(
    "@/lib/platformRequests"
  );
  const rows = await db
    .select({
      id: platformRequests.id,
      reference: platformRequests.reference,
      purpose: platformRequests.purpose,
      businessName: platformRequests.businessName,
      businessType: platformRequests.businessType,
      contactName: platformRequests.contactName,
      contactEmail: platformRequests.contactEmail,
      contactPhone: platformRequests.contactPhone,
      location: platformRequests.location,
      status: platformRequests.status,
      createdOrganizationId: platformRequests.createdOrganizationId,
      createdAt: platformRequests.createdAt,
    })
    .from(platformRequests)
    .orderBy(desc(platformRequests.id))
    .limit(200);

  const actionable = rows.filter((r) => isPlatformRequestActionable(r.status, r.createdOrganizationId));
  return actionable.slice(0, limit).map((r) => ({
    kind: "PLATFORM_REQUEST" as const,
    id: Number(r.id),
    businessId: null,
    branchCode: null,
    title: `${r.businessName || r.contactName || "Registration"} — ${purposeLabel(r.purpose)}${
      r.businessType ? ` (${businessTypeLabel(r.businessType)})` : ""
    }`,
    detail: `${platformRequestBellTitle(r.status, r.createdOrganizationId)} · ${r.contactName || "Applicant"}${
      r.contactPhone ? ` · ${r.contactPhone}` : ""
    }${r.contactEmail ? ` · ${r.contactEmail}` : ""}`,
    priority: String(r.status) === "PENDING" ? "HIGH" : "MEDIUM",
    dueDate: null,
    assignedUserId: null,
    assignedUserName: r.contactName || null,
    openTab: "PLATFORM_ADMIN",
    openHint: `Review request · ${r.reference}`,
    openRef: r.reference,
  }));
}

/** Low-stock alerts: items whose stock is at or below reorder threshold. */
export async function linkedLowStock(
  allowedBusinessIds: number[] | null,
  limit = 40,
): Promise<LinkedItem[]> {
  const scopeFilter =
    allowedBusinessIds === null
      ? undefined
      : allowedBusinessIds.length
        ? inArray(inventoryItems.businessId, allowedBusinessIds)
        : sql`false`;

  const rows = await db
    .select({
      id: inventoryItems.id,
      businessId: inventoryItems.businessId,
      branchCode: inventoryItems.branchCode,
      name: inventoryItems.name,
      sku: inventoryItems.sku,
      quantity: inventoryItems.quantity,
      minStockThreshold: inventoryItems.minStockThreshold,
      unit: inventoryItems.unit,
      status: inventoryItems.status,
    })
    .from(inventoryItems)
    .where(
      and(
        sql`exists (select 1 from businesses b where b.id = ${inventoryItems.businessId})`,
        sql`((("quantity" <= "min_stock_threshold" AND "min_stock_threshold" > 0) OR "quantity" <= 0) OR "status" = 'OUT_OF_STOCK')`,
        scopeFilter,
      ),
    )
    .orderBy(inventoryItems.quantity)
    .limit(limit);

  return rows.map((r) => {
    const isOut = Number(r.quantity) <= 0 || r.status === "OUT_OF_STOCK";
    return {
      kind: "LOW_STOCK" as const,
      id: r.id,
      businessId: r.businessId,
      branchCode: r.branchCode,
      title: `Low stock alert: ${r.name}`,
      detail: `${isOut ? "OUT OF STOCK" : `${r.quantity} ${r.unit || "units"} remaining`} · Reorder point: ${r.minStockThreshold || 1} ${r.unit || "units"}${r.sku ? ` · SKU: ${r.sku}` : ""}`,
      priority: isOut ? "CRITICAL" : "HIGH",
      dueDate: todayLocalISO(),
      assignedUserId: null,
      assignedUserName: null,
      openTab: r.branchCode || "PROCUREMENT",
      openHint: "Procurement & Restock",
    };
  });
}

/** Actionable customer orders: unfulfilled or pending confirmation. */
export async function linkedPendingOrders(
  allowedBusinessIds: number[] | null,
  limit = 40,
): Promise<LinkedItem[]> {
  const scopeFilter =
    allowedBusinessIds === null
      ? undefined
      : allowedBusinessIds.length
        ? inArray(customerTrackings.businessId, allowedBusinessIds)
        : sql`false`;

  const rows = await db
    .select()
    .from(customerTrackings)
    .where(
      and(
        sql`exists (select 1 from businesses b where b.id = ${customerTrackings.businessId})`,
        or(
          inArray(customerTrackings.status, ["RECEIVED", "CONFIRMED", "PROCESSING"]),
          eq(customerTrackings.paymentStatus, "PENDING_CONFIRMATION"),
        ),
        scopeFilter,
      ),
    )
    .orderBy(desc(customerTrackings.id))
    .limit(limit);

  return rows.map((r) => {
    const isMomoPending = r.paymentStatus === "PENDING_CONFIRMATION";
    const itemsList = Array.isArray(r.items) ? (r.items as any[]) : [];
    const itemSummary = itemsList.map((it: any) => `${it.quantity || 1}x ${it.description || "item"}`).join(", ");
    return {
      kind: "ORDER" as const,
      id: r.id,
      businessId: r.businessId,
      branchCode: r.branchCode,
      title: `Order ${r.trackingCode || `#${r.id}`} — ${r.customerName || "Customer"}`,
      detail: `${isMomoPending ? "MoMo payment confirmation needed · " : `Status: ${r.status} · `}${itemSummary || "Items pending fulfillment"}${r.totalGhs ? ` · GH₵ ${Number(r.totalGhs).toFixed(2)}` : ""}`,
      priority: isMomoPending || r.status === "RECEIVED" ? "HIGH" : "MEDIUM",
      dueDate: r.preorderExpectedAt ? String(r.preorderExpectedAt).slice(0, 10) : todayLocalISO(),
      assignedUserId: null,
      assignedUserName: r.driverName || null,
      openTab: "TRACKING",
      openHint: "Customer Order & Tracking",
    };
  });
}

/** Active / scheduled maintenance jobs across transport fleet and assets. */
export async function linkedMaintenanceJobs(
  allowedBusinessIds: number[] | null,
  limit = 30,
): Promise<LinkedItem[]> {
  const scopeFilter =
    allowedBusinessIds === null
      ? undefined
      : allowedBusinessIds.length
        ? inArray(transportMaintenance.businessId, allowedBusinessIds)
        : sql`false`;

  const rows = await db
    .select()
    .from(transportMaintenance)
    .where(
      and(
        sql`exists (select 1 from businesses b where b.id = ${transportMaintenance.businessId})`,
        inArray(transportMaintenance.status, ["DUE", "SCHEDULED", "IN_PROGRESS"]),
        scopeFilter,
      ),
    )
    .orderBy(desc(transportMaintenance.id))
    .limit(limit);

  return rows.map((r) => ({
    kind: "MAINTENANCE" as const,
    id: r.id,
    businessId: r.businessId,
    branchCode: r.branchCode,
    title: `Maintenance: ${r.title || "Fleet Service"}`,
    detail: `${r.status === "IN_PROGRESS" ? "In Progress" : r.status === "DUE" ? "Due for Service" : "Scheduled"} · ${r.vendorName || "Workshop"}${r.estimatedCostGhs ? ` · Est. GH₵ ${Number(r.estimatedCostGhs).toFixed(2)}` : ""}${r.dueDate ? ` · Due ${r.dueDate}` : ""}`,
    priority: r.status === "IN_PROGRESS" || r.status === "DUE" ? "HIGH" : "MEDIUM",
    dueDate: r.dueDate ? String(r.dueDate).slice(0, 10) : todayLocalISO(),
    assignedUserId: null,
    assignedUserName: null,
    openTab: "TRANSPORT",
    openHint: "Transport & Fleet Maintenance",
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
  for (const t of rows) {
    if (opts?.businessIds != null && opts.businessIds.length === 0) continue;
    if (
      opts?.businessIds != null &&
      t.businessId != null &&
      !opts.businessIds.map(Number).includes(Number(t.businessId))
    )
      continue;
    const daysOverdue = Math.max(1, Math.round((Date.parse(today) - Date.parse(String(t.dueDate))) / 86400000));
    // The escalation WINDOW (first day out, then weekly) — part of the event's
    // identity, so a long-overdue action escalates once per window, not daily.
    const step = daysOverdue <= 7 ? "d1" : `w${Math.floor(daysOverdue / 7)}`;
    // One event, one `recordRef` (`task:<id>:overdue`) for EVERY recipient.
    // The previous code gave the assignee `task-overdue:<id>:<step>` and every
    // other watcher `…:<step>:watch` — a per-recipient suffix that existed only
    // to defeat the dedupe key, so an Owner who assigned an overdue action to
    // themselves received BOTH rows for one event (two unread badge counts).
    // The step (`d1` / `w3`) is retained inside the event identity so the
    // escalation still only fires once per escalation window.
    await notifyTaskTransition({
      event: "overdue",
      push: false,
      recordRef: `task:${t.id}:overdue:${step}`,
      actorName: "GoMina 360",
      task: {
        id: Number(t.id),
        taskNumber: t.taskNumber,
        title: t.title,
        businessId: t.businessId ?? null,
        branchCode: t.branchCode ?? null,
        assignedUserId: t.assignedUserId == null ? null : Number(t.assignedUserId),
        assignedUserName: t.assignedUserName ?? null,
        createdByUserId: t.createdByUserId == null ? null : Number(t.createdByUserId),
        createdByName: t.createdByName ?? null,
        priority: t.priority ?? null,
        dueDate: t.dueDate ? String(t.dueDate) : null,
        daysOverdue,
      },
    });
    notified++;
  }
  return notified;
}

/** Auto-complete open tasks whose linked audit issue / advisor follow-up /
 *  approval / low stock / order / maintenance has been resolved since the last
 *  sweep. Cheap: only open linked tasks. */
export async function autoCompleteLinkedTasks(): Promise<number> {
  const open = await db
    .select()
    .from(actionTasks)
    .where(
      and(
        inArray(actionTasks.status, ACTION_OPEN_STATUSES),
        or(
          eq(actionTasks.sourceType, "AUDIT_ISSUE"),
          eq(actionTasks.sourceType, "ADVISOR_FOLLOW_UP"),
          eq(actionTasks.sourceType, "APPROVAL"),
          eq(actionTasks.sourceType, "LOW_STOCK"),
          eq(actionTasks.sourceType, "ORDER"),
          eq(actionTasks.sourceType, "MAINTENANCE"),
          eq(actionTasks.sourceType, "PLATFORM_REQUEST"),
        ),
      ),
    )
    .limit(400);
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
    } else if (t.sourceType === "APPROVAL" && t.sourceId != null) {
      const [appReq] = await db
        .select({ status: approvalRequests.status, decidedByName: approvalRequests.decidedByName })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, Number(t.sourceId)))
        .limit(1);
      if (appReq && String(appReq.status).toUpperCase() !== "PENDING") {
        completed += await completeLinkedTasksForSource("APPROVAL", Number(t.sourceId), appReq.decidedByName || "Approver", `Approval request is ${appReq.status}.`);
      }
    } else if (t.sourceType === "LOW_STOCK" && t.sourceId != null) {
      const [inv] = await db
        .select({ quantity: inventoryItems.quantity, minStockThreshold: inventoryItems.minStockThreshold, status: inventoryItems.status })
        .from(inventoryItems)
        .where(eq(inventoryItems.id, Number(t.sourceId)))
        .limit(1);
      if (inv && Number(inv.quantity) > (Number(inv.minStockThreshold) || 0) && inv.status !== "OUT_OF_STOCK") {
        completed += await completeLinkedTasksForSource("LOW_STOCK", Number(t.sourceId), "Inventory System", "Stock replenished above reorder threshold.");
      }
    } else if (t.sourceType === "ORDER" && t.sourceId != null) {
      const [ord] = await db
        .select({ status: customerTrackings.status, driverName: customerTrackings.driverName })
        .from(customerTrackings)
        .where(eq(customerTrackings.id, Number(t.sourceId)))
        .limit(1);
      if (ord && ["DELIVERED", "COMPLETED", "CANCELLED"].includes(String(ord.status).toUpperCase())) {
        completed += await completeLinkedTasksForSource("ORDER", Number(t.sourceId), ord.driverName || "Fulfillment", `Order is ${ord.status}.`);
      }
    } else if (t.sourceType === "PLATFORM_REQUEST" && t.sourceId != null) {
      const [req] = await db
        .select({
          status: platformRequests.status,
          createdOrganizationId: platformRequests.createdOrganizationId,
          reference: platformRequests.reference,
        })
        .from(platformRequests)
        .where(eq(platformRequests.id, Number(t.sourceId)))
        .limit(1);
      // Same rule as the bell / badge / linked list: the mirror closes exactly
      // when the request stops needing the platform team.
      if (req && !isPlatformRequestActionable(req.status, req.createdOrganizationId)) {
        completed += await completeLinkedTasksForSource(
          "PLATFORM_REQUEST",
          Number(t.sourceId),
          "Platform Owners",
          `Request ${req.reference} is ${req.status}.`,
        );
      }
    } else if (t.sourceType === "MAINTENANCE" && t.sourceId != null) {
      const [maint] = await db
        .select({ status: transportMaintenance.status, createdByName: transportMaintenance.createdByName })
        .from(transportMaintenance)
        .where(eq(transportMaintenance.id, Number(t.sourceId)))
        .limit(1);
      if (maint && ["DONE", "COMPLETED", "CANCELLED"].includes(String(maint.status).toUpperCase())) {
        completed += await completeLinkedTasksForSource("MAINTENANCE", Number(t.sourceId), maint.createdByName || "Fleet Workshop", `Maintenance is ${maint.status}.`);
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
