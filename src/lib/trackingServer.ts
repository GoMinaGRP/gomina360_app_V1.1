import { db } from "@/db";
import {
  customerTrackings,
  inventoryItems,
  transactions,
  customers,
  notifications,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { buildTrackingCode, googleMapsLink } from "@/lib/tracking";
import { orderNotificationRecipients } from "@/lib/notify";
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
 */
export async function deductOrderStock(
  items: any[],
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const plan: { id: number; newQty: number; newStatus: string }[] = [];
  for (const li of items || []) {
    if (!li?.inventoryId) continue;
    const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(li.inventoryId)));
    if (!inv) {
      problems.push(`Product #${li.inventoryId} is no longer available.`);
      continue;
    }
    const qty = Number(li.quantity) || 0;
    if (qty <= 0) continue;
    if (inv.quantity < qty) {
      problems.push(`Not enough stock for "${inv.name}": ${qty} ${inv.unit} requested, ${inv.quantity} ${inv.unit} available.`);
      continue;
    }
    const newQty = inv.quantity - qty;
    plan.push({
      id: inv.id,
      newQty,
      newStatus: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= inv.minStockThreshold ? "LOW_STOCK" : "IN_STOCK",
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  for (const p of plan) {
    await db.update(inventoryItems).set({ quantity: p.newQty, status: p.newStatus }).where(eq(inventoryItems.id, p.id));
  }
  return { ok: true, problems: [] };
}

/** Give stock back when a committed order is cancelled. */
export async function restoreOrderStock(items: any[]): Promise<void> {
  for (const li of items || []) {
    if (!li?.inventoryId) continue;
    try {
      const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, Number(li.inventoryId)));
      if (!inv) continue;
      const newQty = inv.quantity + (Number(li.quantity) || 0);
      await db
        .update(inventoryItems)
        .set({
          quantity: newQty,
          status: newQty <= 0 ? "OUT_OF_STOCK" : newQty <= inv.minStockThreshold ? "LOW_STOCK" : "IN_STOCK",
        })
        .where(eq(inventoryItems.id, inv.id));
    } catch (e) {
      console.error("restoreOrderStock warning:", e);
    }
  }
}

/** Match / accumulate the shared CRM customer (same rules as the till). Never throws. */
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
    const all = await db.select().from(customers);
    const norm = (s: any) => String(s || "").trim().toLowerCase();
    // Business isolation: the selling business's OWN customer wins first; a
    // legacy group-shared (NULL business) row still matches as a fallback so
    // history flows to it, but new rows are always stamped to the seller.
    const match =
      (phone && all.find((c) => norm(c.phone) === norm(phone) && c.businessId === businessId)) ||
      (name && all.find((c) => norm(c.name) === norm(name) && c.businessId === businessId)) ||
      (phone && all.find((c) => norm(c.phone) === norm(phone) && c.businessId === null)) ||
      (name && all.find((c) => norm(c.name) === norm(name) && c.businessId === null)) ||
      null;
    if (match) {
      await db
        .update(customers)
        .set({
          totalSpentGhs: (match.totalSpentGhs || 0) + spendGhs,
          loyaltyPoints: (match.loyaltyPoints || 0) + Math.floor(spendGhs / 100),
        })
        .where(eq(customers.id, match.id));
      return match.id;
    }
    if (name && norm(name) !== "walk-in" && norm(name) !== "walk-in customer") {
      const [created] = await db
        .insert(customers)
        .values({
          name: String(name).trim(),
          type: "RETAIL",
          phone: phone || "",
          totalSpentGhs: spendGhs,
          loyaltyPoints: Math.floor(spendGhs / 100),
          // Isolation: storefront & staff-tracked orders stamp the SELLING
          // business so the buyer appears in that unit's CRM scope.
          businessId: businessId || null,
        })
        .returning();
      return created?.id ?? null;
    }
  } catch (e) {
    console.error("linkCrmCustomer warning:", e);
  }
  return null;
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
  const trxNum = `TRX-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  const dateStr = new Date().toISOString().split("T")[0];
  const itemsDesc = (tracking.items || [])
    .map((li: any) => `${li.quantity}× ${li.description}`)
    .join(", ");
  const [trx] = await db
    .insert(transactions)
    .values({
      transactionNumber: trxNum,
      businessId: tracking.businessId,
      branchCode: tracking.branchCode || business?.code || null,
      branchName: tracking.branchName || business?.name || null,
      type: "INCOME",
      category: "Online Order Sale",
      amountGhs: tracking.totalGhs || 0,
      paymentMethod: method,
      customerId: tracking.customerId || null,
      description: `[ORDER:${tracking.trackingCode}] ${itemsDesc || "Online order"} — ${tracking.customerName}`,
      date: dateStr,
      createdAt: new Date(),
      status: "COMPLETED",
      recordedBy: staff.name || "Staff",
      recordedByRole: staff.role || null,
      recordedByUserId: staff.id ?? null,
    })
    .returning();
  return trx.id;
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
