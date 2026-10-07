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
import { platformRequestBellTitle, isPlatformRequestActionable } from "@/lib/platformRequests";
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
import { inRoleGroup } from "@/lib/roles";

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
  // Registry-owned unit-lead bench — the phantom "MANAGER" role this used to
  // match never existed in the database.
  const isManagerRole = (r: string | null | undefined) => inRoleGroup("UNIT_LEAD", r);
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
    inRoleGroup("CHECKLIST_MANAGER", u.role)
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
  const managers = all.filter((u: any) => inRoleGroup("CHECKLIST_MANAGER", u.role));
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

// ── R1 Approvals fan-out ──────────────────────────────────────────────────

const APPROVAL_ACTION_LABEL: Record<string, string> = {
  EXPENSE: "expense",
  PURCHASE_ORDER: "purchase order",
  PURCHASE_REQUISITION: "purchase requisition",
  INVENTORY_ADJUSTMENT: "stock adjustment",
  DISCOUNT: "discount",
  DELETION: "deletion",
  DATA_EXPORT: "data export",
};

/** Bell + push the entitled approvers that a gated record awaits their
 *  decision. recordRef `approval:{requestId}` keeps it one row per request.
 *  The caller (lib/approvals) resolves the approver recipients so this module
 *  never imports the approvals engine back. */
export async function notifyApprovalRequest({
  requestId,
  businessId,
  branchCode,
  action,
  targetLabel,
  amountGhs,
  actorName,
  recipients,
}: {
  requestId: number;
  businessId: number;
  branchCode?: string | null;
  action: string;
  targetLabel: string;
  amountGhs?: number | null;
  actorName?: string | null;
  ownerId?: number;
  recipients: { id: number }[];
}): Promise<number> {
  try {
    if (!recipients.length) return 0;
    const label = APPROVAL_ACTION_LABEL[String(action).toUpperCase()] || String(action).toLowerCase();
    const amountTxt =
      amountGhs != null && Number(amountGhs) > 0 ? ` (GH₵ ${Number(amountGhs).toFixed(2)})` : "";
    return fanOut(recipients, {
      type: "APPROVAL_REQUESTED",
      title: `Approval needed: ${label}`,
      body: `${actorName || "Staff"} requests approval for ${targetLabel}${amountTxt}. Decide in the Action Center → Approvals.`,
      recordType: "approval_requests",
      recordId: requestId,
      recordRef: `approval:${requestId}`,
      businessId,
      branchCode: branchCode ?? null,
      actorName: actorName ?? null,
      priority: "HIGH",
    });
  } catch (e) {
    console.error("[notify] notifyApprovalRequest failed:", e);
    return 0;
  }
}

/** Tell the requester the outcome of their gated record. */
export async function notifyApprovalDecision({
  requestId,
  businessId,
  branchCode,
  action,
  targetLabel,
  decision,
  decidedByName,
  reason,
  requesterUserId,
}: {
  requestId: number;
  businessId: number;
  branchCode?: string | null;
  action: string;
  targetLabel: string;
  decision: "APPROVED" | "REJECTED";
  decidedByName?: string | null;
  reason?: string | null;
  ownerId?: number;
  requesterUserId?: number | null;
}): Promise<number> {
  try {
    if (!requesterUserId) return 0;
    const label = APPROVAL_ACTION_LABEL[String(action).toUpperCase()] || String(action).toLowerCase();
    return fanOut([{ id: Number(requesterUserId) }], {
      type: "APPROVAL_DECIDED",
      title: `${decision === "APPROVED" ? "Approved" : "Rejected"}: ${label}`,
      body: `${decidedByName || "Approver"} ${decision === "APPROVED" ? "approved" : "rejected"} ${targetLabel}.${reason ? ` Note: ${reason}` : ""}`,
      recordType: "approval_requests",
      recordId: requestId,
      recordRef: `approval:${requestId}`,
      businessId,
      branchCode: branchCode ?? null,
      actorName: decidedByName ?? null,
      priority: decision === "APPROVED" ? "MEDIUM" : "HIGH",
    });
  } catch (e) {
    console.error("[notify] notifyApprovalDecision failed:", e);
    return 0;
  }
}

/** R3 dunning — bell + push the branch team about an overdue credit sale.
 *  Stages: T+1 gentle reminder, T+7 firm chase, T+30 final notice. */
export async function notifyDunning({
  businessId,
  branchCode,
  creditCode,
  customerName,
  customerPhone,
  balanceGhs,
  daysOverdue,
  stage,
}: {
  businessId: number;
  branchCode?: string | null;
  creditCode: string;
  customerName: string;
  customerPhone?: string | null;
  balanceGhs: number;
  daysOverdue: number;
  stage: "REMINDER" | "FIRM" | "FINAL";
}): Promise<void> {
  try {
    const recipients = await orderNotificationRecipients(businessId);
    const titles: Record<string, string> = {
      REMINDER: `Credit ${creditCode} is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past due`,
      FIRM: `Credit ${creditCode} — ${daysOverdue} days overdue, chase firmly`,
      FINAL: `Credit ${creditCode} — ${daysOverdue} days overdue: final notice before escalation`,
    };
    await fanOut(recipients, {
      type: "CREDIT_OVERDUE",
      title: titles[stage] || titles.REMINDER,
      body: `${customerName}${customerPhone ? ` (${customerPhone})` : ""} still owes GH₵ ${Number(balanceGhs).toFixed(2)} on credit sale ${creditCode}. ${
        stage === "REMINDER"
          ? "Send a friendly payment reminder today."
          : stage === "FIRM"
            ? "Call the customer and agree a settlement date."
            : "Issue the final notice and prepare for escalation (recovery / suspension of further credit)."
      }`,
      recordType: "credit-sales",
      recordId: null,
      recordRef: `dunning:${creditCode}:${stage}`,
      businessId,
      branchCode: branchCode ?? null,
      actorName: "Dunning sweep",
      priority: stage === "FINAL" ? "URGENT" : null,
    });
  } catch (e) {
    console.error("[notify] notifyDunning failed:", e);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   PLATFORM-LEVEL NOTIFICATIONS (Super Admin only)

   Every helper above is TENANT-scoped: `fanOut` requires a businessId and
   `orderNotificationRecipients` only ever returns members of that business's
   own organization. A platform registration request has no business and no
   tenant, so it needs its own, deliberately tiny path rather than a loosened
   version of the tenant one.

   Privacy: rows are written with businessId = null AND ownerId = null — they
   belong to no tenant. The bell (`GET /api/notifications`) returns only
   `userId = me`, so these are visible exclusively to the Super Admin(s), and
   no tenant can enumerate them.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every active platform Super Admin — the recipients of a platform request.
 * Mirrors `orderNotificationRecipients`' shape but is intentionally NOT
 * derived from any business or organization.
 */
export async function platformOwnerRecipients(): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, isActive: users.isActive, isSuperAdmin: users.isSuperAdmin })
    .from(users)
    .where(eq(users.isSuperAdmin, true));
  return rows
    .filter((u) => u.isActive !== false)
    .map((u) => ({ id: Number(u.id), name: u.name }));
}

/**
 * Bell + push the Super Admin(s) about a new platform request.
 *
 * Deduped on (userId, type, recordRef) exactly like `fanOut`, so a retry can
 * never double-notify. The notification body carries NO personal contact
 * details — the Super Admin opens the console to read the submission
 * (a lock screen is not the place for an applicant's phone number).
 */
export async function notifyPlatformRequest(request: {
  id: number;
  reference: string;
  purposeLabel: string;
  businessName?: string | null;
  contactName?: string | null;
}): Promise<number> {
  try {
    const recipients = await platformOwnerRecipients();
    if (!recipients.length) return 0;
    const recordRef = `platform-request:${request.reference}`;
    const title = "New platform request";
    const body = `${request.purposeLabel}${request.businessName ? ` — ${request.businessName}` : ""}${
      request.contactName ? ` (${request.contactName})` : ""
    } · ref ${request.reference}`;
    const pushedIds: number[] = [];
    for (const u of recipients) {
      const dupes = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, u.id),
            eq(notifications.type, "PLATFORM_REQUEST_NEW"),
            eq(notifications.recordRef, recordRef),
          ),
        )
        .limit(1);
      if (dupes.length) continue;
      await db.insert(notifications).values({
        userId: u.id,
        type: "PLATFORM_REQUEST_NEW",
        title,
        body,
        recordType: "platform-request",
        recordId: request.id,
        recordRef,
        businessId: null,
        branchCode: null,
        actorName: "Storefront",
        priority: "HIGH",
        ownerId: null, // platform scope — belongs to no tenant
      });
      pushedIds.push(u.id);
    }
    if (pushedIds.length) {
      // The URL carries the reference: a notification click (in-app bell or a
      // web-push click) opens the review console WITH that request expanded,
      // instead of dropping the operator on an unsorted queue.
      pushAfterBell(pushedIds, {
        type: "PLATFORM_REQUEST_NEW",
        title,
        body,
        url: urlForNotification("PLATFORM_REQUEST_NEW", { platformRequestRef: request.reference }),
      });
    }
    return pushedIds.length;
  } catch (e) {
    // A notification failure must never fail the applicant's submission.
    console.error("[notify] notifyPlatformRequest failed:", e);
    return 0;
  }
}

/**
 * Keep the bell TRUE as a request moves through its lifecycle.
 *
 * A platform request produces ONE bell row per Super Admin ("New platform
 * request"). Without this, approving or rejecting the request left that row
 * unread forever — the badge kept demanding attention for work already done,
 * and the title still claimed the request was new. Every decision now rewrites
 * the row's title/body to the current state, and marks it read as soon as
 * nothing is left to do. It never *un-reads* a row: an operator who has already
 * looked at a still-actionable request is not nagged again.
 *
 * @returns how many bell rows were updated
 */
export async function syncPlatformRequestBells(request: {
  reference: string;
  status: string;
  createdOrganizationId?: number | null;
  businessName?: string | null;
  contactName?: string | null;
  decisionReason?: string | null;
}): Promise<number> {
  try {
    const reference = String(request.reference || "").trim();
    if (!reference) return 0;
    const recordRef = `platform-request:${reference}`;
    const title = platformRequestBellTitle(request.status, request.createdOrganizationId);
    const actionable = isPlatformRequestActionable(request.status, request.createdOrganizationId);
    const body =
      `${request.businessName ? `${request.businessName} — ` : ""}${request.contactName || "Applicant"}` +
      ` · ref ${reference}` +
      (request.status ? ` · ${String(request.status).replace(/_/g, " ").toLowerCase()}` : "") +
      (request.status === "REJECTED" && request.decisionReason ? `: ${String(request.decisionReason).slice(0, 160)}` : "");
    const rows = await db
      .update(notifications)
      .set({ title, body, ...(actionable ? {} : { isRead: true }) })
      .where(and(eq(notifications.type, "PLATFORM_REQUEST_NEW"), eq(notifications.recordRef, recordRef)))
      .returning({ id: notifications.id });
    return rows.length;
  } catch (e) {
    // A bell refresh must never fail the operator's action.
    console.error("[notify] syncPlatformRequestBells failed:", e);
    return 0;
  }
}
