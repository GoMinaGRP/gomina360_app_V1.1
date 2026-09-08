/**
 * Notification fan-out helpers — Order & Inventory bell.
 *
 * Who gets what:
 *  - Every order/purchase event reaches the OWNER, every staff member
 *    ASSIGNED to that business, and every user with a user_business_access
 *    GRANT for it (extra-branch duty). One row per recipient, deduped on
 *    (userId, type, recordRef) so re-saves never double-notify.
 *  - When a NEW user is created (or an existing user is (re)assigned to a
 *    business), `backfillUserNotifications` walks the recent open orders and
 *    purchases of their businesses and lands them in their bell — so duty
 *    hand-overs start with full context instead of an empty bell.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { pushAfterBell, urlForNotification } from "@/lib/push";
import {
  customerTrackings,
  electronicsPurchases,
  hardwarePurchases,
  notifications,
  restaurantPurchases,
  userBusinessAccess,
  users,
} from "@/db/schema";

/** Statuses meaning "this order no longer needs anyone's attention". */
const CLOSED_ORDER_STATUSES = ["DELIVERED", "COMPLETED", "CANCELLED"];
const OPEN_PURCHASE_STATUSES = ["ORDERED", "PENDING"];

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * All users who must see events for `businessId` in their bell:
 * the OWNER + assigned staff + user_business_access grantees.
 */
export async function orderNotificationRecipients(businessId: number) {
  const [staff, grants] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        assignedBusinessId: users.assignedBusinessId,
        isActive: users.isActive,
      })
      .from(users),
    db
      .select({ userId: userBusinessAccess.userId })
      .from(userBusinessAccess)
      .where(eq(userBusinessAccess.businessId, Number(businessId))),
  ]);
  const granted = new Set(grants.map((g: { userId: number }) => Number(g.userId)));
  return staff.filter(
    (u) =>
      u.isActive !== false &&
      (u.role === "OWNER" ||
        Number(u.assignedBusinessId) === Number(businessId) ||
        granted.has(Number(u.id))),
  );
}

/** Insert one notification per recipient, skipping exact duplicates —
 *  then fire the OS-level (phone/laptop) push for everyone who got a FRESH
 *  bell row. `opts.push === false` skips the push (used by the duty-handover
 *  backfill: historical context belongs in the bell, not on the lock screen). */
async function fanOut(
  recipients: { id: number }[],
  row: {
    type: string;
    title: string;
    body: string;
    recordType: string;
    recordId?: number | null;
    recordRef: string;
    businessId: number;
    branchCode?: string | null;
    actorName?: string | null;
  },
  opts?: { push?: boolean },
): Promise<number> {
  let sent = 0;
  const pushedIds: number[] = [];
  for (const u of recipients) {
    const dupes = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, Number(u.id)),
          eq(notifications.type, row.type),
          eq(notifications.recordRef, row.recordRef),
        ),
      )
      .limit(1);
    if (dupes.length) continue; // already told about this exact record
    await db.insert(notifications).values({
      userId: Number(u.id),
      type: row.type,
      title: row.title,
      body: row.body,
      recordType: row.recordType,
      recordId: row.recordId ?? null,
      recordRef: row.recordRef,
      businessId: row.businessId,
      branchCode: row.branchCode ?? null,
      actorName: row.actorName ?? null,
    });
    sent++;
    pushedIds.push(Number(u.id));
  }
  if (opts?.push !== false && pushedIds.length) {
    pushAfterBell(pushedIds, {
      type: row.type,
      title: row.title,
      body: row.body,
      url: urlForNotification(row.type, { branchCode: row.branchCode }),
    });
  }
  return sent;
}

/** Bell-notify the whole branch team when a supplier purchase is recorded. */
export async function notifyPurchase({
  businessId,
  branchCode,
  purchaseNumber,
  supplierName,
  itemName,
  quantity,
  unit,
  totalGhs,
  status,
  recordId,
  actorName,
  type = "PURCHASE_RECORDED",
}: {
  businessId: number;
  branchCode?: string | null;
  purchaseNumber: string;
  supplierName?: string | null;
  itemName?: string | null;
  quantity?: number | null;
  unit?: string | null;
  totalGhs?: number | null;
  status?: string | null;
  recordId?: number | null;
  actorName?: string | null;
  /** PURCHASE_RECORDED on create; PURCHASE_RECEIVED on stock-in flip. */
  type?: string;
}): Promise<void> {
  try {
    const recipients = await orderNotificationRecipients(businessId);
    const qtyText =
      quantity != null
        ? `${Number(quantity)} ${unit || "unit"}${Number(quantity) === 1 ? "" : "s"} of `
        : "";
    await fanOut(recipients, {
      type,
      title: `Purchase ${purchaseNumber}${status === "RECEIVED" ? " received" : ""}`,
      body: `${actorName || "Staff"} recorded ${qtyText}${itemName || "stock"} from ${supplierName || "supplier"} (GH₵ ${round2(Number(totalGhs) || 0).toFixed(2)}, status ${status || "ORDERED"}).`,
      recordType: "purchases",
      recordId: recordId ?? null,
      recordRef: purchaseNumber,
      businessId,
      branchCode: branchCode ?? null,
      actorName: actorName ?? null,
    });
  } catch (e) {
    // Notifications must never block the underlying purchase.
    console.error("[notify] notifyPurchase failed:", e);
  }
}

/**
 * Give a user the bell context they need for their businesses: recent OPEN
 * orders (latest first) and recent purchases, deduped against anything
 * already in their bell. Called on user creation and on assignment changes.
 */
export async function backfillUserNotifications({
  userId,
  userName,
  businessIds,
}: {
  userId: number;
  userName?: string | null;
  businessIds: number[];
}): Promise<number> {
  const bizIds = Array.from(
    new Set((businessIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)),
  );
  if (!bizIds.length) return 0;
  let inserted = 0;
  try {
    // — Open orders first (they drive daily duty), newest 15 per business.
    for (const bId of bizIds) {
      const orders = await db
        .select()
        .from(customerTrackings)
        .where(eq(customerTrackings.businessId, bId))
        .orderBy(desc(customerTrackings.id))
        .limit(60);
      const open = orders
        .filter(
          (o) =>
            !CLOSED_ORDER_STATUSES.includes(String(o.status || "")) ||
            String(o.paymentStatus || "") !== "PAID",
        )
        .slice(0, 15);
      for (const o of open) {
        inserted += await fanOut([{ id: userId }], {
          // Backfill = historical duty context — bell only, no push storm.
          type: o.orderSource === "ONLINE" ? "ONLINE_ORDER_RECEIVED" : "ORDER_ASSIGNED",
          title:
            o.orderSource === "ONLINE"
              ? `Online order ${o.trackingCode}`
              : `Order ${o.trackingCode} on your duty`,
          body: `${o.customerName || "Customer"} — ${(Array.isArray(o.items) ? o.items.length : 0) || 1} line(s), GH₵ ${round2(Number(o.totalGhs) || 0).toFixed(2)}, status ${o.status}${o.paymentStatus !== "PAID" ? ` (${String(o.paymentStatus || "UNPAID").toLowerCase()})` : ""}.${userName ? ` Welcome aboard, ${userName} — ` : " "}follow it in Customer Order & Tracking.`,
          recordType: "customer_trackings",
          recordId: o.id,
          recordRef: o.trackingCode,
          businessId: bId,
          branchCode: o.branchCode,
          actorName: "GoMina 360",
        }, { push: false });
      }
      // — Purchases (electronics + hardware + restaurant), latest 6 per table.
      const purchaseTables = [electronicsPurchases, hardwarePurchases, restaurantPurchases];
      for (const table of purchaseTables) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.businessId, bId))
          .orderBy(desc(table.id))
          .limit(20);
        for (const p of rows.slice(0, 6)) {
          if (String(p.status || "").toUpperCase() === "CANCELLED") continue;
          const open = OPEN_PURCHASE_STATUSES.includes(String(p.status || ""));
          inserted += await fanOut([{ id: userId }], {
            type: "PURCHASE_RECORDED", // backfill — bell only, no push storm
            title: `Purchase ${p.purchaseNumber}${p.status === "RECEIVED" ? " received" : ""}`,
            body: `${p.quantity} unit(s) of ${p.itemName} from ${p.supplierName} (GH₵ ${round2(Number(p.totalGhs) || 0).toFixed(2)}, status ${p.status}).${open ? " Awaiting receipt — see the Purchases register." : ""}`,
            recordType: "purchases",
            recordId: p.id,
            recordRef: p.purchaseNumber,
            businessId: bId,
            branchCode: p.branchCode,
            actorName: p.createdByName || "GoMina 360",
          }, { push: false });
        }
      }
    }
  } catch (e) {
    console.error("[notify] backfillUserNotifications failed:", e);
  }
  return inserted;
}

/** Resolve the full business id set a user belongs to (assigned + grants). */
export async function businessIdsForUser(userId: number, assignedBusinessId: number | null): Promise<number[]> {
  const ids = new Set<number>();
  if (assignedBusinessId != null && Number.isFinite(Number(assignedBusinessId))) {
    ids.add(Number(assignedBusinessId));
  }
  const grants = await db
    .select({ businessId: userBusinessAccess.businessId })
    .from(userBusinessAccess)
    .where(eq(userBusinessAccess.userId, Number(userId)));
  for (const g of grants) ids.add(Number(g.businessId));
  return Array.from(ids);
}
