import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { salesDocuments, businesses } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, actorFrom, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { nextSalesDocumentNumber } from "@/lib/documentNumbers";
import { approvalGateCheck, createApprovalRequest } from "@/lib/approvals";

/**
 * GET /api/sales-documents
 * Query params: businessId, documentType, status, customerId
 * Returns list of sales documents (invoices, quotations, receipts)
 */
export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get("businessId");
    const documentType = searchParams.get("documentType");

    // Invoices / quotations / receipts are scoped to businesses the caller
    // can access. An explicit businessId must be one of them; an unfiltered
    // listing only ever returns rows from accessible businesses (OWNER ⇒ all).
    const { accessibleBusinessIds } = await import("@/lib/auth");
    const allowed = await accessibleBusinessIds(__authSession.user);
    if (businessId && !(await canAccessBusiness(__authSession.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to that business.");
    }
    const inScope = (rows: any[]) =>
      allowed === null ? rows : rows.filter((r) => allowed.includes(Number(r.businessId)));

    // Build filter conditions dynamically
    let rows;
    if (businessId && documentType) {
      rows = await db.select().from(salesDocuments)
        .where(and(
          eq(salesDocuments.businessId, Number(businessId)),
          eq(salesDocuments.documentType, documentType)
        ))
        .orderBy(desc(salesDocuments.createdAt));
    } else if (businessId) {
      rows = await db.select().from(salesDocuments)
        .where(eq(salesDocuments.businessId, Number(businessId)))
        .orderBy(desc(salesDocuments.createdAt));
    } else if (documentType) {
      rows = await db.select().from(salesDocuments)
        .where(eq(salesDocuments.documentType, documentType))
        .orderBy(desc(salesDocuments.createdAt));
    } else {
      rows = await db.select().from(salesDocuments)
        .orderBy(desc(salesDocuments.createdAt));
    }

    return NextResponse.json({ success: true, documents: inScope(rows) });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * POST /api/sales-documents
 * Body: { documentType, businessId, customerName, customerPhone, customerEmail,
 *         customerAddress, lineItems, taxRate, discount, notes, terms, validUntil,
 *         dueDate }
 *
 * F-15: `createdByUserId` / `createdByName` / `createdByRole` are NOT read
 * from the body. They were, and they let any user with business access
 * issue an invoice attributed to somebody else — and, on PATCH, REWRITE the
 * issuer of an existing document. The issuer is now always the session user.
 * The body keys are accepted and ignored, so older clients keep working.
 * Creates a new invoice or quotation with auto-generated document number
 */
export async function POST(request: NextRequest) {
  ttlInvalidate("init");
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      documentType,
      businessId,
      branchCode,
      branchName,
      customerId,
      customerName,
      customerPhone,
      customerEmail,
      customerAddress,
      lineItems,
      taxRateGhs,
      discountGhs,
      discountPercent,
      currency,
      notes,
      terms,
      validUntil,
      dueDate,
    } = body;

    if (!documentType || !businessId || !customerName || !lineItems || !Array.isArray(lineItems)) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 });
    }
    // F-15: the issuer is the session user, never the payload.
    const actor = actorFrom(__authSession);
    if (!actor) return UNAUTHENTICATED();

    if (!(await canAccessBusiness(__authSession.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // Compute totals
    const items = lineItems.map((item: any) => ({
      description: String(item.description || ""),
      quantity: Number(item.quantity) || 1,
      unitPrice: Number(item.unitPrice) || 0,
      total: Number(item.quantity || 1) * Number(item.unitPrice || 0),
    }));

    const subtotal = items.reduce((sum: number, i: any) => sum + i.total, 0);
    const taxRate = Number(taxRateGhs) || 0;
    const taxAmount = (subtotal * taxRate) / 100;
    // Percentage discount is the primary mode (auto-calculates the amount);
    // a flat GH₵ amount stays supported for backward compatibility.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    let discountPct = 0;
    let discount = 0;
    if (discountPercent !== undefined && discountPercent !== null && discountPercent !== "") {
      const pct = Number(discountPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return NextResponse.json(
          { success: false, error: "Discount percent must be between 0 and 100." },
          { status: 400 },
        );
      }
      discountPct = r2(pct);
      discount = r2((subtotal * discountPct) / 100);
    } else {
      discount = r2(Number(discountGhs) || 0);
      discountPct = subtotal > 0 ? r2((discount / subtotal) * 100) : 0;
    }
    if (discount < 0 || discount > subtotal) {
      return NextResponse.json(
        { success: false, error: "Discount cannot exceed the document subtotal." },
        { status: 400 },
      );
    }
    const total = r2(subtotal + taxAmount - discount);

    // R1 approval gate — DISCOUNT: when an active policy matches this
    // discount percentage and the creator is not an approver, the document
    // is born PENDING_APPROVAL; approval releases it as a normal document
    // while rejection cancels it.
    const discountGate =
      discountPct > 0
        ? await approvalGateCheck({
            user: __authSession.user,
            action: "DISCOUNT",
            businessId: Number(businessId),
            percent: discountPct,
          })
        : ({ gated: false } as Awaited<ReturnType<typeof approvalGateCheck>>);

    // Fetch business/branch details if not provided
    let resolvedBranchCode = branchCode;
    let resolvedBranchName = branchName;
    if (!resolvedBranchCode || !resolvedBranchName) {
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, Number(businessId)));
      resolvedBranchCode = resolvedBranchCode || biz?.code;
      resolvedBranchName = resolvedBranchName || biz?.name;
    }

    // ONE numbering source (src/lib/documentNumbers): PREFIX-YYYY-NNNN,
    // derived from the highest issued number so deletions can't cause reuse.
    const documentNumber = await nextSalesDocumentNumber(
      documentType === "INVOICE" ? "INVOICE" : documentType === "QUOTATION" ? "QUOTATION" : "RECEIPT"
    );

    const [inserted] = await db.insert(salesDocuments).values({
      documentNumber,
      documentType,
      businessId: Number(businessId),
      branchCode: resolvedBranchCode || null,
      branchName: resolvedBranchName || null,
      customerId: customerId ? Number(customerId) : null,
      customerName: String(customerName),
      customerPhone: customerPhone || null,
      customerEmail: customerEmail || null,
      customerAddress: customerAddress || null,
      lineItems: items,
      subtotalGhs: subtotal,
      taxRateGhs: taxRate,
      taxAmountGhs: taxAmount,
      discountGhs: discount,
      discountPercent: discountPct,
      totalGhs: total,
      currency: currency || "GHS",
      status: discountGate.gated ? "PENDING_APPROVAL" : documentType === "QUOTATION" ? "SENT" : "SENT",
      notes: notes || null,
      terms: terms || null,
      validUntil: validUntil || null,
      dueDate: dueDate || null,
      createdByUserId: actor.id,
      createdByName: actor.name || "Sales Center User",
      createdByRole: actor.role || null,
    }).returning();

    if (discountGate.gated) {
      await createApprovalRequest({
        action: "DISCOUNT",
        businessId: Number(businessId),
        branchCode: resolvedBranchCode || null,
        targetType: "SALE_DOCUMENT",
        targetId: Number(inserted.id),
        targetLabel: `${documentType} ${documentNumber} — ${customerName} (${discountPct}% off)`,
        amountGhs: discount,
        payloadSnapshot: {
          documentNumber,
          documentType,
          discountPercent: discountPct,
          discountGhs: discount,
          totalGhs: total,
        },
        actor: __authSession.user,
      });
      return NextResponse.json({
        success: true,
        document: inserted,
        pendingApproval: true,
        message: `Document saved as PENDING APPROVAL — a ${discountPct}% discount needs approval. The approvers have been notified.`,
      });
    }

    return NextResponse.json({ success: true, document: inserted });
  } catch (error: any) {
    console.error("Sales document creation error:", error);
    return apiError(error);
  }
}

/**
 * PATCH /api/sales-documents
 * Updates document status or converts quotation to invoice
 */
export async function PATCH(request: NextRequest) {
  ttlInvalidate("init");
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const { documentId, status, paymentMethod, linkedTransactionId, convertToInvoice } = body;
    // F-15: `currentUserId` / `currentUserName` / `currentUserRole` used to be
    // taken from this body and used to OVERWRITE the issuer of a converted
    // invoice — so the original provenance of a quotation could be rewritten
    // by anyone who could convert it. The converter is now the issuer.
    const actor = actorFrom(__authSession);
    if (!actor) return UNAUTHENTICATED();

    if (!documentId) {
      return NextResponse.json({ success: false, error: "documentId is required" }, { status: 400 });
    }

    const [existing] = await db.select().from(salesDocuments)
      .where(eq(salesDocuments.id, Number(documentId)));
    if (!existing) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    if (!(await canAccessBusiness(__authSession.user, existing.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // Handle quotation-to-invoice conversion
    if (convertToInvoice && existing.documentType === "QUOTATION") {
      const year = new Date().getFullYear();
      const existingInvoices = await db.select().from(salesDocuments)
        .where(eq(salesDocuments.documentType, "INVOICE"));
      let attempt = existingInvoices.length + 1;
      let newInvoiceNumber = `INV-${year}-${String(attempt).padStart(4, "0")}`;
      let existsCheck = await db.select().from(salesDocuments)
        .where(eq(salesDocuments.documentNumber, newInvoiceNumber));
      while (existsCheck.length > 0) {
        attempt += 1;
        newInvoiceNumber = `INV-${year}-${String(attempt).padStart(4, "0")}`;
        existsCheck = await db.select().from(salesDocuments)
          .where(eq(salesDocuments.documentNumber, newInvoiceNumber));
      }

      // Create the invoice from the quotation
      const [newInvoice] = await db.insert(salesDocuments).values({
        documentNumber: newInvoiceNumber,
        documentType: "INVOICE",
        businessId: existing.businessId,
        branchCode: existing.branchCode,
        branchName: existing.branchName,
        customerId: existing.customerId,
        customerName: existing.customerName,
        customerPhone: existing.customerPhone,
        customerEmail: existing.customerEmail,
        customerAddress: existing.customerAddress,
        lineItems: existing.lineItems,
        subtotalGhs: existing.subtotalGhs,
        taxRateGhs: existing.taxRateGhs,
        taxAmountGhs: existing.taxAmountGhs,
        discountGhs: existing.discountGhs,
        discountPercent: existing.discountPercent ?? 0,
        totalGhs: existing.totalGhs,
        currency: existing.currency,
        status: "SENT",
        notes: existing.notes,
        terms: existing.terms,
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
        linkedQuotationId: existing.id,
        createdByUserId: actor.id,
        createdByName: actor.name || existing.createdByName,
        createdByRole: actor.role || existing.createdByRole || null,
      }).returning();

      // Mark quotation as CONVERTED
      await db.update(salesDocuments)
        .set({ status: "CONVERTED", updatedAt: new Date() })
        .where(eq(salesDocuments.id, existing.id));

      return NextResponse.json({ success: true, document: newInvoice, converted: true });
    }

    // Regular status/payment update
    const updates: any = { updatedAt: new Date() };
    if (status) updates.status = status;
    if (paymentMethod) updates.paymentMethod = paymentMethod;
    if (linkedTransactionId) updates.linkedTransactionId = Number(linkedTransactionId);

    const [updated] = await db.update(salesDocuments)
      .set(updates)
      .where(eq(salesDocuments.id, Number(documentId)))
      .returning();

    return NextResponse.json({ success: true, document: updated });
  } catch (error: any) {
    console.error("Sales document update error:", error);
    return apiError(error);
  }
}
