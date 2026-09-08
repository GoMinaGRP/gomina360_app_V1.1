import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions, businesses, recordDeletionLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import {
  canManageSharedRecords,
} from "@/lib/recordPermissions";
import { getSessionInfo, canAccessBusiness, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";

export async function GET(request: Request) {
  try {
    // Session-scoped: users only ever receive transactions of businesses
    // they are assigned / granted access to.
    const session = await getSessionInfo(request);
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
    if (session.user.role === "OWNER") {
      return NextResponse.json({ success: true, transactions: allTrx });
    }
    const { accessibleBusinessIds } = await import("@/lib/auth");
    const allowed = await accessibleBusinessIds(session.user);
    const scoped =
      allowed === null ? allTrx : allTrx.filter((t) => allowed.includes(t.businessId));
    return NextResponse.json({ success: true, transactions: scoped });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
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
    if (!session) return UNAUTHENTICATED();
    if (!(await canAccessBusiness(session.user, businessId))) {
      return FORBIDDEN("You do not have access to record against that business.");
    }

    const now = new Date();
    const trxNum = `TRX-${now.getFullYear()}-${now.getTime().toString().slice(-6)}`;
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

    return NextResponse.json({ success: true, transaction: newTrx });
  } catch (error: any) {
    console.error("POST /api/transactions error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/transactions — edit a transaction (type, category, amount,
 * payment method, description). OWNER always allowed; other users only with
 * the OWNER-granted canManageRecords flag (resolved server-side from the DB).
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
    if (!canManageSharedRecords(actor)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can edit transactions.",
        },
        { status: 403 }
      );
    }

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

    const d = data || {};
    const updates: Record<string, any> = {};
    if (typeof d.type === "string" && ["INCOME", "EXPENSE", "INVESTMENT", "TRANSFER"].includes(d.type))
      updates.type = d.type;
    if (typeof d.category === "string" && d.category.trim()) updates.category = d.category.trim();
    if (typeof d.description === "string" && d.description.trim()) updates.description = d.description.trim();
    if (typeof d.paymentMethod === "string" && d.paymentMethod.trim()) updates.paymentMethod = d.paymentMethod.trim();
    if (typeof d.date === "string" && d.date.trim()) updates.date = d.date.trim();
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

    const [updated] = await db
      .update(transactions)
      .set(updates)
      .where(eq(transactions.id, recordId))
      .returning();
    return NextResponse.json({ success: true, transaction: updated });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/transactions — permanently delete a transaction. Permission-
 * gated like PATCH and ALWAYS writes an immutable audit row (record snapshot,
 * user, date+time, mandatory reason) before the delete lands.
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
    if (!canManageSharedRecords(actor)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can delete transactions.",
        },
        { status: 403 }
      );
    }

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
      })
      .returning();

    await db.delete(transactions).where(eq(transactions.id, recordId));

    return NextResponse.json({
      success: true,
      deleted: { id: existing.id, transactionNumber: existing.transactionNumber },
      auditLogId: log.id,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
