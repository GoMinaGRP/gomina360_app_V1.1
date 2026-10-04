import { NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { transactions, businesses, recordDeletionLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import {
  canManageSharedRecords,
  canManageExpenses,
  canManageBusinessUnit,
} from "@/lib/recordPermissions";
import { getSessionInfo, canAccessBusiness, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { nextTrxNumber } from "@/lib/idNumbers";
import { approvalGateCheck, createApprovalRequest } from "@/lib/approvals";
import { validateImageArray, validateOptionalImage } from "@/lib/mediaValidation";

export async function GET(request: Request) {
  try {
    // Session-scoped: users only ever receive transactions of businesses
    // they are assigned / granted access to.
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();

    const { searchParams } = new URL(request.url);
    const businessIdParam = searchParams.get("businessId");

    if (businessIdParam && businessIdParam !== "ALL") {
      const bId = parseInt(businessIdParam, 10);
      if (!isNaN(bId)) {
        if (!(await canAccessBusiness(session.user, bId))) {
          return FORBIDDEN("You do not have access to that business.");
        }
        const results = await db
          .select()
          .from(transactions)
          .where(eq(transactions.businessId, bId))
          .orderBy(desc(transactions.id));
        return NextResponse.json({ success: true, transactions: results });
      }
    }

    const allTrx = await db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.id));
    if (session.user.isSuperAdmin) {
      return NextResponse.json({ success: true, transactions: allTrx });
    }
    const { accessibleBusinessIds } = await import("@/lib/auth");
    const allowed = await accessibleBusinessIds(session.user);
    const scoped =
      allowed === null ? allTrx : allTrx.filter((t) => allowed.includes(t.businessId));
    return NextResponse.json({ success: true, transactions: scoped });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      businessId,
      type,
      category,
      amountGhs,
      paymentMethod,
      description,
      date,
      recordedBy,
      recordedByRole,
      recordedByUserId,
      customerId,
      supplierId,
      status,
      branchCode,
      branchName,
    } = body;

    // Session identity is authoritative for attribution, and the user must
    // have access to the business the record belongs to.
    const session = await getSessionInfo(request);
  ttlInvalidate("init");
    if (!session) return UNAUTHENTICATED();
    if (!(await canAccessBusiness(session.user, businessId))) {
      return FORBIDDEN("You do not have access to record against that business.");
    }
    // Worker expense-permission parity (same rule the feed-mill intake routes
    // enforce): a WORKER whose OWNER left "can record expenses" OFF cannot
    // book EXPENSE rows — the module UIs hide the button, the API must agree.
    // OWNER / GENERAL_MANAGER / BRANCH_MANAGER are never restricted here.
    if (
      String(type).toUpperCase() === "EXPENSE" &&
      session.user.role === "WORKER" &&
      !session.user.canRecordExpenses
    ) {
      return FORBIDDEN(
        "You do not have permission to record expenses. Ask the OWNER to enable 'can record expenses' for your account."
      );
    }

    // Receipt photos: shared validation (shape + stored-byte budget + cap).
    // The client already optimises to ≤700 KB / 3 photos; this stops anything
    // else from writing an unbounded blob into the ledger.
    const receiptOne = validateOptionalImage(body?.receiptImage, "receipt", { label: "Receipt photo" });
    if (!receiptOne.ok) return NextResponse.json({ success: false, error: receiptOne.error }, { status: 400 });
    const receiptMany = validateImageArray(body?.receiptImages, "receipt", { label: "Receipt photos" });
    if (!receiptMany.ok) return NextResponse.json({ success: false, error: receiptMany.error }, { status: 400 });

    // Route all EXPENSE transactions through centralized postOrGateExpenseTransaction
    if (String(type).toUpperCase() === "EXPENSE") {
      const { postOrGateExpenseTransaction } = await import("@/lib/expensePosting");
      const result = await postOrGateExpenseTransaction({
        businessId: Number(businessId),
        branchCode,
        branchName,
        category,
        amountGhs: Number(amountGhs) || 0,
        paymentMethod,
        customerId: customerId ? Number(customerId) : undefined,
        supplierId: supplierId ? Number(supplierId) : undefined,
        description,
        date,
        receiptImage: body?.receiptImage || null,
        receiptImages: body?.receiptImages || null,
        expenseMode: body?.expenseMode || (body?.isPreApproval ? "REQUEST" : "RECORD"),
        isPreApproval: body?.isPreApproval || body?.expenseMode === "REQUEST",
        actor: session.user,
      });
      return NextResponse.json(result);
    }

    const now = new Date();
    const trxNum = nextTrxNumber(now);
    const dateStr = now.toISOString().split("T")[0];

    // Auto-resolve branch details from business if not provided
    let resolvedBranchCode = branchCode || null;
    let resolvedBranchName = branchName || null;
    if (!resolvedBranchCode && businessId) {
      const [biz] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, Number(businessId)));
      if (biz) {
        resolvedBranchCode = biz.code;
        resolvedBranchName = biz.name;
      }
    }

    const [newTrx] = await db
      .insert(transactions)
      .values({
        transactionNumber: trxNum,
        businessId: Number(businessId),
        branchCode: resolvedBranchCode,
        branchName: resolvedBranchName,
        type: type || "INCOME",
        category: category || "General Sales",
        amountGhs: Number(amountGhs) || 0,
        paymentMethod: paymentMethod || "MTN_MOMO",
        customerId: customerId ? Number(customerId) : null,
        supplierId: supplierId ? Number(supplierId) : null,
        description: description || "Transaction logged in GoMina 360",
        date: dateStr,
        createdAt: now,
        status: status || "COMPLETED",
        recordedBy: session.user.name || recordedBy || "Command Center User",
        recordedByRole: session.user.role || recordedByRole || null,
        recordedByUserId: session.user.id,
        receiptImage: body?.receiptImage || null,
        receiptImages: body?.receiptImages || null,
      })
      .returning();

    ttlInvalidate("init");
    return NextResponse.json({ success: true, transaction: newTrx });
  } catch (error: any) {
    console.error("POST /api/transactions error:", error);
    return apiError(error);
  }
}

/**
 * PATCH /api/transactions — edit a transaction (type, category, amount,
 * payment method, description). OWNER always allowed; other users only with
 * the OWNER-granted canManageRecords flag (resolved server-side from the DB).
 * Expense records (type === "EXPENSE") are additionally gated by the
 * OWNER-granted canManageExpenses flag.
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { id, data, actorUserId } = body || {};
    const recordId = Number(id);
    if (!Number.isFinite(recordId)) {
      return NextResponse.json(
        { success: false, error: "Valid transaction id is required." },
        { status: 400 }
      );
    }

    const editSession = await getSessionInfo(request);
    if (!editSession) return UNAUTHENTICATED();
    const actor = editSession.user;

    const [existing] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Transaction not found." },
        { status: 404 }
      );
    }
    // Tenant boundary: permission flags never act across organizations.
    if (!actor.isSuperAdmin && !(await canAccessBusiness(actor, existing.businessId))) {
      return FORBIDDEN("That transaction belongs to a business you cannot access.");
    }

    const d = data || body || {};
    const updates: Record<string, any> = {};

    // Special lifecycle action: Mark as Spent / Post Receipt for an APPROVED expense request
    if ((d.op === "MARK_SPENT" || d.status === "COMPLETED") && existing.status === "APPROVED") {
      const isRequester = Number(existing.recordedByUserId) === Number(actor.id);
      const isManagerOrOwner = canManageExpenses(actor) || canManageBusinessUnit(actor, existing.businessId) || actor.isSuperAdmin;
      if (!isRequester && !isManagerOrOwner) {
        return FORBIDDEN("Only the requester (or an authorized manager) can post receipts for this approved expense.");
      }
      updates.status = "COMPLETED";
      if (typeof d.paymentMethod === "string" && d.paymentMethod.trim()) updates.paymentMethod = d.paymentMethod.trim();
      if (typeof d.date === "string" && d.date.trim()) updates.date = d.date.trim();
      if (d.receiptImage) updates.receiptImage = d.receiptImage;
      if (Array.isArray(d.receiptImages)) updates.receiptImages = d.receiptImages;
      if (typeof d.description === "string" && d.description.trim()) updates.description = d.description.trim();

      const [updated] = await db
        .update(transactions)
        .set(updates)
        .where(eq(transactions.id, recordId))
        .returning();

      const { auditLog } = await import("@/lib/audit");
      const { ownerOrgOfBusiness } = await import("@/lib/notify");
      const ownerOrg = await ownerOrgOfBusiness(Number(existing.businessId)).catch(() => null);
      await auditLog(
        actor,
        "EXPENSE_POSTED",
        "transactions",
        `${updated.category} — GH₵ ${Number(updated.amountGhs).toFixed(2)}`,
        "transactions",
        Number(updated.id),
        Number(existing.businessId),
        existing.branchCode,
        `Approved expense disbursed & posted to Finance (${updated.paymentMethod || "CASH"})`,
        ownerOrg ?? null
      );

      ttlInvalidate("init");
      return NextResponse.json({ success: true, transaction: updated, message: "Expense posted to Finance." });
    }

    if (typeof d.type === "string" && ["INCOME", "EXPENSE", "INVESTMENT", "TRANSFER"].includes(d.type))
      updates.type = d.type;
    if (typeof d.category === "string" && d.category.trim()) updates.category = d.category.trim();
    if (typeof d.description === "string" && d.description.trim()) updates.description = d.description.trim();
    if (typeof d.paymentMethod === "string" && d.paymentMethod.trim()) updates.paymentMethod = d.paymentMethod.trim();
    if (typeof d.date === "string" && d.date.trim()) updates.date = d.date.trim();
    if (d.receiptImage !== undefined) updates.receiptImage = d.receiptImage;
    if (d.receiptImages !== undefined) updates.receiptImages = d.receiptImages;
    if (d.amountGhs !== undefined) {
      const v = Number(d.amountGhs);
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json(
          { success: false, error: "Amount must be a positive number." },
          { status: 400 }
        );
      }
      updates.amountGhs = v;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update." },
        { status: 400 }
      );
    }

    // Expenses get their own gate: manage/delete-expenses is a separate
    // OWNER-granted permission. Other transaction types fall back to the
    // shared-record permission. A user the OWNER granted "Manage Business /
    // Unit" power for THIS unit may always edit — owner-equivalent, scoped
    // to that unit only.
    const targetIsExpense =
      (updates.type !== undefined ? updates.type : existing.type) === "EXPENSE";
    const unitManager = canManageBusinessUnit(actor, existing.businessId);
    const permitted = targetIsExpense
      ? canManageExpenses(actor) || unitManager
      : canManageSharedRecords(actor) || unitManager;
    if (!permitted) {
      return NextResponse.json(
        {
          success: false,
          error: targetIsExpense
            ? "Not permitted — only the OWNER (or a manager the OWNER has granted expense-management permission) can edit expenses."
            : "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can edit transactions.",
        },
        { status: 403 }
      );
    }

    const [updated] = await db
      .update(transactions)
      .set(updates)
      .where(eq(transactions.id, recordId))
      .returning();
    return NextResponse.json({ success: true, transaction: updated });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * DELETE /api/transactions — permanently delete a transaction. Permission-
 * gated like PATCH (expenses via the OWNER-granted expense-management flag,
 * other types via the shared-record flag) and ALWAYS writes an immutable audit
 * row (record snapshot, user, date+time, mandatory reason) before the delete.
 */
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { id, reason, actorUserId } = body || {};
    const recordId = Number(id);
    if (!Number.isFinite(recordId)) {
      return NextResponse.json(
        { success: false, error: "Valid transaction id is required." },
        { status: 400 }
      );
    }
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 3) {
      return NextResponse.json(
        { success: false, error: "A deletion reason is required and is recorded permanently." },
        { status: 400 }
      );
    }

    const delSession = await getSessionInfo(request);
    if (!delSession) return UNAUTHENTICATED();
    const actor = delSession.user;

    const [existing] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Transaction not found." },
        { status: 404 }
      );
    }

    // Expenses get their own gate: manage/delete-expenses is a separate
    // OWNER-granted permission. Other transaction types fall back to the
    // shared-record permission. A user the OWNER granted "Manage Business /
    // Unit" power for THIS unit may always delete — owner-equivalent, scoped
    // to that unit only.
    const isExpense = existing.type === "EXPENSE";
    const unitManager = canManageBusinessUnit(actor, existing.businessId);
    const permitted = isExpense
      ? canManageExpenses(actor) || unitManager
      : canManageSharedRecords(actor) || unitManager;
    if (!permitted) {
      return NextResponse.json(
        {
          success: false,
          error: isExpense
            ? "Not permitted — only the OWNER (or a manager the OWNER has granted expense-management permission) can delete expenses."
            : "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can delete transactions.",
        },
        { status: 403 }
      );
    }
    // Tenant boundary: permission flags never act across organizations.
    if (!actor.isSuperAdmin && !(await canAccessBusiness(actor, existing.businessId))) {
      return FORBIDDEN("That transaction belongs to a business you cannot access.");
    }

    const [bizRow] = await db.select({ ownerId: businesses.ownerId }).from(businesses).where(eq(businesses.id, existing.businessId));
    const [log] = await db
      .insert(recordDeletionLogs)
      .values({
        module: "TRANSACTIONS",
        recordId: existing.id,
        recordLabel: `${existing.transactionNumber} — GH₵ ${existing.amountGhs} (${existing.category})`,
        recordSnapshot: existing,
        reason: cleanReason,
        deletedByUserId: actor?.id ?? null,
        deletedByName: actor?.name || "Unknown",
        deletedByRole: actor?.role || "UNKNOWN",
        ownerId: bizRow?.ownerId ?? null,
      })
      .returning();

    await db.delete(transactions).where(eq(transactions.id, recordId));

    return NextResponse.json({
      success: true,
      deleted: { id: existing.id, transactionNumber: existing.transactionNumber },
      auditLogId: log.id,
    });
  } catch (error: any) {
    return apiError(error);
  }
}
