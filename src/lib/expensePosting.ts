import { db } from "@/db";
import { businesses, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { nextTrxNumber } from "@/lib/idNumbers";
import { approvalGateCheck, createApprovalRequest } from "@/lib/approvals";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { auditLog } from "@/lib/audit";
import { ttlInvalidate } from "@/lib/ttlCache";

export interface PostExpenseActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
  organizationIds?: number[];
  canRecordExpenses?: boolean;
}

export interface PostExpenseOptions {
  businessId: number;
  branchCode?: string | null;
  branchName?: string | null;
  category: string;
  amountGhs: number;
  paymentMethod?: string | null;
  description?: string | null;
  date?: string | null;
  customerId?: number | null;
  supplierId?: number | null;
  receiptImages?: string[] | null;
  receiptImage?: string | null;
  actor: PostExpenseActor;
  targetLabel?: string | null;
  metadata?: Record<string, unknown>;
  /** "RECORD" = already incurred; "REQUEST" = pre-approval for future expense */
  expenseMode?: "RECORD" | "REQUEST";
  isPreApproval?: boolean;
  /** If true, bypasses the WORKER canRecordExpenses check (e.g. system automated postings) */
  skipWorkerPermissionCheck?: boolean;
}

export interface PostExpenseResult {
  success: boolean;
  transaction?: any;
  pendingApproval?: boolean;
  message?: string;
  error?: string;
  approvalRequest?: any;
}


/** Money activity → the unit's money watchers, rolled up per business/day. */
async function notifyExpenseActivity(opts: {
  businessId: number;
  branchCode?: string | null;
  amountGhs: number;
  category?: string | null;
  actorName?: string | null;
  actorUserId?: number | null;
  recordRef?: string | null;
  recordId?: number | null;
}): Promise<void> {
  try {
    const { notifyMoneyActivity } = await import("@/lib/notifyActivity");
    await notifyMoneyActivity({
      businessId: opts.businessId,
      branchCode: opts.branchCode ?? null,
      kind: "EXPENSE",
      amountGhs: opts.amountGhs,
      actorName: opts.actorName ?? null,
      actorUserId: opts.actorUserId ?? null,
      recordRef: opts.recordRef ?? null,
      recordId: opts.recordId ?? null,
      recordType: "transactions",
      label: opts.category || "General",
    });
  } catch (e) {
    console.error("[expense-posting] activity notification failed:", e);
  }
}

/**
 * Centralized, secure Expense creation helper for GoMina 360.
 *
 * Enforces:
 *  1. Worker permissions: a WORKER whose OWNER/Manager left `canRecordExpenses`
 *     OFF cannot create or request expenses.
 *  2. Approval Gate: if an active policy matches (and caller cannot decide it),
 *     the transaction is saved as `PENDING_APPROVAL`, an `approval_requests`
 *     entry is created, approvers receive bell+push alerts, and an audit trail
 *     record is appended.
 *  3. Otherwise: the transaction is saved with status `COMPLETED`.
 *  4. In-process cache invalidation (`init` cache).
 */
export async function postOrGateExpenseTransaction(
  opts: PostExpenseOptions
): Promise<PostExpenseResult> {
  const amount = Number(opts.amountGhs);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "A positive expense amount is required." };
  }

  const bId = Number(opts.businessId);
  if (!Number.isFinite(bId) || bId <= 0) {
    return { success: false, error: "A valid businessId is required." };
  }

  const actor = opts.actor || {};
  const role = String(actor.role || "").toUpperCase();

  // 1. Worker permission check
  if (
    !opts.skipWorkerPermissionCheck &&
    role === "WORKER" &&
    !actor.canRecordExpenses &&
    !actor.isSuperAdmin
  ) {
    return {
      success: false,
      error:
        "You do not have permission to record expenses. Ask the OWNER to enable 'can record expenses' for your account.",
    };
  }

  // 2. Resolve branch metadata if not provided
  let resolvedBranchCode = opts.branchCode || null;
  let resolvedBranchName = opts.branchName || null;
  if (!resolvedBranchCode || !resolvedBranchName) {
    const [biz] = await db
      .select({ code: businesses.code, name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, bId));
    if (biz) {
      if (!resolvedBranchCode) resolvedBranchCode = biz.code;
      if (!resolvedBranchName) resolvedBranchName = biz.name;
    }
  }

  // 3. Approval gate check
  const isRequestMode = opts.expenseMode === "REQUEST";
  let isGated = isRequestMode;
  try {
    const gateCheck = await approvalGateCheck({
      user: {
        id: Number(actor.id) || 0,
        name: actor.name || null,
        role: actor.role || null,
        isSuperAdmin: !!actor.isSuperAdmin,
        organizationIds: actor.organizationIds || [],
      },
      action: "EXPENSE",
      businessId: bId,
      amountGhs: amount,
    });
    // In REQUEST mode, always gate (even if below threshold), unless caller is the sole approver
    if (isRequestMode) {
      isGated = true;
    } else {
      isGated = gateCheck.gated;
    }
  } catch (err) {
    console.error("[postOrGateExpenseTransaction] approvalGateCheck error:", err);
  }

  const now = new Date();
  const trxNum = nextTrxNumber(now);
  const dateStr = opts.date || now.toISOString().split("T")[0];

  // 4. Insert transaction
  const [newTrx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId: bId,
      branchCode: resolvedBranchCode,
      branchName: resolvedBranchName,
      type: "EXPENSE",
      category: opts.category || "General Expense",
      amountGhs: amount,
      paymentMethod: opts.paymentMethod || "CASH",
      customerId: opts.customerId ? Number(opts.customerId) : null,
      supplierId: opts.supplierId ? Number(opts.supplierId) : null,
      description: opts.description || (isRequestMode ? "Expense request submitted for pre-approval" : "Expense logged in GoMina 360"),
      date: dateStr,
      createdAt: now,
      status: isGated ? "PENDING_APPROVAL" : "COMPLETED",
      recordedBy: actor.name || "Staff",
      recordedByRole: actor.role || null,
      recordedByUserId: actor.id ? Number(actor.id) : null,
      receiptImage: opts.receiptImage || null,
      receiptImages: opts.receiptImages || null,
    })
    .returning();

  ttlInvalidate("init");

  // 5. If gated, raise approval request and notify approvers
  if (isGated) {
    const targetLabel =
      opts.targetLabel ||
      `${isRequestMode ? "Expense Request" : "Expense"} (${opts.category || "General"}) — GH₵ ${amount.toFixed(2)}`;
    const approvalReq = await createApprovalRequest({
      action: "EXPENSE",
      businessId: bId,
      branchCode: resolvedBranchCode,
      targetType: "TRANSACTION",
      targetId: Number(newTrx.id),
      targetLabel,
      amountGhs: amount,
      payloadSnapshot: {
        transactionNumber: trxNum,
        category: opts.category,
        description: opts.description,
        expenseMode: isRequestMode ? "REQUEST" : "RECORD",
        isPreApproval: isRequestMode,
        ...(opts.metadata || {}),
      },
      actor: {
        id: Number(actor.id) || 0,
        name: actor.name || "Staff",
        role: actor.role || "WORKER",
        isSuperAdmin: !!actor.isSuperAdmin,
        organizationIds: actor.organizationIds || [],
      },
    });

    // Write audit trail entry for request
    const ownerOrg = await ownerOrgOfBusiness(bId).catch(() => null);
    await auditLog(
      { id: actor.id ?? undefined, name: actor.name ?? undefined, role: actor.role ?? undefined },
      isRequestMode ? "EXPENSE_PREAPPROVAL_REQUEST" : "EXPENSE_REQUEST",
      "transactions",
      targetLabel,
      "transactions",
      Number(newTrx.id),
      bId,
      resolvedBranchCode,
      isRequestMode
        ? `Pre-approval requested for upcoming expense: ${opts.description || opts.category} (Trx ${trxNum})`
        : `Incurred expense submitted for approval: ${opts.description || opts.category} (Trx ${trxNum})`,
      ownerOrg ?? null
    );

    return {
      success: true,
      transaction: newTrx,
      pendingApproval: true,
      approvalRequest: approvalReq,
      message: isRequestMode
        ? "Expense request submitted for pre-approval — the approvers have been notified."
        : "Expense saved as PENDING APPROVAL — the approvers have been notified.",
    };
  }

  // Money activity — an expense that needs no approval still concerns the
  // OWNER, so the unit's money watchers get the rolled-up line.
  await notifyExpenseActivity({
    businessId: bId,
    branchCode: resolvedBranchCode,
    amountGhs: amount,
    category: opts.category,
    actorName: actor.name,
    actorUserId: actor.id ? Number(actor.id) : null,
    recordRef: trxNum,
    recordId: Number(newTrx.id) || null,
  });

  return {
    success: true,
    transaction: newTrx,
    pendingApproval: false,
  };
}
