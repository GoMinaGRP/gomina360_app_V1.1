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
  businesses,
  customerTrackings,
  electronicsPurchases,
  hardwarePurchases,
  notifications,
  organizationMembers,
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

/** The organization (tenant) that owns a business. */
export async function ownerOrgOfBusiness(businessId: number): Promise<number | null> {
  const [b] = await db
    .select({ ownerId: businesses.ownerId })
    .from(businesses)
    .where(eq(businesses.id, Number(businessId)));
  return b?.ownerId != null ? Number(b.ownerId) : null;
}

/**
 * All users who must see events for `businessId` in their bell:
 * the business's organization OWNER(s) + assigned staff +
 * user_business_access grantees — strictly members of the business's own
 * organization. A notification can never cross to another Owner's users.
 */
export async function orderNotificationRecipients(businessId: number) {
  const orgId = await ownerOrgOfBusiness(businessId);
  const memberRows = orgId
    ? await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, orgId))
    : [];
  const memberIds = new Set(memberRows.map((m) => Number(m.userId)));
  const [staffAll, grants] = await Promise.all([
    memberIds.size
      ? db
          .select({
            id: users.id,
            name: users.name,
            role: users.role,
            assignedBusinessId: users.assignedBusinessId,
            isActive: users.isActive,
          })
          .from(users)
      : Promise.resolve([]),
    db
      .select({ userId: userBusinessAccess.userId })
      .from(userBusinessAccess)
      .where(eq(userBusinessAccess.businessId, Number(businessId))),
  ]);
  const granted = new Set(grants.map((g: { userId: number }) => Number(g.userId)));
  return staffAll.filter(
    (u) =>
      u.isActive !== false &&
      memberIds.has(Number(u.id)) &&
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
    priority?: string | null;
  },
  opts?: { push?: boolean },
): Promise<number> {
  let sent = 0;
  const pushedIds: number[] = [];
  const ownerId = (row as any).ownerId ?? (await ownerOrgOfBusiness(Number(row.businessId)));
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
      priority: row.priority ?? null,
      ownerId: ownerId ?? null,
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

/**
 * Who should be *watching* an audit issue on a business when it is flagged:
 *  - every active Branch/General Manager whose assigned business is this
 *    business (or who holds a user_business_access grant for it) — always;
 *  - the org OWNER(S) — always when the issue could not be routed to a
 *    concrete user, and on HIGH/CRITICAL severities regardless of assignment.
 * Strictly members of the business's own organization: a notification can
 * never cross into another Owner's tenant.
 */
export async function auditEscalationRecipients(
  businessId: number,
  priority: string,
  opts: { unassigned?: boolean; excludeIds?: (number | null)[] } = {},
): Promise<{ id: number; name: string | null; role: string | null }[]> {
  const orgId = await ownerOrgOfBusiness(businessId);
  const memberRows = orgId
    ? await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, orgId))
    : [];
  const memberIds = new Set(memberRows.map((m) => Number(m.userId)));
  const [staffAll, grants] = await Promise.all([
    memberIds.size
      ? db
          .select({
            id: users.id,
            name: users.name,
            role: users.role,
            assignedBusinessId: users.assignedBusinessId,
            isActive: users.isActive,
          })
          .from(users)
      : Promise.resolve([]),
    db
      .select({ userId: userBusinessAccess.userId })
      .from(userBusinessAccess)
      .where(eq(userBusinessAccess.businessId, Number(businessId))),
  ]);
  const granted = new Set(grants.map((g: { userId: number }) => Number(g.userId)));
  const excluded = new Set((opts.excludeIds || []).filter((x): x is number => x != null).map(Number));
  const sev = String(priority || "MEDIUM").toUpperCase();
  const wantOwner = sev === "HIGH" || sev === "CRITICAL" || !!opts.unassigned;
  const isManagerRole = (r: string | null | undefined) =>
    !!r && ["GENERAL_MANAGER", "BRANCH_MANAGER", "MANAGER"].includes(String(r).toUpperCase());
  return staffAll.filter((u: any) => {
    if (u.isActive === false || !memberIds.has(Number(u.id)) || excluded.has(Number(u.id))) return false;
    if (String(u.role).toUpperCase() === "OWNER") return wantOwner;
    if (!isManagerRole(u.role)) return false;
    return Number(u.assignedBusinessId) === Number(businessId) || granted.has(Number(u.id));
  });
}

// ─── Poultry stage-plan notifications ─────────────────────────────────────
// Both ride the same rails as every other bell notification: fanOut with
// per-user (type, recordRef) dedupe and OS-level push.

const CHECKLIST_MANAGER_ROLES = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER", "MANAGER"];

/** Announce a flock's production-stage change (BROODING → GROWER → …) to the
 *  business' managers. recordRef `poultry-stage:{flockId}:{stageKey}` makes
 *  each lifecycle crossing announce exactly once per recipient. */
export async function notifyPoultryStageTransition({
  flock,
  stage,
  businessId,
  branchCode,
}: {
  flock: { id: number; batchNumber: string; birdType: string };
  stage: { stageKey: string; label: string; birdType: string; ageDays: number; ageWeeks: number; transitionNote: string };
  businessId: number;
  branchCode?: string | null;
}): Promise<number> {
  const recipients = (await orderNotificationRecipients(businessId)).filter((u: any) =>
    CHECKLIST_MANAGER_ROLES.includes(String(u.role || "").toUpperCase())
  );
  if (!recipients.length) return 0;
  const ageTxt = String(stage.birdType).toUpperCase() === "LAYERS" ? `week ${stage.ageWeeks}` : `day ${stage.ageDays}`;
  return fanOut(recipients, {
    type: "POULTRY_STAGE",
    title: `${flock.batchNumber} → ${stage.label}`,
    body: `${flock.batchNumber} (${flock.birdType}) entered ${stage.label} at ${ageTxt} of age. ${stage.transitionNote}`,
    recordType: "CHECKLIST",
    recordId: flock.id,
    recordRef: `poultry-stage:${flock.id}:${stage.stageKey}`,
    businessId,
    branchCode: branchCode ?? null,
    actorName: "Checklist Engine",
    priority: "MEDIUM",
  });
}

/** End-of-day overdue sweep: incomplete CRITICAL tasks grouped PER FLOCK (or
 *  farm-wide group) so every notification is linked to the right flock — one
 *  bell row per (business, flock, date) to the managers and assignees. */
export async function notifyChecklistOverdue({
  businessId,
  branchCode,
  date,
  flock,
  tasks,
}: {
  businessId: number;
  branchCode?: string | null;
  date: string;
  flock?: { id: number; batchNumber: string } | null;
  tasks: {
    taskLabel: string;
    batchNumber?: string | null;
    stageLabel?: string | null;
    assignedToUserId?: number | null;
  }[];
}): Promise<number> {
  const all = await orderNotificationRecipients(businessId);
  const managers = all.filter((u: any) => CHECKLIST_MANAGER_ROLES.includes(String(u.role || "").toUpperCase()));
  const assignedIds = new Set(
    tasks.map((t) => Number(t.assignedToUserId)).filter((n) => Number.isFinite(n) && n > 0)
  );
  const assignees = all.filter((u: any) => assignedIds.has(Number(u.id)));
  const seen = new Set<number>();
  const recipients = [...managers, ...assignees].filter((u: any) => {
    const k = Number(u.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!recipients.length) return 0;
  const list = tasks
    .slice(0, 12)
    .map(
      (t) =>
        `• ${t.taskLabel}${t.stageLabel ? ` (${t.stageLabel})` : ""}`
    )
    .join("\n");
  const more = tasks.length > 12 ? `\n…and ${tasks.length - 12} more` : "";
  const who = flock?.batchNumber || "Farm-wide";
  return fanOut(recipients, {
    type: "CHECKLIST_OVERDUE",
    title: flock
      ? `Critical checklist overdue — ${flock.batchNumber} (${date})`
      : `Critical checklist overdue — ${branchCode || "business"} (${date})`,
    body: `${tasks.length} critical task(s) still incomplete for ${who}:\n${list}${more}`.slice(0, 600),
    recordType: "CHECKLIST",
    recordId: flock?.id ?? null,
    recordRef: `checklist-overdue:${businessId}:${flock?.id ?? "farm"}:${date}`,
    businessId,
    branchCode: branchCode ?? null,
    actorName: "Checklist Engine",
    priority: "HIGH",
  });
}
