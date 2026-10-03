import { db } from "@/db";
import { postServiceSale } from "@/lib/servicePosting";
import { applyStockChange } from "@/lib/stock";
import {
  customerTrackings,
  inventoryItems,
  customers,
  notifications,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { deductVariantQty, restoreVariantQty, syncItemAggregate, variantsForItem } from "@/lib/boutique";
import { buildTrackingCode, googleMapsLink } from "@/lib/tracking";
import { orderNotificationRecipients, ownerOrgOfBusiness } from "@/lib/notify";
import { linkOrCreateCustomer, isAnonymousBuyer } from "@/lib/customerLink";
import { pushAfterBell } from "@/lib/push";

/** Server-side helpers for Customer Ordering & Tracking (used by the public
 *  /api/order and the staff /api/tracking routes). */

/**
 * Validate + normalize a Google-Maps delivery pin from a request body.
 * Either BOTH deliveryLat & deliveryLng must be present, or neither.
 * Returns null when absent, throws an error message when malformed.
 */
export function normalizeDeliveryPin(body: any): {
  deliveryLat: number;
  deliveryLng: number;
  deliveryAccuracyM: number | null;
  deliveryMapLink: string;
  deliveryPinnedAt: Date;
} | null {
  const hasLat = body?.deliveryLat != null && body?.deliveryLat !== "";
  const hasLng = body?.deliveryLng != null && body?.deliveryLng !== "";
  if (!hasLat && !hasLng) return null;
  if (!hasLat || !hasLng) throw new Error("The delivery pin needs both latitude and longitude.");
  const lat = Number(body.deliveryLat);
  const lng = Number(body.deliveryLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error("The delivery pin coordinates are out of range.");
  }
  let accuracy: number | null = null;
  if (body.deliveryAccuracyM != null && body.deliveryAccuracyM !== "") {
    const a = Number(body.deliveryAccuracyM);
    if (Number.isFinite(a) && a >= 0) accuracy = Math.min(a, 50000);
  }
  return {
    deliveryLat: lat,
    deliveryLng: lng,
    deliveryAccuracyM: accuracy,
    deliveryMapLink: googleMapsLink(lat, lng),
    deliveryPinnedAt: new Date(),
  };
}

export async function uniqueTrackingCode(bizCode: string | null | undefined): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = buildTrackingCode(bizCode);
    const clash = await db
      .select({ id: customerTrackings.id })
      .from(customerTrackings)
      .where(eq(customerTrackings.trackingCode, code));
    if (clash.length === 0) return code;
  }
  return buildTrackingCode(bizCode) + String(Date.now()).slice(-2);
}

/**
 * Deduct stock for an ONLINE order's items (items carry inventoryId).
 * First validates availability; if any line is short, NOTHING is deducted
 * and problems are returned for the staff member / customer to see.
 *
 * Boutique rule: a line for a product that carries a SIZE/COLOUR matrix must
 * name its variant (`li.variantId`). The deduction then hits that exact
 * variant and the item's aggregate quantity is recomputed from its variant
 * rows, so the register, dashboards and reports can never drift.
 */
export async function deductOrderStock(
  items: any[],
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const plan: (
    | { kind: "plain"; id: number; businessId: number; qty: number }
    | { kind: "variant"; variantId: number; inventoryId: number; qty: number; label: string }
  )[] = [];
  for (const li of items || []) {
    if (!li?.inventoryId) continue;
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(li.inventoryId)));
    if (!inv) {
      problems.push(`Product #${li.inventoryId} is no longer available.`);
      continue;
    }
    const qty = Number(li.quantity) || 0;
    if (qty <= 0) continue;
    const activeVariants = (await variantsForItem(inv.businessId, inv.id)).filter((v) => v.isActive !== false);
    if (activeVariants.length > 0) {
      const variantId = Number(li.variantId) || 0;
      const variant = activeVariants.find((v) => Number(v.id) === variantId);
      if (!variant) {
        problems.push(`"${inv.name}" needs a size/colour before its stock can be committed.`);
        continue;
      }
      const label = [variant.size ? `Size ${variant.size}` : null, variant.color || null].filter(Boolean).join(" · ");
      if ((Number(variant.quantity) || 0) < qty) {
        problems.push(
          `Not enough stock for "${inv.name}"${label ? ` (${label})` : ""}: ${qty} requested, ${variant.quantity} available.`,
        );
        continue;
      }
      plan.push({ kind: "variant", variantId: Number(variant.id), inventoryId: inv.id, qty, label });
      continue;
    }
    if (inv.quantity < qty) {
      problems.push(`Not enough stock for "${inv.name}": ${qty} ${inv.unit} requested, ${inv.quantity} ${inv.unit} available.`);
      continue;
    }
    plan.push({ kind: "plain", id: inv.id, businessId: Number(inv.businessId), qty });
  }
  if (problems.length > 0) return { ok: false, problems };
  for (const p of plan) {
    if (p.kind === "variant") {
      // Atomic conditional decrement — a concurrent sale that emptied the
      // variant between validation and now is reported, never oversold.
      const ok = await deductVariantQty(p.variantId, p.qty);
      if (!ok) {
        problems.push(`"${p.label || "That variant"}" just sold out — refresh and choose another size/colour.`);
        continue;
      }
      await syncItemAggregate(p.inventoryId);
    } else {
      // P5: ONE stock writer (the pre-validated deduction is applied as a delta).
      await applyStockChange({
        businessId: Number(p.businessId),
        inventoryId: p.id,
        delta: -(Number(p.qty) || 0),
        reason: "SALE",
        refType: "ORDER_COMMIT",
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, problems: [] };
}

/** Give stock back when a committed order is cancelled. */
export async function restoreOrderStock(items: any[]): Promise<void> {
  for (const li of items || []) {
    if (!li?.inventoryId) continue;
    try {
      const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(li.inventoryId)));
      if (!inv) continue;
      const qty = Number(li.quantity) || 0;
      const variantId = Number(li.variantId) || 0;
      if (variantId) {
        await restoreVariantQty(variantId, qty);
        await syncItemAggregate(inv.id);
        continue;
      }
      // P5: ONE stock writer — a cancelled order gives stock back (RESTORE).
      await applyStockChange({
        businessId: Number(inv.businessId),
        inventoryId: inv.id,
        delta: qty,
        reason: "RESTORE",
        refType: "ORDER_CANCELLED",
      });
    } catch (e) {
      console.error("restoreOrderStock warning:", e);
    }
  }
}

/**
 * Match / accumulate the shared CRM customer for storefront & tracked orders.
 *
 * This used to be a SECOND find-or-create implementation (its own org check,
 * its own loyalty rate, and an unfiltered `select() from customers` scan per
 * order) living beside `src/lib/customerLink`. It now delegates to that single
 * matcher, so the till, credit sales, module sales and online orders all agree
 * on who a buyer is and how spend accrues.
 *
 * Behaviour preserved exactly: anonymous buyers ("walk-in", blank names) are
 * never CREATED here (matchOnly), the historical group-shared rows with a null
 * businessId stay matchable inside the same organization, and the owning
 * organization is stamped on new rows.
 */
export async function linkCrmCustomer({
  name,
  phone,
  businessId,
  spendGhs,
}: {
  name: string;
  phone?: string | null;
  businessId: number;
  spendGhs: number;
}): Promise<number | null> {
  try {
    const ownerOrg = businessId != null ? await ownerOrgOfBusiness(Number(businessId)) : null;
    const linked = await linkOrCreateCustomer({
      businessId: Number(businessId),
      name,
      phone,
      amount: spendGhs,
      ownerId: ownerOrg,
      includeLegacyShared: true,
      // Orders only ever adopt an existing buyer; a real name is required to
      // open a new CRM record (exactly the pre-refactor rule).
      matchOnly: isAnonymousBuyer(name),
    });
    return linked?.id ?? null;
  } catch (e) {
    console.error("linkCrmCustomer warning:", e);
    return null;
  }
}

/** Book revenue when staff confirm payment for an order. Returns transaction id. */
export async function bookOrderPayment({
  tracking,
  method,
  staff,
  business,
}: {
  tracking: any;
  method: "CASH" | "MTN_MOMO";
  staff: { name?: string; role?: string; id?: number };
  business: any;
}): Promise<number> {
  const itemsDesc = (tracking.items || [])
    .map((li: any) => `${li.quantity}× ${li.description}`)
    .join(", ");
  // P5: ONE service-sale writer (shared with car-wash / telecom / transport).
  const posted = await postServiceSale({
    businessId: Number(tracking.businessId),
    branchCode: tracking.branchCode || business?.code || null,
    branchName: tracking.branchName || business?.name || null,
    category: "Online Order Sale",
    description: `${itemsDesc || "Online order"} — ${tracking.customerName}`,
    amountGhs: Number(tracking.totalGhs) || 0,
    paymentMethod: method,
    customerId: tracking.customerId || null,
    actor: { id: staff.id ?? null, name: staff.name || "Staff", role: staff.role || null },
    tag: `ORDER:${tracking.trackingCode}`,
  });
  return posted.transaction?.id ?? 0;
}

/** Bell-notify the branch team + owner that an online order arrived. */
export async function notifyOnlineOrder({
  businessId,
  code,
  customerName,
  totalGhs,
  itemsCount,
}: {
  businessId: number;
  code: string;
  customerName: string;
  totalGhs: number;
  itemsCount: number;
}): Promise<void> {
  try {
    // OWNER + assigned staff + user_business_access grantees (duty sharing),
    // deduped — a brand-new user created AFTER the order is handled by the
    // backfill in src/lib/notify.ts when they are assigned.
    const recipients = await orderNotificationRecipients(businessId);
    const pushedIds: number[] = [];
    const title = `New online order ${code}`;
    const body = `${customerName} ordered ${itemsCount} item${itemsCount === 1 ? "" : "s"} (GH₵ ${Number(totalGhs || 0).toFixed(2)}) on the customer storefront. Open Customer Order & Tracking to confirm it.`;
    for (const u of recipients) {
      const dupes = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(u.id)),
            eq(notifications.type, "ONLINE_ORDER_RECEIVED"),
            eq(notifications.recordRef, code),
          ),
        )
        .limit(1);
      if (dupes.length) continue;
      await db.insert(notifications).values({
        userId: u.id,
        type: "ONLINE_ORDER_RECEIVED",
        title,
        body,
        recordType: "customer_trackings",
        recordRef: code,
        businessId,
        actorName: customerName,
        ownerId: await ownerOrgOfBusiness(Number(businessId)),
      });
      pushedIds.push(Number(u.id));
    }
    // Phone/laptop (OS-level) push for everyone who just got the fresh bell row.
    if (pushedIds.length) {
      pushAfterBell(pushedIds, { type: "ONLINE_ORDER_RECEIVED", title, body, url: "/?tab=TRACKING" });
    }
  } catch (e) {
    console.error("notifyOnlineOrder warning:", e);
  }
}
