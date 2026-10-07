import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { purposeLabel } from "@/lib/platformRequests";
import {
  actionTasks,
  businesses,
  notifications,
  organizationMembers,
  platformRequests,
  userBusinessAccess,
  users,
} from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { createTask, taskStats, todayLocalISO, ACTION_OPEN_STATUSES, isValidISODate, normTaskStatus, normTaskPriority } from "@/lib/actionCenter";
import {
  linkedAuditIssues,
  linkedAdvisorFollowUps,
  linkedChecklistSummary,
  linkedApprovals,
  linkedPlatformRequests,
  linkedLowStock,
  linkedPendingOrders,
  linkedMaintenanceJobs,
} from "@/lib/actionCenter";
import { pushAfterBell } from "@/lib/push";
import { businessManageIdsOf } from "@/lib/permissions";
import { inRoleGroup } from "@/lib/roles";

/**
 * Unified Action Center API (P1).
 *
 *  GET    — my/open task list (role-scoped), header stats, linked open items
 *           from the systems that already track actions (audit issues,
 *           advisor follow-ups, today's checklists) and the assignable-staff
 *           picker for the create form.
 *  POST   — create a native task (manual, converted from a notification, or
 *           mirrored from a linked item).
 *  PATCH  — update / progress / complete a task (assignee completes; creator
 *           and unit managers edit anything).
 *
 * Tenant isolation mirrors the audit & checklist routes: every read is
 * filtered to the caller's accessible businesses (or their own assignments);
 * every write re-verifies business access + same-organization assignees.
 */

/** Executive bench (registry-owned) — a Co-Owner now sees the org-wide tasks
 *  a GM sees; the old literal list silently dropped Co-Owner (audit F4). */
const isExec = (u: any) => !!u && (inRoleGroup("EXECUTIVE", u.role) || !!u.isSuperAdmin);

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const { searchParams } = new URL(request.url);
    const today = todayLocalISO();
    const allowed = await accessibleBusinessIds(user);
    const allowedList = allowed; // number[] | null (null ⇒ unrestricted)
    const role = String(user.role || "").toUpperCase();
    const managed = businessManageIdsOf(user);

    // ── Native tasks in scope ──
    const scopeOr = [];
    scopeOr.push(eq(actionTasks.assignedUserId, Number(user.id)));
    if (allowedList !== null && allowedList.length) {
      scopeOr.push(inArray(actionTasks.businessId, allowedList));
    } else if (allowedList === null) {
      // Unrestricted (super admin / org-less legacy): everything.
      scopeOr.push(sql`true`);
    }
    const statusFilter = String(searchParams.get("status") || "").toUpperCase();
    const whereParts: any[] = [or(...scopeOr)];
    if (statusFilter && ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(statusFilter)) {
      whereParts.push(eq(actionTasks.status, statusFilter));
    } else if (statusFilter === "ACTIVE") {
      whereParts.push(inArray(actionTasks.status, ACTION_OPEN_STATUSES));
    }
    const priorityFilter = String(searchParams.get("priority") || "").toUpperCase();
    if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(priorityFilter)) {
      whereParts.push(eq(actionTasks.priority, priorityFilter));
    }
    const bizFilter = Number(searchParams.get("businessId")) || 0;
    if (bizFilter) {
      if (allowedList !== null && !allowedList.includes(bizFilter)) return FORBIDDEN("That business is outside your scope.");
      whereParts.push(eq(actionTasks.businessId, bizFilter));
    }
    const rows = await db
      .select()
      .from(actionTasks)
      .where(and(...whereParts))
      .orderBy(
        sql`case ${actionTasks.status} when 'OPEN' then 0 when 'IN_PROGRESS' then 1 else 2 end`,
        sql`${actionTasks.dueDate} asc nulls last`,
        desc(actionTasks.id),
      )
      .limit(400);

    // Workers only ever see their own tasks — enforce even on the OR above.
    const visible = role === "WORKER" ? rows.filter((r) => Number(r.assignedUserId) === Number(user.id)) : rows;

    // Business labels for chips.
    const bizIds = Array.from(new Set(visible.map((r) => Number(r.businessId)).filter(Number.isFinite)));
    const bizRows = bizIds.length
      ? await db.select({ id: businesses.id, name: businesses.name, code: businesses.code }).from(businesses).where(inArray(businesses.id, bizIds))
      : [];
    const bizById = new Map(bizRows.map((b) => [Number(b.id), b]));
    const tasks = visible.map((r) => ({
      ...r,
      businessName: r.businessId != null ? bizById.get(Number(r.businessId))?.name ?? null : null,
      businessCode: r.businessId != null ? bizById.get(Number(r.businessId))?.code ?? null : null,
    }));

    const stats = await taskStats(tasks, today);
    const mine = tasks.filter((t) => ACTION_OPEN_STATUSES.includes(t.status) && Number(t.assignedUserId) === Number(user.id));

    // ── Linked open items (read-only views over existing systems) ──
    const includeLinked = searchParams.get("includeLinked") !== "0";
    let linked: any = {
      auditIssues: [],
      advisorFollowUps: [],
      checklist: [],
      approvals: [],
      lowStock: [],
      orders: [],
      maintenance: [],
      // Platform registration requests needing the platform team (Super Admin only).
      platformRequests: [],
    };
    if (includeLinked) {
      const linkedScope = role === "WORKER" ? [] : allowedList === null ? null : allowedList;
      linked.auditIssues = await linkedAuditIssues(linkedScope, Number(user.id));
      linked.advisorFollowUps = await linkedAdvisorFollowUps(linkedScope);
      linked.checklist = await linkedChecklistSummary(allowedList, today);
      // Platform registrations are platform-level records (no tenant scope), so
      // they are gated on the Super Admin flag — never on a business list.
      linked.platformRequests = await linkedPlatformRequests(user);
      // R1: approvers see pending gated records beside their other actions.
      if (role !== "WORKER") {
        linked.approvals = await linkedApprovals(user, linkedScope);
        linked.lowStock = await linkedLowStock(linkedScope);
        linked.orders = await linkedPendingOrders(linkedScope);
        linked.maintenance = await linkedMaintenanceJobs(linkedScope);
      } else {
        const ids = new Set<number>();
        if (user.assignedBusinessId != null) ids.add(Number(user.assignedBusinessId));
        const grants = await db
          .select({ businessId: userBusinessAccess.businessId })
          .from(userBusinessAccess)
          .where(eq(userBusinessAccess.userId, Number(user.id)));
        for (const g of grants) ids.add(Number(g.businessId));
        const workerBizList = Array.from(ids);
        if (!linked.checklist.length && workerBizList.length) {
          linked.checklist = await linkedChecklistSummary(workerBizList, today);
        }
        if (workerBizList.length) {
          linked.lowStock = await linkedLowStock(workerBizList);
          linked.orders = await linkedPendingOrders(workerBizList);
          linked.maintenance = await linkedMaintenanceJobs(workerBizList);
        }
      }
    }

    // ── Assignable staff for the create form ──
    const orgIds = (session.orgId ? [session.orgId] : []).concat(
      (user.organizationIds as number[] | undefined)?.map(Number).filter(Boolean) ?? [],
    );
    let assignable: { id: number; name: string; role: string; assignedBusinessId: number | null }[] = [];
    if (isExec(user)) {
      const memberRows = orgIds.length
        ? await db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(inArray(organizationMembers.organizationId, orgIds))
        : [];
      const memberSet = new Set(memberRows.map((m) => Number(m.userId)).concat(Number(user.id)));
      const all = await db
        .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive, assignedBusinessId: users.assignedBusinessId })
        .from(users)
        .limit(300);
      assignable = all
        .filter((u) => u.isActive !== false && (memberSet.has(Number(u.id)) || (user.isSuperAdmin && true)))
        .map((u) => ({ id: Number(u.id), name: u.name, role: u.role, assignedBusinessId: u.assignedBusinessId != null ? Number(u.assignedBusinessId) : null }));
    } else {
      assignable = [{ id: Number(user.id), name: user.name, role: user.role, assignedBusinessId: user.assignedBusinessId != null ? Number(user.assignedBusinessId) : null }];
    }

    return NextResponse.json({
      success: true,
      today,
      tasks,
      stats: { ...stats, mine: mine.length, mineOverdue: mine.filter((t) => t.dueDate && String(t.dueDate) < today).length, mineDueToday: mine.filter((t) => String(t.dueDate || "") === today).length },
      linked,
      assignableUsers: assignable,
      canManage: isExec(user) || managed.length > 0,
    });
  } catch (e) {
    console.error("[api/tasks GET]", e);
    return NextResponse.json({ success: false, error: "Could not load the Action Center." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || "").trim();
    const sourceTypePre = String(body.sourceType || "MANUAL").toUpperCase();
    // Notification conversions may omit the title — the source row's own
    // title (validated to exist below) becomes the task title.
    if (!title && sourceTypePre !== "NOTIFICATION") {
      return NextResponse.json({ success: false, error: "Give the action a title." }, { status: 400 });
    }
    const assignedUserId = Number(body.assignedUserId) || Number(user.id);
    const businessId = body.businessId != null && Number(body.businessId) > 0 ? Number(body.businessId) : null;
    const dueDate = body.dueDate ? String(body.dueDate) : null;
    if (dueDate && !isValidISODate(dueDate)) {
      return NextResponse.json({ success: false, error: "Due date must be YYYY-MM-DD." }, { status: 400 });
    }

    // Business scope gate.
    if (businessId != null && !(await canAccessBusiness(user, businessId))) {
      return FORBIDDEN("That business is outside your scope.");
    }

    // Assignee gate: active + same organization (tenant guard), and — when
    // the task is business-scoped — actually attached to that business
    // (assignment, grant, or an executive role).
    const [assignee] = await db.select().from(users).where(eq(users.id, assignedUserId)).limit(1);
    if (!assignee || assignee.isActive === false) {
      return NextResponse.json({ success: false, error: "Assignee not found or inactive." }, { status: 400 });
    }
    if (!user.isSuperAdmin) {
      const myOrgs = new Set(
        (await db
          .select({ organizationId: organizationMembers.organizationId })
          .from(organizationMembers)
          .where(eq(organizationMembers.userId, Number(user.id)))).map((m) => Number(m.organizationId)),
      );
      const theirOrgs = new Set(
        (await db
          .select({ organizationId: organizationMembers.organizationId })
          .from(organizationMembers)
          .where(eq(organizationMembers.userId, assignedUserId))).map((m) => Number(m.organizationId)),
      );
      const sharesOrg = myOrgs.size === 0 || theirOrgs.size === 0
        ? myOrgs.size === 0 && theirOrgs.size === 0
        : Array.from(myOrgs).some((o) => theirOrgs.has(o));
      if (!sharesOrg) return FORBIDDEN("Tasks can only be assigned inside your organization.");
      if (businessId != null && assignedUserId !== Number(user.id) && !isExec(user)) {
        const attached =
          assignee.assignedBusinessId != null && Number(assignee.assignedBusinessId) === businessId;
        const granted = await db
          .select({ userId: userBusinessAccess.userId })
          .from(userBusinessAccess)
          .where(and(eq(userBusinessAccess.userId, assignedUserId), eq(userBusinessAccess.businessId, businessId)))
          .limit(1);
        const isBizManager = businessManageIdsOf(user).includes(businessId);
        if (!attached && !granted.length && !isBizManager) {
          return FORBIDDEN("That staff member is not attached to the selected business.");
        }
      }
    }

    // Notification conversion: the source row must be the creator's own bell.
    let sourceTitle: string | null = null;
    let sourceDetail: string | null = null;
    let sourceRef: string | null = body.sourceRef ? String(body.sourceRef) : null;
    let sourceBusinessId = businessId;
    let sourceBranch: string | null = body.branchCode ? String(body.branchCode) : null;
    const sourceType = String(body.sourceType || "MANUAL").toUpperCase();
    const sourceId = body.sourceId != null ? Number(body.sourceId) : null;
    // Platform registration requests are PLATFORM records: only the Super Admin
    // may mirror one, and the text is derived from the request itself — never
    // trusted from the client — so a tenant cannot forge a platform action.
    if (sourceType === "PLATFORM_REQUEST") {
      if (!user.isSuperAdmin) return FORBIDDEN("Platform registrations are visible to the platform Super Admin only.");
      if (sourceId == null) return NextResponse.json({ success: false, error: "Which request?" }, { status: 400 });
      const [req] = await db
        .select({
          reference: platformRequests.reference,
          businessName: platformRequests.businessName,
          contactName: platformRequests.contactName,
          purpose: platformRequests.purpose,
          status: platformRequests.status,
        })
        .from(platformRequests)
        .where(eq(platformRequests.id, sourceId))
        .limit(1);
      if (!req) return NextResponse.json({ success: false, error: "That request no longer exists." }, { status: 404 });
      sourceTitle = `${req.businessName || req.contactName || "Registration"} — platform registration review`;
      sourceDetail = `${purposeLabel(req.purpose)} · ref ${req.reference} · ${req.status}`;
      // The linkage is the PLATFORM's identifier: always derived server-side so
      // a mirrored task cannot point at a request other than the one it names.
      sourceRef = `platform-request:${req.reference}`;
      sourceBusinessId = null; // platform-level: belongs to no tenant
      sourceBranch = null;
    }
    if (sourceType === "NOTIFICATION" && sourceId != null) {
      const [n] = await db.select().from(notifications).where(eq(notifications.id, sourceId)).limit(1);
      if (!n || Number(n.userId) !== Number(user.id)) {
        return FORBIDDEN("Only your own notifications can be converted.");
      }
      sourceTitle = String(n.title || "");
      sourceDetail = String(n.body || "");
      sourceRef = sourceRef || String(n.recordRef || `notification:${n.id}`);
      if (sourceBusinessId == null && n.businessId != null) sourceBusinessId = Number(n.businessId);
      if (!sourceBranch && n.branchCode) sourceBranch = String(n.branchCode);
      if (sourceBusinessId != null && !(await canAccessBusiness(user, sourceBusinessId))) sourceBusinessId = null;
    }

    const task = await createTask({
      title: title || sourceTitle || "Follow-up",
      detail: body.detail
        ? String(body.detail)
        : sourceType === "NOTIFICATION" || sourceType === "PLATFORM_REQUEST"
          ? sourceDetail
          : null,
      businessId: sourceBusinessId,
      branchCode: sourceBranch,
      assignedUserId,
      assignedUserName: assignee.name,
      createdByUserId: Number(user.id),
      createdByName: user.name,
      priority: body.priority || null,
      dueDate,
      sourceType,
      sourceId,
      sourceRef,
      sourceLabel: body.sourceLabel ? String(body.sourceLabel) : sourceType === "NOTIFICATION" ? "Notification follow-up" : null,
    });
    return NextResponse.json({ success: true, task });
  } catch (e: any) {
    console.error("[api/tasks POST]", e);
    const msg = String(e?.message || e) || "Could not create the task.";
    return NextResponse.json({ success: false, error: msg.includes("dueDate") ? msg : "Could not create the task." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) return NextResponse.json({ success: false, error: "Task id required." }, { status: 400 });
    const [task] = await db.select().from(actionTasks).where(eq(actionTasks.id, id)).limit(1);
    if (!task) return NextResponse.json({ success: false, error: "Task not found." }, { status: 404 });

    const isAssignee = Number(task.assignedUserId) === Number(user.id);
    const isCreator = Number(task.createdByUserId) === Number(user.id);
    const isManager = isExec(user) || (task.businessId != null && businessManageIdsOf(user).includes(Number(task.businessId)));
    if (!isAssignee && !isCreator && !isManager && !user.isSuperAdmin) {
      return FORBIDDEN("Only the assignee, the creator or a manager of that business can update this task.");
    }

    const nextStatus = body.status != null ? normTaskStatus(body.status) : null;
    if (nextStatus && !["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"].includes(nextStatus)) {
      return NextResponse.json({ success: false, error: "Unknown status." }, { status: 400 });
    }
    // Only the assignee (or a manager) may progress/complete the work.
    if (nextStatus && nextStatus !== task.status && !isAssignee && !isManager && !user.isSuperAdmin) {
      return FORBIDDEN("Only the assignee or a manager can change the status.");
    }
    const updates: any = { updatedAt: new Date() };
    if (isManager || isCreator || isAssignee) {
      if (body.title != null && String(body.title).trim()) updates.title = String(body.title).trim().slice(0, 200);
      if (body.detail != null) updates.detail = String(body.detail).slice(0, 2000);
      if (body.priority != null) updates.priority = normTaskPriority(body.priority);
      if (body.dueDate !== undefined) {
        const d = body.dueDate ? String(body.dueDate) : null;
        if (d && !isValidISODate(d)) return NextResponse.json({ success: false, error: "Due date must be YYYY-MM-DD." }, { status: 400 });
        updates.dueDate = d;
      }
    }
    if (nextStatus) {
      updates.status = nextStatus;
      if (nextStatus === "DONE" || nextStatus === "CANCELLED") {
        updates.completedAt = new Date();
        updates.completedByName = user.name;
        updates.completionNote = body.completionNote ? String(body.completionNote).slice(0, 500) : task.completionNote;
      } else {
        updates.completedAt = null;
        updates.completedByName = null;
        updates.completionNote = null;
      }
    } else if (body.completionNote != null && isAssignee) {
      updates.completionNote = String(body.completionNote).slice(0, 500);
    }
    const [updated] = await db.update(actionTasks).set(updates).where(eq(actionTasks.id, id)).returning();

    // Tell the creator when someone else completes their task.
    if (
      nextStatus === "DONE" &&
      task.createdByUserId != null &&
      Number(task.createdByUserId) !== Number(user.id) &&
      String(task.status) !== "DONE"
    ) {
      const [dupe] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(task.createdByUserId)),
            eq(notifications.type, "TASK_COMPLETED"),
            eq(notifications.recordRef, `${task.taskNumber}:done`),
          ),
        )
        .limit(1);
      if (!dupe) {
        await db.insert(notifications).values({
          userId: Number(task.createdByUserId),
          type: "TASK_COMPLETED",
          title: `Action done: ${task.title}`,
          body: `${user.name} completed ${task.taskNumber}${body.completionNote ? ` — ${String(body.completionNote).slice(0, 200)}` : ""}.`,
          recordType: "ACTION_TASK",
          recordRef: `${task.taskNumber}:done`,
          businessId: task.businessId,
          branchCode: task.branchCode,
          actorName: user.name,
          priority: task.priority,
          ownerId: task.ownerId,
        });
        pushAfterBell([Number(task.createdByUserId)], {
          type: "TASK_COMPLETED",
          title: `Action done: ${task.title}`,
          body: `${user.name} completed ${task.taskNumber}.`,
          url: "/?tab=ACTION_CENTER",
        });
      }
    }
    return NextResponse.json({ success: true, task: updated });
  } catch (e) {
    console.error("[api/tasks PATCH]", e);
    return NextResponse.json({ success: false, error: "Could not update the task." }, { status: 500 });
  }
}
