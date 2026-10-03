import { NextRequest, NextResponse } from "next/server";
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from "@/db";
import { inventoryItems } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { deductVariantQty, resolveVariantForLine, syncItemAggregate } from "@/lib/boutique";
import { variantSuffix } from "@/lib/boutiqueSizes";
import { computeSaleTotals, normalizeSaleLines, postSale } from "@/lib/salePosting";

/**
 * POST /api/sales
 *
 * Inventory-linked sale processor:
 * 1. Validates every cart item against branch inventory (stock check)
 * 2. Deducts sold quantities from inventory
 * 3. Updates inventory status (IN_STOCK / LOW_STOCK / OUT_OF_STOCK)
 * 4. Creates a financial transaction record
 * 5. Creates a sales document (receipt) with line items
 * 6. Records any custom price overrides for audit
 *
 * Body: {
 *   businessId, branchCode,
 *   customerName, customerPhone,
 *   paymentMethod,
 *   cartItems: [{ inventoryId, sku, name, quantity, originalPrice, sellingPrice, customPriceReason? }],
 *   notes,
 *   createdByUserId, createdByName, createdByRole,
 *   discount?
 * }
 */
export async function POST(request: NextRequest) {
  ttlInvalidate("init");
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      businessId,
      branchCode,
      customerName,
      customerPhone,
      paymentMethod,
      cartItems,
      notes,
      createdByUserId,
      createdByName,
      createdByRole,
      discount,
      discountPercent,
    } = body;

    if (!businessId || !cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json(
        { success: false, error: "businessId and at least one cart item are required." },
        { status: 400 }
      );
    }
    // A sale deducts stock and posts revenue — only inside businesses the
    // signed-in user can actually access.
    if (!(await canAccessBusiness(__authSession.user, Number(businessId)))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // ── 1. Validate every item against inventory ──────────────────────
    const validationErrors: string[] = [];
    const inventoryUpdates: { id: number; newQty: number; newStatus: string }[] = [];
    // Boutique: variant rows deducted alongside their aggregate item.
    const variantUpdates: { variantId: number; inventoryId: number; qty: number; label: string }[] = [];
    const variantItemIds = new Set<number>();
    const lineItems: any[] = [];
    const priceAuditEntries: any[] = [];

    for (const item of cartItems) {
      const { inventoryId, quantity, sellingPrice, originalPrice, customPriceReason, variantId } = item;

      if (!inventoryId || !quantity || quantity <= 0) {
        validationErrors.push(`Invalid cart item: missing inventoryId or quantity.`);
        continue;
      }

      const [inv] = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, Number(inventoryId)));

      if (!inv) {
        validationErrors.push(`Product #${inventoryId} not found in inventory.`);
        continue;
      }

      if (inv.businessId !== Number(businessId)) {
        validationErrors.push(`Product "${inv.name}" does not belong to this branch.`);
        continue;
      }

      // Boutique variant choice — required for products that carry a
      // size/colour matrix; validated against live per-variant stock.
      const variantVerdict = await resolveVariantForLine({
        businessId: Number(businessId),
        inventoryId: inv.id,
        variantId: variantId != null && Number(variantId) > 0 ? Number(variantId) : null,
        quantity: Number(quantity),
      });
      if (variantVerdict.error) {
        validationErrors.push(`"${inv.name}": ${variantVerdict.error}`);
        continue;
      }
      const variantRow = variantVerdict.variant;
      const availableUnits = variantRow ? Number(variantRow.quantity) || 0 : inv.quantity;

      if (variantRow ? availableUnits <= 0 : inv.status === "OUT_OF_STOCK" || inv.quantity <= 0) {
        validationErrors.push(`"${inv.name}" is OUT OF STOCK and cannot be sold.`);
        continue;
      }

      if (Number(quantity) > availableUnits) {
        validationErrors.push(
          variantRow
            ? `Insufficient stock for "${inv.name}" (${[variantRow.size ? `Size ${variantRow.size}` : null, variantRow.color || null].filter(Boolean).join(" · ")}): requested ${quantity}, available ${availableUnits} ${inv.unit}.`
            : `Insufficient stock for "${inv.name}": requested ${quantity}, available ${availableUnits} ${inv.unit}.`
        );
        continue;
      }

      const effectivePrice = Number(sellingPrice) || inv.sellingPriceGhs;
      const itemTotal = effectivePrice * Number(quantity);
      const newQty = inv.quantity - Number(quantity);
      const newStatus =
        newQty <= 0
          ? "OUT_OF_STOCK"
          : newQty <= inv.minStockThreshold
          ? "LOW_STOCK"
          : "IN_STOCK";

      inventoryUpdates.push({ id: inv.id, newQty, newStatus });
      if (variantRow) {
        variantUpdates.push({
          variantId: Number(variantRow.id),
          inventoryId: inv.id,
          qty: Number(quantity),
          label: [variantRow.size ? `Size ${variantRow.size}` : null, variantRow.color || null].filter(Boolean).join(" · "),
        });
        variantItemIds.add(inv.id);
      }

      const vSuffix = variantRow ? variantSuffix(variantRow.size, variantRow.color) : "";
      lineItems.push({
        inventoryId: inv.id,
        sku: inv.sku,
        description: `${inv.name} (${inv.sku})${vSuffix}`,
        ...(variantRow
          ? {
              variantId: Number(variantRow.id),
              variantSku: variantRow.sku || null,
              size: variantRow.size || null,
              color: variantRow.color || null,
            }
          : {}),
        category: inv.category,
        quantity: Number(quantity),
        unit: inv.unit,
        originalPrice: inv.sellingPriceGhs,
        unitPrice: effectivePrice,
        total: itemTotal,
        costPrice: inv.costPriceGhs || 0,
        costTotal: (inv.costPriceGhs || 0) * Number(quantity),
        lineProfit: itemTotal - (inv.costPriceGhs || 0) * Number(quantity),
      });

      // Track price overrides for audit
      if (effectivePrice !== inv.sellingPriceGhs) {
        priceAuditEntries.push({
          inventoryId: inv.id,
          sku: inv.sku,
          name: inv.name,
          originalPrice: inv.sellingPriceGhs,
          customPrice: effectivePrice,
          difference: effectivePrice - inv.sellingPriceGhs,
          reason: customPriceReason || "No reason provided",
          changedBy: createdByName || "Unknown",
          changedByRole: createdByRole || "Staff",
        });
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: validationErrors.join(" | "), errors: validationErrors },
        { status: 400 }
      );
    }

    // ── 1b. Validate the money maths BEFORE anything moves ───────────
    // (A bad discount used to be rejected only after the stock had already
    // been deducted, leaving inventory wrong on a 400 response.)
    const preview = computeSaleTotals(normalizeSaleLines(lineItems), discount, discountPercent);
    if (preview.error || !preview.totals) {
      return NextResponse.json({ success: false, error: preview.error }, { status: 400 });
    }

    // ── 2. Deduct inventory quantities ───────────────────────────────
    // Boutique lines first hit their exact variant row (atomic conditional
    // decrement), then the item's aggregate is recomputed FROM the variant
    // rows so register, dashboards, low-stock and reports can never drift.
    const variantFailures: string[] = [];
    for (const vu of variantUpdates) {
      const ok = await deductVariantQty(vu.variantId, vu.qty);
      if (!ok) variantFailures.push(`"${vu.label || "variant"}" just sold out — refresh and try again.`);
    }
    if (variantFailures.length > 0) {
      return NextResponse.json(
        { success: false, error: variantFailures.join(" | "), errors: variantFailures },
        { status: 409 },
      );
    }
    for (const update of inventoryUpdates) {
      if (variantItemIds.has(update.id)) {
        await syncItemAggregate(update.id);
        continue;
      }
      await db
        .update(inventoryItems)
        .set({ quantity: update.newQty, status: update.newStatus })
        .where(eq(inventoryItems.id, update.id));
    }

    // ── 3. Post the sale through the SHARED engine ───────────────────
    // One writer for money: ledger INCOME transaction + RECEIPT sales
    // document + CRM link/accrual + tracking code. The module fulfilment
    // paths (hardware/electronics deliveries, restaurant tickets) call the
    // very same engine, so Finance, Receipts, CRM and Tracking can never
    // disagree about what was sold.
    const posted = await postSale({
      businessId: Number(businessId),
      branchCode: branchCode || null,
      lines: lineItems,
      customerName,
      customerPhone,
      paymentMethod,
      notes,
      discount,
      discountPercent,
      tag: "INV",
      actor: { id: createdByUserId, name: createdByName, role: createdByRole },
    });
    if (!posted.success) {
      return NextResponse.json({ success: false, error: posted.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      transaction: posted.transaction,
      receipt: posted.receipt,
      lineItems: posted.lineItems,
      cogsGhs: posted.totals.cogs,
      grossProfitGhs: posted.totals.grossProfit,
      customerId: posted.customerId,
      trackingCode: posted.trackingCode,
      trackUrl: posted.trackingCode ? `/track?code=${encodeURIComponent(posted.trackingCode)}` : null,
      priceOverrides: priceAuditEntries,
      inventoryUpdates: inventoryUpdates.map((u) => ({
        inventoryId: u.id,
        newQuantity: u.newQty,
        newStatus: u.newStatus,
      })),
    });
  } catch (error: any) {
    console.error("POST /api/sales error:", error);
    return apiError(error);
  }
}
