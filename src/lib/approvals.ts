/**
 * R1 — Approvals framework (CAPABILITY-AUDIT-REPORT §4).
 *
 * A single generic request→decide lifecycle, policy-driven and OFF by
 * default: with zero `approval_policies` rows the app behaves exactly as it
 * did before (no gate ever fires — existing data, permissions, tenant
 * isolation and verification suites are untouched).
 *
 * How a gate works, end to end:
 *  1. A route calls `approvalGateCheck` with the caller, the action key and
 *     the relevant numbers. No active matching policy ⇒ `{ gated: false }`
 *     and the route proceeds unchanged.
 *  2. If a policy matches AND the caller could themselves decide it
 *     (e.g. the OWNER raising their own expense), the gate also returns
 *     `gated: false` — approvers are never blocked by their own policy.
 *  3. Otherwise the route saves the record in a PENDING_* state, calls
 *     `createApprovalRequest` (bell + push to the approvers) and tells the
 *     caller the record awaits approval.
 *  4. An approver decides via POST /api/approvals (DECIDE) →
 *     `decideApprovalRequest` applies the action's effect (status flip,
 *     inventory apply, deferred delete …), writes the audit trail, and
 *     bell+push notifies the requester.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  approvalPolicies,
  approvalRequests,
  businesses,
  customers,
  inventoryItems,
  organizationMembers,
  purchaseRequisitions,
  salesDocuments,
  supplierOrders,
  transactions,
  businessDocuments,
  users,
} from "@/db/schema";
import { auditLog } from "@/lib/audit";
import { computeStockStatus } from "@/lib/stock";
import { notifyApprovalDecision, notifyApprovalRequest, ownerOrgOfBusiness } from "@/lib/notify";

export { APPROVAL_ACTIONS, type ApprovalAction } from "@/db/schema";

const APPROVAL_ACTIONS_SET = new Set<string>([
  "EXPENSE",
  "PURCHASE_ORDER",
  "PURCHASE_REQUISITION",
  "INVENTORY_ADJUSTMENT",
  "DISCOUNT",
  "DELETION",
  "DATA_EXPORT",
]);

export const APPROVAL_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export interface GateUser {
  id: number;
  name?: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
  organizationIds?: number[];
}

export interface ApprovalPolicy {
  id: number;
  ownerId: number;
  action: string;
  scopeBusinessId: number | null;
  thresholdAmountGhs: number | null;
  thresholdPercent: number | null;
  approverRole: string;
  approverUserId: number | null;
  isActive: boolean;
}

function normAction(action: string): string {
  return String(action || "").toUpperCase();
}

/**
 * The single active policy a submission falls under, or null.
 * Most-specific wins: business-scoped before organization-wide. Within the
 * same scope the lowest matching threshold wins (tightest control).
 */
export async function findMatchingPolicy(opts: {
  ownerId: number;
  action: string;
  businessId?: number | null;
  amountGhs?: number | null;
  percent?: number | null;
}): Promise<ApprovalPolicy | null> {
  const action = normAction(opts.action);
  if (!APPROVAL_ACTIONS_SET.has(action)) return null;
  const rows = (await db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.ownerId, Number(opts.ownerId)),
        eq(approvalPolicies.action, action),
        eq(approvalPolicies.isActive, true),
      ),
    )) as ApprovalPolicy[];
  const bizId = opts.businessId != null ? Number(opts.businessId) : null;
  const amount = opts.amountGhs != null ? Number(opts.amountGhs) : null;
  const percent = opts.percent != null ? Number(opts.percent) : null;
  const matches = rows.filter((p) => {
    if (p.scopeBusinessId != null && bizId != null && Number(p.scopeBusinessId) !== bizId) return false;
    if (action === "DISCOUNT") {
      if (p.thresholdPercent == null) return true; // gate every discount
      if (percent == null || !(Number(percent) >= Number(p.thresholdPercent))) return false;
    } else if (p.thresholdAmountGhs != null) {
      if (amount == null || !(Number(amount) >= Number(p.thresholdAmountGhs))) return false;
    }
    return true;
  });
  if (!matches.length) return null;
  // Business-scoped policies outrank org-wide ones; within the same scope the
  // highest matching threshold governs (delegation cascade).
  matches.sort((a, b) => {
    const aScoped = a.scopeBusinessId != null ? 0 : 1;
    const bScoped = b.scopeBusinessId != null ? 0 : 1;
    if (aScoped !== bScoped) return aScoped - bScoped;
    const threshOf = (p: ApprovalPolicy) =>
      action === "DISCOUNT"
        ? p.thresholdPercent != null ? Number(p.thresholdPercent) : -1
        : p.thresholdAmountGhs != null ? Number(p.thresholdAmountGhs) : -1;
    return threshOf(b) - threshOf(a);
  });
  return matches[0];
}

/** May this user decide requests under `policy`? (Approver-role member, the
 *  named delegate, the org's OWNER, or a super admin.) */
export async function canUserDecide(user: GateUser, policy: ApprovalPolicy): Promise<boolean> {
  if (!user || !Number(user.id)) return false;
  if (user.isSuperAdmin) return true;
  const role = String(user.role || "").toUpperCase();
  const myOrgs = new Set((user.organizationIds || []).map(Number));
  if (myOrgs.has(Number(policy.ownerId)) && role === "OWNER") return true;
  if (policy.approverUserId != null && Number(policy.approverUserId) === Number(user.id)) return true;
  if (policy.approverRole && role === String(policy.approverRole).toUpperCase()) {
    // Must still belong to the policy's organization.
    if (myOrgs.has(Number(policy.ownerId))) return true;
  }
  return false;
}

/** All users entitled to decide requests under `policy` for `businessId`. */
export async function resolveApprovers(policy: ApprovalPolicy, businessId?: number | null) {
  const orgId = Number(policy.ownerId);
  const memberRows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, orgId));
  const memberIds = new Set(memberRows.map((m) => Number(m.userId)));
  if (!memberIds.size) return [];
  const staff = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      assignedBusinessId: users.assignedBusinessId,
    })
    .from(users)
    .where(inArray(users.id, Array.from(memberIds)));
  const bizId = businessId != null ? Number(businessId) : null;
  return staff.filter((u: any) => {
    if (u.isActive === false) return false;
    const role = String(u.role || "").toUpperCase();
    if (role === "OWNER") return true; // org owners can always decide
    if (policy.approverUserId != null && Number(policy.approverUserId) === Number(u.id)) return true;
    if (!policy.approverRole || role !== String(policy.approverRole).toUpperCase()) return false;
    // Role match: for business-scoped policies keep it to staff tied to that
    // unit (assigned or granted) so cross-branch GMs aren't pulled in blindly.
    if (bizId != null && policy.scopeBusinessId != null) {
      return Number(u.assignedBusinessId) === bizId;
    }
    return true;
  });
}

export interface GateResult {
  gated: false;
  reason?: string;
}
export interface GateBlocked {
  gated: true;
  /** The policy that fired (callers may surface its threshold in the UI). */
  policy: ApprovalPolicy;
}
export type ApprovalGateResult = GateResult | GateBlocked;

/**
 * The one-call gate check every route uses BEFORE saving a gated record.
 * Returns `{ gated: true }` only when a policy matches AND the caller is not
 * themselves an approver under that policy. `amountGhs`/`percent` decide
 * threshold matches (null ⇒ policy must be threshold-free to fire).
 */
export async function approvalGateCheck(opts: {
  user: GateUser;
  action: string;
  businessId: number;
  amountGhs?: number | null;
  percent?: number | null;
}): Promise<ApprovalGateResult> {
  const ownerId = await ownerOrgOfBusiness(Number(opts.businessId));
  if (ownerId == null) return { gated: false, reason: "no-organization" };
  const policy = await findMatchingPolicy({
    ownerId,
    action: opts.action,
    businessId: opts.businessId,
    amountGhs: opts.amountGhs,
    percent: opts.percent,
  });
  if (!policy) return { gated: false, reason: "no-policy" };
  if (await canUserDecide(opts.user, policy)) return { gated: false, reason: "caller-is-approver" };
  return { gated: true, policy };
}

export interface CreateRequestInput {
  action: string;
  businessId: number;
  branchCode?: string | null;
  targetType: string;
  targetId: number;
  targetLabel?: string | null;
  amountGhs?: number | null;
  payloadSnapshot?: Record<string, unknown>;
  actor: GateUser & { name?: string | null; role?: string | null };
}

/** Create a PENDING request for a record already saved in its PENDING_*
 *  state, bell+push the approvers. Returns the request row. */
export async function createApprovalRequest(input: CreateRequestInput) {
  const ownerId = await ownerOrgOfBusiness(Number(input.businessId));
  const [row] = await db
    .insert(approvalRequests)
    .values({
      ownerId: ownerId ?? 0,
      businessId: Number(input.businessId),
      branchCode: input.branchCode ?? null,
      action: normAction(input.action),
      targetType: String(input.targetType || "").toUpperCase(),
      targetId: Number(input.targetId),
      targetLabel: input.targetLabel ?? null,
      amountGhs: input.amountGhs != null ? Number(input.amountGhs) : null,
      payloadSnapshot: (input.payloadSnapshot ?? {}) as any,
      status: "PENDING",
      requestedByUserId: Number(input.actor?.id) || null,
      requestedByName: input.actor?.name || "Staff",
      requestedByRole: input.actor?.role || null,
    })
    .returning();
  if (row) {
    const policy = await findMatchingPolicy({
      ownerId: ownerId ?? 0,
      action: String(row.action),
      businessId: Number(input.businessId),
      amountGhs: row.amountGhs,
    });
    const recipients = policy ? await resolveApprovers(policy, Number(input.businessId)) : [];
    await notifyApprovalRequest({
      requestId: Number(row.id),
      businessId: Number(input.businessId),
      branchCode: input.branchCode ?? null,
      action: String(row.action),
      targetLabel: input.targetLabel || String(row.targetType),
      amountGhs: row.amountGhs,
      actorName: input.actor?.name || "Staff",
      ownerId: ownerId ?? 0,
      recipients,
    });
  }
  return row;
}

/** Apply a decision's effect to the underlying record (approve, reject or
 *  withdraw): status flips, inventory applies, deferred deletes happen. */
async function applyDecisionEffect(
  request: any,
  decision: "APPROVED" | "REJECTED" | "CANCELLED",
): Promise<string> {
  const action = String(request.action || "").toUpperCase();
  const targetType = String(request.targetType || "").toUpperCase();
  const payload = (request.payloadSnapshot && typeof request.payloadSnapshot === "object"
    ? request.payloadSnapshot
    : {}) as Record<string, any>;
  const now = new Date();

  if (action === "EXPENSE" && targetType === "TRANSACTION") {
    await db
      .update(transactions)
      .set({ status: decision === "APPROVED" ? "COMPLETED" : decision === "REJECTED" ? "REJECTED" : "CANCELLED" })
      .where(eq(transactions.id, Number(request.targetId)));
    return `Expense marked ${decision === "APPROVED" ? "COMPLETED" : decision === "REJECTED" ? "REJECTED" : "CANCELLED"}`;
  }

  if (action === "PURCHASE_ORDER" && targetType === "SUPPLIER_ORDER") {
    const [po] = await db.select().from(supplierOrders).where(eq(supplierOrders.id, Number(request.targetId)));
    if (!po) return "Purchase order no longer exists";
    const history = Array.isArray(po.statusHistory) ? [...(po.statusHistory as any[])] : [];
    const finalStatus = decision === "APPROVED" ? "RAISED" : "CANCELLED";
    history.push({
      status: finalStatus,
      at: now.toISOString(),
      note: decision === "APPROVED" ? "Unlocked by approval" : decision === "REJECTED" ? "Rejected in approval" : "Withdrawn by requester",
      by: request.decidedByName,
    });
    await db
      .update(supplierOrders)
      .set({ status: finalStatus, statusHistory: history, updatedAt: now })
      .where(eq(supplierOrders.id, po.id));
    return `Purchase order set to ${finalStatus}`;
  }

  if (action === "PURCHASE_REQUISITION" && targetType === "PURCHASE_REQUISITION") {
    await db
      .update(purchaseRequisitions)
      .set({
        status: decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "CANCELLED",
        decidedByName: request.decidedByName,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(purchaseRequisitions.id, Number(request.targetId)));
    return `Requisition ${decision}`;
  }

  if (action === "INVENTORY_ADJUSTMENT" && targetType === "INVENTORY_ITEM") {
    if (decision !== "APPROVED") return "Adjustment discarded";
    const inventoryId = Number(payload.inventoryId || request.targetId);
    const newQty = Number(payload.newQuantity);
    if (!Number.isFinite(newQty)) return "Adjustment payload missing newQuantity";
    const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
    if (!item) return "Inventory item no longer exists";
    await db
      .update(inventoryItems)
      .set({
        quantity: newQty,
        status: computeStockStatus(newQty, Number(item.minStockThreshold || 0)),
      })
      .where(eq(inventoryItems.id, inventoryId));
    return `Stock quantity set to ${newQty} (was ${payload.oldQuantity ?? item.quantity})`;
  }

  if (action === "DISCOUNT" && targetType === "SALE_DOCUMENT") {
    await db
      .update(salesDocuments)
      .set({ status: decision === "APPROVED" ? "SENT" : "CANCELLED", updatedAt: now })
      .where(eq(salesDocuments.id, Number(request.targetId)));
    return decision === "APPROVED" ? "Discounted document released as SENT" : "Discounted document CANCELLED";
  }

  if (action === "DELETION") {
    if (decision !== "APPROVED") return "Record kept (deletion not carried out)";
    if (targetType === "CUSTOMER") {
      const [cust] = await db.select().from(customers).where(eq(customers.id, Number(request.targetId)));
      if (!cust) return "Customer no longer exists";
      // Same immutable deletion audit the direct route writes.
      const { recordDeletionLogs } = await import("@/db/schema");
      await db.insert(recordDeletionLogs).values({
        module: "CUSTOMERS",
        recordId: cust.id,
        recordLabel: cust.name,
        recordSnapshot: cust,
        reason: payload.reason || "Approved for deletion",
        deletedByUserId: request.decidedByUserId ?? null,
        deletedByName: request.decidedByName || "Approver",
        deletedByRole: request.decidedByRole || null,
        ownerId: cust.ownerId ?? Number(request.ownerId) ?? null,
      });
      await db.delete(customers).where(eq(customers.id, cust.id));
      return "Customer deleted after approval";
    }
    if (targetType === "BUSINESS_DOCUMENT") {
      await db.delete(businessDocuments).where(eq(businessDocuments.id, Number(request.targetId)));
      return "Document deleted after approval";
    }
    return "Deletion approved (no handler for target)";
  }

  return `${decision} (no record effect)`;
}

export interface DecideInput {
  requestId: number;
  user: GateUser & { name?: string | null; role?: string | null };
  decision: "APPROVE" | "REJECT";
  reason?: string | null;
}

/**
 * Decide a pending request: verifies the caller is an approver under the
 * policy that now matches the request's action+business, applies the effect,
 * writes the audit trail and notifies the requester. Throws Error with a
 * user-safe message on any rule violation (404/403/409 semantics).
 */
export async function decideApprovalRequest(input: DecideInput) {
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, Number(input.requestId)));
  if (!request) throw new Error("Approval request not found.");
  if (String(request.status) !== "PENDING") {
    throw new Error(`Request already ${String(request.status).toLowerCase()}.`);
  }
  // Re-resolve the gate from live policies: the policy may have been edited
  // or deactivated since the request was raised. If no active policy matches
  // anymore, only the org OWNER / super admin may still decide it.
  const policy = await findMatchingPolicy({
    ownerId: Number(request.ownerId),
    action: String(request.action),
    businessId: Number(request.businessId),
    amountGhs: request.amountGhs,
  });
  const userOrgs = new Set((input.user.organizationIds || []).map(Number));
  const isOwnerOfRequest = userOrgs.has(Number(request.ownerId)) && String(input.user.role || "").toUpperCase() === "OWNER";
  const allowed = policy ? await canUserDecide(input.user, policy) : isOwnerOfRequest || !!input.user.isSuperAdmin;
  if (!allowed) {
    throw new Error("You are not an approver for this request.");
  }

  const decision = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
  const [updated] = await db
    .update(approvalRequests)
    .set({
      status: decision,
      decidedByUserId: Number(input.user.id) || null,
      decidedByName: input.user.name || "Approver",
      decidedByRole: input.user.role || null,
      decidedAt: new Date(),
      decisionReason: input.reason || null,
      updatedAt: new Date(),
    })
    .where(and(eq(approvalRequests.id, Number(input.requestId)), eq(approvalRequests.status, "PENDING")))
    .returning();
  if (!updated) throw new Error("Request was decided concurrently.");

  const effectNote = await applyDecisionEffect({ ...updated, decidedByName: input.user.name }, decision);

  await auditLog(
    { id: input.user.id, name: input.user.name ?? undefined, role: input.user.role ?? undefined },
    decision === "APPROVED" ? "APPROVAL_APPROVE" : "APPROVAL_REJECT",
    "approval_requests",
    `${String(updated.action)} — ${updated.targetLabel || updated.targetType}#${updated.targetId}`,
    "approval_requests",
    Number(updated.id),
    Number(updated.businessId),
    updated.branchCode,
    `${effectNote}${input.reason ? ` — reason: ${input.reason}` : ""}`,
    Number(updated.ownerId),
  );

  await notifyApprovalDecision({
    requestId: Number(updated.id),
    businessId: Number(updated.businessId),
    branchCode: updated.branchCode,
    action: String(updated.action),
    targetLabel: updated.targetLabel || String(updated.targetType),
    decision,
    decidedByName: input.user.name || "Approver",
    reason: input.reason || null,
    requesterUserId: updated.requestedByUserId,
  });

  return { request: updated, effectNote };
}

/** Requester withdrew the record (or it was deleted) — close the request and
 *  release the underlying record from its PENDING_* state. */
export async function cancelApprovalRequest(requestId: number, actor: { name?: string | null; id?: number; role?: string | null }) {
  const [updated] = await db
    .update(approvalRequests)
    .set({
      status: "CANCELLED",
      decidedByName: actor?.name || "Staff",
      decidedByRole: actor?.role || null,
      decidedByUserId: Number(actor?.id) || null,
      decidedAt: new Date(),
      decisionReason: "Withdrawn by requester",
      updatedAt: new Date(),
    })
    .where(and(eq(approvalRequests.id, Number(requestId)), eq(approvalRequests.status, "PENDING")))
    .returning();
  if (updated) {
    await applyDecisionEffect(updated, "CANCELLED");
  }
  return updated ?? null;
}

/** Pending requests the user can decide right now (their approval inbox). */
export async function pendingRequestsForApprover(user: GateUser, businessIds: number[] | null) {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.status, "PENDING"))
    .orderBy(desc(approvalRequests.id))
    .limit(300);
  const scope = new Set((businessIds || []).map(Number));
  const out: typeof rows = [];
  for (const r of rows) {
    if (scope.size && !scope.has(Number(r.businessId))) continue;
    const policy = await findMatchingPolicy({
      ownerId: Number(r.ownerId),
      action: String(r.action),
      businessId: Number(r.businessId),
      amountGhs: r.amountGhs,
    });
    const userOrgs = new Set((user.organizationIds || []).map(Number));
    const isOwner = userOrgs.has(Number(r.ownerId)) && String(user.role || "").toUpperCase() === "OWNER";
    const canDecide = policy
      ? await canUserDecide(user, policy)
      : isOwner || !!user.isSuperAdmin;
    if (canDecide) out.push(r);
  }
  return out;
}

/** Organization a request belongs to (for scoping checks). */
export async function requestOrgId(businessId: number): Promise<number | null> {
  const [b] = await db.select({ ownerId: businesses.ownerId }).from(businesses).where(eq(businesses.id, Number(businessId)));
  return b?.ownerId != null ? Number(b.ownerId) : null;
}

