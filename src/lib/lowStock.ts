/**
 * lowStock — reorder alerts on top of the existing inventory backbone (P3).
 *
 * `inventory_items` already carries `minStockThreshold` and a display-only
 * `status` (IN_STOCK / LOW_STOCK / OUT_OF_STOCK); nothing watched it. This
 * module is the missing trigger:
 *
 *  • sweepLowStock() walks each business's items, normalizes the status
 *    column to reality (qty ≤ 0 ⇒ OUT_OF_STOCK, qty ≤ threshold ⇒
 *    LOW_STOCK, else IN_STOCK) and — when something is at or below its
 *    reorder point — bell-notifies the whole branch team (owner + assigned
 *    staff + grantees, exactly like purchase events) with one digest row per
 *    business per day, deduped via recordRef `low-stock:{business}:{date}`.
 *  • Runs from the daily ops sweep (cron or the /api/init fallback) and from
 *    the on-demand "Check stock now" endpoint managers can hit any time —
 *    the same recordRef dedupe keeps manual runs from ever spamming.
 *
 * No new stock tables, no second inventory: the register stays the single
 * source of truth; this only reads it and shouts.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { inventoryItems, notifications } from "@/db/schema";
import { orderNotificationRecipients, ownerOrgOfBusiness } from "@/lib/notify";
import { pushAfterBell } from "@/lib/push";

function todayLocalISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

export interface LowStockItem {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  minStockThreshold: number;
  severity: "OUT" | "LOW";
}

/** Items at or below their reorder point for one business (OUT first). */
export async function lowStockItemsForBusiness(businessId: number): Promise<LowStockItem[]> {
  const rows = await db
    .select({
      id: inventoryItems.id,
      sku: inventoryItems.sku,
      name: inventoryItems.name,
      quantity: inventoryItems.quantity,
      unit: inventoryItems.unit,
      minStockThreshold: inventoryItems.minStockThreshold,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.businessId, Number(businessId)),
        sql`(${inventoryItems.quantity} <= ${inventoryItems.minStockThreshold} and ${inventoryItems.minStockThreshold} > 0) or ${inventoryItems.quantity} <= 0`,
      ),
    );
  return rows
    .map((r) => ({
      id: Number(r.id),
      sku: r.sku,
      name: r.name,
      quantity: Number(r.quantity),
      unit: r.unit,
      minStockThreshold: Number(r.minStockThreshold),
      severity: Number(r.quantity) <= 0 ? ("OUT" as const) : ("LOW" as const),
    }))
    .sort((a, b) => (a.severity === b.severity ? a.minStockThreshold - b.quantity : a.severity === "OUT" ? -1 : 1));
}

/** Bell + push, deduped per (user, type, recordRef) — mirrors notify.ts. */
async function notifyLowStock(
  businessId: number,
  items: LowStockItem[],
  opts?: { actorName?: string },
): Promise<number> {
  const date = todayLocalISO();
  const recordRef = `low-stock:${Number(businessId)}:${date}`;
  const recipients = await orderNotificationRecipients(Number(businessId));
  if (!recipients.length) return 0;
  const anyOut = items.some((i) => i.severity === "OUT");
  const list = items
    .slice(0, 8)
    .map((i) => `• ${i.name} (${i.sku}) — ${i.quantity} ${i.unit} left, reorder at ${i.minStockThreshold}`)
    .join("\n");
  const more = items.length > 8 ? `\n…and ${items.length - 8} more` : "";
  let sent = 0;
  for (const u of recipients) {
    const [dupe] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, Number(u.id)),
          eq(notifications.type, "LOW_STOCK"),
          eq(notifications.recordRef, recordRef),
        ),
      )
      .limit(1);
    if (dupe) continue;
    await db.insert(notifications).values({
      userId: Number(u.id),
      type: "LOW_STOCK",
      title: anyOut ? `Out of stock — ${items.length} item(s) need reordering` : `Low stock — ${items.length} item(s) at reorder point`,
      body: `${anyOut ? "Some items are fully out" : "These items are at or below their reorder point"}:\n${list}${more}\nRaise a purchase order in Procurement to restock.`.slice(0, 600),
      recordType: "INVENTORY_ITEM",
      recordId: null,
      recordRef,
      businessId: Number(businessId),
      actorName: opts?.actorName || "GoMina 360",
      priority: anyOut ? "HIGH" : "MEDIUM",
      ownerId: (await ownerOrgOfBusiness(Number(businessId))) ?? null,
    });
    sent++;
  }
  if (sent > 0) {
    pushAfterBell(
      recipients.map((u) => Number(u.id)),
      {
        type: "LOW_STOCK",
        title: anyOut ? `Out of stock — ${items.length} item(s)` : `Low stock — ${items.length} item(s)`,
        body: `${items.slice(0, 3).map((i) => i.name).join(", ")}${items.length > 3 ? ` +${items.length - 3} more` : ""} — reorder in Procurement.`,
        url: "/?tab=INVENTORY",
      },
    );
  }
  return sent;
}

export interface SweepResult {
  businessId: number;
  lowCount: number;
  outCount: number;
  notified: number;
  statusesNormalized: number;
}

/** One pass over a business: normalize item statuses + notify when needed. */
export async function sweepLowStockForBusiness(businessId: number, opts?: { actorName?: string }): Promise<SweepResult> {
  const items = await lowStockItemsForBusiness(businessId);
  // Normalize the display status to reality for EVERY item of the business
  // (cheap one statement; makes the Inventory register trustworthy).
  const res = await db.execute(
    sql`update inventory_items
        set status = case when quantity <= 0 then 'OUT_OF_STOCK'
                          when quantity <= min_stock_threshold and min_stock_threshold > 0 then 'LOW_STOCK'
                          else 'IN_STOCK' end
        where business_id = ${Number(businessId)}
          and status is distinct from (case when quantity <= 0 then 'OUT_OF_STOCK'
                                            when quantity <= min_stock_threshold and min_stock_threshold > 0 then 'LOW_STOCK'
                                            else 'IN_STOCK' end)`,
  );
  const normalized = Number((res as any)?.rowCount ?? (res as any)?.rows?.length ?? 0) || 0;
  const notified = items.length ? await notifyLowStock(Number(businessId), items, opts) : 0;
  return {
    businessId: Number(businessId),
    lowCount: items.filter((i) => i.severity === "LOW").length,
    outCount: items.filter((i) => i.severity === "OUT").length,
    notified,
    statusesNormalized: normalized,
  };
}

/** Sweep a set of businesses (null ⇒ every business in the database — the
 *  cron path). Per-business errors never abort the sweep. */
export async function sweepLowStock(
  businessIds: number[] | null,
  opts?: { actorName?: string },
): Promise<SweepResult[]> {
  let ids: number[];
  if (businessIds === null) {
    const rows = await db.execute(sql`select distinct business_id from inventory_items`);
    ids = (((rows as any).rows ?? rows) as any[]).map((r) => Number(r.business_id)).filter(Number.isFinite);
  } else {
    ids = (businessIds || []).map(Number);
  }
  const out: SweepResult[] = [];
  for (const id of ids) {
    try {
      out.push(await sweepLowStockForBusiness(id, opts));
    } catch (e) {
      console.error(`[lowStock] sweep failed for business ${id}:`, e);
    }
  }
  return out;
}
