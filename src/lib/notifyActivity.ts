/**
 * ACTIVITY NOTIFICATIONS — the events the bell was silent about.
 *
 * The bell already carried workflow events (audit issues, approvals, orders,
 * purchases, credit dunning, checklist/stock sweeps, platform requests). A
 * whole class of *activity* was missing though: money moving (a sale, an
 * expense), stock falling through its reorder point, high-signal audit-trail
 * events and flagged daily notes. Those are the events the OWNER asked for.
 *
 * Design rules — the same three the rest of the bell follows:
 *
 *  1. NEVER BLOCK THE RECORD. Every helper swallows its own errors: a
 *     notification can never fail a sale, an expense or a stock movement.
 *  2. NO SPAM. Money activity is ROLLED UP per (business, kind, day) — one row
 *     that updates in place ("12 sales today · GH₵ 8,431") instead of one lock
 *     screen per transaction — and the OS push fires once per day. Stock
 *     alerts fire only on a real threshold CROSSING, once per item per day.
 *  3. NO DUPLICATES. Every row is deduped on (userId, type, recordRef) in SQL
 *     before insert, and the daily low-stock sweep skips items a crossing
 *     alert already told the team about today.
 *
 * Audience tiering (who sees what):
 *  • Money activity  → the org's OWNER / CO_OWNER / GENERAL_MANAGER who can
 *    reach that unit, minus whoever recorded it.
 *  • Stock alerts    → the unit's team (owner + assigned + granted staff),
 *    minus whoever moved the stock.
 *  • Audit events    → the org's OWNER / CO_OWNER: record deletions, money
 *    edits and permission/credential changes only (an allow-list, plus a
 *    24-hour rate cap so a bulk operation cannot storm the bell).
 *  • Flagged notes   → the unit's managers (and the OWNER for an URGENT note).
 */
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { canSeeFinancials } from "@/lib/permissions";
import { notifications, organizationMembers, userBusinessAccess, users } from "@/db/schema";
import { ownerOrgOfBusiness, orderNotificationRecipients } from "@/lib/notify";
import { orgRecipientUserIds } from "@/lib/bellAudience";
import { isWorkspacePrincipal, withoutSelf, workspaceAudience, workspacePrincipals, type BellRecipient } from "@/lib/bellAudience";
import { pushAfterBell } from "@/lib/push";
import { inRoleGroup } from "@/lib/roles";

export type MoneyActivityKind = "SALE" | "EXPENSE";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);

/** Roles that watch the money of a unit. */
/**
 * Unit leads who do NOT hold the finance grant. They still need to know that
 * sales/expenses were RECORDED at their unit (their operation), so they get a
 * separate, AMOUNT-FREE heads-up — never the GH₵ figures, which stay behind
 * `canSeeFinancials()` (Enterprise financial-access hardening).
 */

/**
 * The org's money watchers who can reach `businessId` — OWNER/CO_OWNER/GM
 * members of the business's organization, resolved from the DB (never from a
 * request body). Owned units are reachable by the whole executive bench of
 * their organization; a unit-level assignment/grant is additionally honoured
 * so the helper stays correct if executives gain narrower scopes.
 */
export async function moneyActivityRecipients(businessId: number): Promise<BellRecipient[]> {
  // Reachability is the canonical workspace rule (bellAudience.ts); this adds
  // exactly ONE policy on top — the roll-up carries GH₵ figures, so it also
  // requires financial visibility (an OWNER is always finance-visible). It used
  // to re-derive reachability by hand, which is how this copy drifted away
  // from the scoping the rest of the app obeys.
  const audience = await workspaceAudience(businessId);
  return audience.filter((u) => {
    const role = String(u.role || "").toUpperCase();
    if (!inRoleGroup("MONEY_WATCHER", role)) return false;
    if (role === "OWNER" || role === "CO_OWNER" || u.isSuperAdmin) return true;
    return canSeeFinancials(u as any);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. MONEY ACTIVITY — sales & expenses, rolled up per business/day.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Tell the unit's money watchers about a recorded sale or expense.
 *
 * One bell row per (recipient, kind, business, day): the first transaction of
 * the day inserts it (and pushes once); every later one UPDATES the same row
 * with the running count and total, so a busy till produces ONE current line
 * instead of hundreds of alerts. Read state is never reset — updating a row is
 * not a new demand on anyone's attention, and the figure stays fresh when the
 * OWNER opens the bell.
 *
 * @returns how many rows were inserted for the first time
 */
export async function notifyMoneyActivity(input: {
  businessId: number;
  branchCode?: string | null;
  kind: MoneyActivityKind;
  amountGhs: number;
  actorName?: string | null;
  actorUserId?: number | null;
  /** Human reference of the underlying record (TRX-…, INV-…), used in the body. */
  recordRef?: string | null;
  recordId?: number | null;
  recordType?: string | null;
  label?: string | null;
}): Promise<number> {
  try {
    const businessId = Number(input.businessId);
    if (!businessId) return 0;
    const amount = round2(input.amountGhs);
    if (!(amount > 0)) return 0; // zero-amount rows are operational logs, not money
    const kind = input.kind === "EXPENSE" ? "EXPENSE" : "SALE";
    const day = todayISO();
    const dateKey = `money-day:${businessId}:${kind}:${day}`;
    const type = kind === "SALE" ? "SALE_RECORDED" : "EXPENSE_RECORDED";
    const label = kind === "SALE" ? "sales" : "expenses";
    const where = input.label ? ` — ${input.label}` : "";

    // withoutSelf keeps the OWNER / Super Admin in: their bell is the
    // complete record of their workspace, so "you did not see this because you
    // were the one who did it" is exactly the silent hole this closes. Everyone
    // else is still spared their own keystrokes.
    const recipients = withoutSelf(await moneyActivityRecipients(businessId), input.actorUserId);
    if (!recipients.length) return 0;

    let inserted = 0;
    const freshIds: number[] = [];
    let runningTotal = amount;
    let runningCount = 1;

    for (const r of recipients) {
      const [existing] = await db
        .select({ id: notifications.id, body: notifications.body })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(r.id)),
            eq(notifications.type, type),
            eq(notifications.recordRef, dateKey),
          ),
        )
        .limit(1);

      if (existing) {
        // Roll the day's line forward: parse the count/total the previous pass
        // stored (they are the only numbers in the body's first line).
        const m = /^(\d+) .*GH₵ ([\d,.]+)/.exec(String(existing.body || ""));
        runningCount = (m ? Number(m[1]) : 1) + 1;
        runningTotal = round2((m ? Number(String(m[2]).replace(/,/g, "")) : 0) + amount);
        await db
          .update(notifications)
          .set({
            title: moneyTitle(kind, runningCount, runningTotal),
            body: moneyBody(kind, runningCount, runningTotal, input.actorName, day, where),
          })
          .where(eq(notifications.id, existing.id));
        continue;
      }

      await db.insert(notifications).values({
        userId: Number(r.id),
        type,
        title: moneyTitle(kind, 1, amount),
        body: moneyBody(kind, 1, amount, input.actorName, day, where),
        recordType: input.recordType ?? "transactions",
        recordId: input.recordId ?? null,
        recordRef: dateKey,
        businessId,
        branchCode: input.branchCode ?? null,
        actorName: input.actorName ?? null,
        priority: kind === "EXPENSE" ? "MEDIUM" : null,
        ownerId: (await ownerOrgOfBusiness(businessId)) ?? null,
      });
      inserted++;
      freshIds.push(Number(r.id));
      runningCount = 1;
      runningTotal = amount;
    }

    // ── The unit's operational leads: AMOUNT-FREE heads-up ────────────────
    // A branch manager without the finance grant must still know records are
    // being entered at their unit; they must not see the GH₵ figures. One row
    // per unit/day/kind, never carrying an amount.
    let opsSent = 0;
    try {
      const leads = withoutSelf(await unitActivityRecipients(businessId), input.actorUserId);
      if (leads.length) {
        const opsRef = `ops-money-day:${businessId}:${kind}:${day}`;
        const unitTag = input.branchCode ? ` — ${input.branchCode}` : "";
        const opsTitle = kind === "SALE" ? `Sales recorded${unitTag}` : `Expense recorded${unitTag}`;
        const freshLeadIds: number[] = [];
        for (const lead of leads) {
          const [seen] = await db
            .select({ id: notifications.id, body: notifications.body })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, Number(lead.id)),
                eq(notifications.type, type),
                eq(notifications.recordRef, opsRef),
              ),
            )
            .limit(1);
          if (seen) {
            const prev = Number(/^(\d+)/.exec(String(seen.body || ""))?.[1] || 0);
            await db
              .update(notifications)
              .set({
                title: `${opsTitle} — ${prev + 1} today`,
                body: `${prev + 1} ${label} recorded today by ${input.actorName || "staff"}. Amounts are restricted to finance-authorized users; open Transactions to review the entries.`,
              })
              .where(eq(notifications.id, Number(seen.id)));
            continue;
          }
          await db.insert(notifications).values({
            userId: Number(lead.id),
            type,
            title: `${opsTitle} — 1 today`,
            body: `1 ${kind === "SALE" ? "sale" : "expense"} recorded today by ${input.actorName || "staff"}. Amounts are restricted to finance-authorized users; open Transactions to review the entries.`,
            recordType: input.recordType ?? "transactions",
            recordId: input.recordId ?? null,
            recordRef: opsRef,
            businessId,
            branchCode: input.branchCode ?? null,
            actorName: input.actorName ?? null,
            priority: null,
            ownerId: (await ownerOrgOfBusiness(businessId)) ?? null,
          });
          freshLeadIds.push(Number(lead.id));
          opsSent++;
        }
        if (freshLeadIds.length) {
          pushAfterBell(freshLeadIds, {
            type,
            title: opsTitle,
            body: `${label} were recorded at your unit today. Open Transactions to review.`,
            url: input.branchCode ? `/?tab=${encodeURIComponent(input.branchCode)}` : "/?tab=TRANSACTIONS",
          });
        }
      }
    } catch (e) {
      console.error("[notify] unit money heads-up failed:", e);
    }

    // Push at most once per (recipient, kind, day): a lock screen is for
    // attention, not for arithmetic. Later transactions update the bell only.
    if (freshIds.length) {
      pushAfterBell(freshIds, {
        type,
        title: moneyTitle(kind, runningCount, runningTotal),
        body: moneyBody(kind, runningCount, runningTotal, input.actorName, day, where),
        url: input.branchCode ? `/?tab=${encodeURIComponent(input.branchCode)}` : "/?tab=COMMAND_CENTER",
      });
    }
    return inserted + opsSent;
  } catch (e) {
    console.error("[notify] notifyMoneyActivity failed:", e);
    return 0;
  }
}

const moneyTitle = (kind: MoneyActivityKind, count: number, total: number) =>
  kind === "SALE"
    ? `Today's sales: ${count} · GH₵ ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
    : `Today's expenses: ${count} · GH₵ ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const moneyBody = (
  kind: MoneyActivityKind,
  count: number,
  total: number,
  actorName: string | null | undefined,
  day: string,
  where: string,
) =>
  `${count} ${kind === "SALE" ? "sale" : "expense"}${count === 1 ? "" : "s"} recorded on ${day}${where} — ` +
  `GH₵ ${total.toFixed(2)} in total. Latest by ${actorName || "staff"}. ` +
  `Open the ${kind === "SALE" ? "Sales & Payments" : "Financial"} ledger for the detail.`;

/* ────────────────────────────────────────────────────────────────────────────
 * 2. STOCK THRESHOLD CROSSINGS — the moment an item falls to/below its
 *    reorder point (or hits zero). Fired by the single stock writer, so every
 *    module (sales, adjustments, production, waste, purchases) is covered.
 * ──────────────────────────────────────────────────────────────────────────── */

export async function notifyStockThresholdCrossing(input: {
  businessId: number;
  branchCode?: string | null;
  inventoryId: number;
  variantId?: number | null;
  itemName: string;
  sku?: string | null;
  unit?: string | null;
  quantityAfter: number;
  /** Status before the movement (IN_STOCK | LOW_STOCK | OUT_OF_STOCK | null). */
  fromStatus?: string | null;
  /** Status after the movement. */
  toStatus: string;
  threshold?: number | null;
  actorName?: string | null;
  actorUserId?: number | null;
  reason?: string | null;
}): Promise<number> {
  try {
    const businessId = Number(input.businessId);
    const to = String(input.toStatus || "").toUpperCase();
    if (!businessId || (to !== "LOW_STOCK" && to !== "OUT_OF_STOCK")) return 0;

    // Only a real CROSSING from a healthy state alerts: an item that stays low
    // (or stays out) all day must not re-alert on every movement.
    const from = String(input.fromStatus || "IN_STOCK").toUpperCase();
    if (from === "OUT_OF_STOCK") return 0;
    if (to === "LOW_STOCK" && from === "LOW_STOCK") return 0;

    const day = todayISO();
    const variantPart = input.variantId != null ? `:v${Number(input.variantId)}` : "";
    const recordRef = `stock-alert:${Number(input.inventoryId)}${variantPart}:${day}`;
    const type = to === "OUT_OF_STOCK" ? "STOCK_OUT" : "STOCK_LOW";

    const recipients = withoutSelf(await orderNotificationRecipients(businessId), input.actorUserId);
    if (!recipients.length) return 0;

    const qty = Number(input.quantityAfter) || 0;
    const threshold = input.threshold != null ? Number(input.threshold) : null;
    const title =
      to === "OUT_OF_STOCK"
        ? `Out of stock: ${input.itemName}`
        : `Low stock: ${input.itemName}`;
    const body =
      to === "OUT_OF_STOCK"
        ? `${input.itemName}${input.sku ? ` (${input.sku})` : ""} is now at ZERO after ${Number(input.reason || "a movement").toString().toLowerCase().replace(/_/g, " ")} by ${input.actorName || "staff"}. Raise a purchase order in Procurement to restock.`
        : `${input.itemName}${input.sku ? ` (${input.sku})` : ""} fell to ${qty} ${input.unit || "unit"}(s)${threshold != null ? ` (reorder point ${threshold})` : ""} after ${Number(input.reason || "a movement").toString().toLowerCase().replace(/_/g, " ")} by ${input.actorName || "staff"}. Restock soon to avoid a stock-out.`;

    let sent = 0;
    const escalatedIds: number[] = [];
    const freshIds: number[] = [];
    const ownerId = (await ownerOrgOfBusiness(businessId)) ?? null;
    for (const u of recipients) {
      // One row per item (per recipient) per day: the day's story is the row.
      const [existingRow] = await db
        .select({ id: notifications.id, type: notifications.type })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(u.id)),
            eq(notifications.recordRef, recordRef),
            inArray(notifications.type, ["STOCK_LOW", "STOCK_OUT"]),
          ),
        )
        .limit(1);
      if (existingRow) {
        if (String(existingRow.type) === type) continue; // same news twice
        // ESCALATION (LOW_STOCK → OUT_OF_STOCK) is new, worse news: upgrade the
        // day's row in place and re-surface it, rather than inserting a dupe.
        await db
          .update(notifications)
          .set({
            type,
            title: title.slice(0, 240),
            body: body.slice(0, 600),
            priority: "HIGH",
            isRead: false,
            createdAt: new Date(),
          })
          .where(eq(notifications.id, Number(existingRow.id)));
        escalatedIds.push(Number(u.id));
        sent++;
        continue;
      }
      await db.insert(notifications).values({
        userId: Number(u.id),
        type,
        title: title.slice(0, 240),
        body: body.slice(0, 600),
        recordType: "inventory_items",
        recordId: Number(input.inventoryId),
        recordRef,
        businessId,
        branchCode: input.branchCode ?? null,
        actorName: input.actorName ?? null,
        priority: to === "OUT_OF_STOCK" ? "HIGH" : "MEDIUM",
        ownerId,
      });
      freshIds.push(Number(u.id));
      sent++;
    }
    if (escalatedIds.length) {
      // A stock-out is the one stock message worth a lock-screen buzz even if
      // the morning's low-stock push already went out.
      pushAfterBell(escalatedIds, { type, title, body, url: input.branchCode ? `/?tab=${encodeURIComponent(input.branchCode)}` : "/?tab=INVENTORY" });
    }
    if (freshIds.length) {
      pushAfterBell(
        freshIds,
        {
          type,
          title,
          body,
          url: input.branchCode ? `/?tab=${encodeURIComponent(input.branchCode)}` : "/?tab=INVENTORY",
        },
      );
    }
    return sent;
  } catch (e) {
    console.error("[notify] notifyStockThresholdCrossing failed:", e);
    return 0;
  }
}

/** True when a threshold-crossing alert already exists for this item today —
 *  used by the daily low-stock sweep so the team is told once, not twice. */
export async function stockAlertedToday(inventoryId: number, day = todayISO()): Promise<boolean> {
  try {
    // The ref is `stock-alert:{id}[:v{variantId}]:{day}` — the leading colon
    // keeps item 12 from matching item 120's alert.
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        sql`${notifications.recordRef} like ${`stock-alert:${Number(inventoryId)}:%`}
            and ${notifications.recordRef} like ${`%:${day}`}`,
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. HIGH-SIGNAL AUDIT EVENTS — what the audit trail should ring the bell
 *    about: a record DELETED, a money record EDITED, a permission or
 *    credential changed. Everything else stays in the trail (silent) so the
 *    bell keeps meaning "something needs you".
 * ──────────────────────────────────────────────────────────────────────────── */

/** Actions worth a bell row (matched case-insensitively, substring). */
const AUDIT_EVENT_ACTIONS = [
  "DELETE",
  "REMOVE",
  "PASSWORD",
  "PERMISSION",
  "GRANT",
  "REVOKE",
  "RESET",
  "ROLE_CHANGE",
  // Security-relevant account actions: disabling a staff account, suspending
  // one, locking it or forcing a logout all change who can reach the data.
  "DISABLE",
  "SUSPEND",
  "LOCK",
  "FORCE_LOGOUT",
];
/** Record types whose EDITS are financial/structural enough to alert on. */
const AUDIT_EVENT_EDIT_TARGETS = ["transactions", "assets", "payroll", "employees", "budgets"];
/** Never alert on these — they are workflow noise, already notified elsewhere. */
const AUDIT_EVENT_SKIP = ["LOGIN", "VIEW", "EXPORT", "PRINT"];

export function isHighSignalAuditEvent(
  action: string,
  targetType?: string | null,
  /** Optional second entity hint — writers differ on which field carries it. */
  recordType?: string | null,
): boolean {
  const a = String(action || "").toUpperCase();
  const t = `${String(targetType || "").toLowerCase()} ${String(recordType || "").toLowerCase()}`;
  if (!a) return false;
  if (AUDIT_EVENT_SKIP.some((s) => a.includes(s))) return false;
  if (AUDIT_EVENT_ACTIONS.some((s) => a.includes(s))) return true;
  const isEdit = a.includes("UPDATE") || a.includes("EDIT") || a.includes("EDIT_") || a.includes("_EDIT");
  return isEdit && AUDIT_EVENT_EDIT_TARGETS.some((x) => t.includes(x));
}

/**
 * Bell + push the OWNER/CO_OWNER about a high-signal audit-trail event.
 * Deduped per (recipient, action, record) and capped at
 * `AUDIT_EVENT_DAILY_CAP` rows per recipient per 24 h, so a bulk delete cannot
 * fill the bell (the trail still holds every row).
 */
export async function notifyAuditEvent(input: {
  actorName?: string | null;
  actorUserId?: number | null;
  action: string;
  targetType?: string | null;
  targetLabel?: string | null;
  recordType?: string | null;
  recordId?: number | null;
  businessId?: number | null;
  branchCode?: string | null;
  detail?: string | null;
  ownerId?: number | null;
}): Promise<number> {
  try {
    const action = String(input.action || "").toUpperCase();
    if (!isHighSignalAuditEvent(action, input.targetType, input.recordType)) return 0;
    const businessId = input.businessId != null ? Number(input.businessId) : null;

    // Audience: the principals of the business's own workspace (OWNER /
    // CO_OWNER / platform Super Admin) — resolved through the canonical
    // workspace rule rather than a hand-rolled membership read.
    let recipients: { id: number; name: string | null; role: string | null; isSuperAdmin: boolean }[];
    let orgId: number | null = input.ownerId != null ? Number(input.ownerId) : null;
    if (businessId != null) {
      orgId = (await ownerOrgOfBusiness(businessId)) ?? orgId;
      recipients = await workspacePrincipals(businessId);
    } else {
      // Platform-level rows (permission flips, delegations, approval-policy
      // edits) carry no business, so fall back to the tenant they name. With
      // neither there is no tenant to alert.
      if (!orgId) return 0;
      const memberIds = [...(await orgRecipientUserIds(orgId))];
      if (!memberIds.length) return 0;
      const staff = await db
        .select({
          id: users.id, name: users.name, role: users.role,
          isActive: users.isActive, isSuperAdmin: users.isSuperAdmin,
        })
        .from(users)
        .where(inArray(users.id, memberIds));
      recipients = staff
        .filter((u) => u.isActive !== false && isWorkspacePrincipal(u))
        .map((u) => ({ id: Number(u.id), name: u.name, role: u.role, isSuperAdmin: u.isSuperAdmin === true }));
    }
    // The Owner is NOT excluded from their own audit trail: a deletion or a
    // permission change they performed is still the single most important row
    // their workspace has to show them.
    if (!recipients.length) return 0;

    const recordPart = `${input.recordType || input.targetType || "record"}:${input.recordId ?? input.targetLabel ?? "-"}`;
    const recordRef = `audit-event:${action}:${recordPart}`;
    const since = new Date(Date.now() - 86400_000);
    const title = auditEventTitle(action, input.targetLabel, input.recordType || input.targetType);
    const body =
      `${input.actorName || "Staff"} ${auditEventVerb(action)} ${input.targetLabel || input.recordType || "a record"}` +
      (businessId != null ? ` on business #${businessId}` : "") +
      `${input.detail ? ` — ${String(input.detail).slice(0, 220)}` : ""}. ` +
      `Open Audit & Review to see the trail entry.`;

    let sent = 0;
    // Rows the cap held back, per recipient. Silently dropping them is how an
    // Owner loses sight of a deletion with no trace anywhere in the bell — the
    // one thing this bell exists to prevent — so they are summarised below.
    const held = new Map<number, number>();
    // The roll-up row's ref, computed up front because the CAP COUNT below must
    // be able to exclude it.
    const capRef = `audit-event:cap:${new Date(since.getTime()).toISOString().slice(0, 10)}`;
    for (const r of recipients) {
      const uid = Number(r.id);
      const [dupe] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, uid),
            eq(notifications.type, "AUDIT_EVENT"),
            eq(notifications.recordRef, recordRef),
          ),
        )
        .limit(1);
      if (dupe) continue;
      // Rate cap: a bulk operation must not storm the bell.
      //
      // The cap-summary row is EXCLUDED. It used to be counted like any other
      // event, which made the cap self-sustaining: once a recipient reached the
      // ceiling, every suppressed event wrote or refreshed the summary row, and
      // that row kept the 24 h count at or above the ceiling on its own. The
      // Owner could then be permanently silenced about deletions and permission
      // changes — the exact events this bell exists to carry — until the window
      // rolled over on its own. A roll-up is not an event and must not consume
      // the budget it reports on.
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, uid),
            eq(notifications.type, "AUDIT_EVENT"),
            gte(notifications.createdAt, since),
            ne(notifications.recordRef, capRef),
          ),
        );
      if (Number(c) >= AUDIT_EVENT_DAILY_CAP) {
        held.set(uid, (held.get(uid) || 0) + 1);
        continue;
      }
      await db.insert(notifications).values({
        userId: uid,
        type: "AUDIT_EVENT",
        title: title.slice(0, 240),
        body: body.slice(0, 600),
        recordType: input.recordType ?? input.targetType ?? null,
        recordId: input.recordId ?? null,
        recordRef,
        businessId,
        branchCode: input.branchCode ?? null,
        actorName: input.actorName ?? null,
        priority: action.includes("DELETE") || action.includes("REMOVE") ? "HIGH" : "MEDIUM",
        ownerId: Number(orgId),
      });
      sent++;
    }
    // One summary row per recipient per day, carrying the running total — so a
    // capped recipient always knows there is more to read in the trail, and
    // never more than one extra row to read.
    for (const [uid, n] of held) {
      const capTitle = `${n} more audited change${n === 1 ? "" : "s"} not itemised`;
      const [existing] = await db
        .select({ id: notifications.id, body: notifications.body })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, uid),
            eq(notifications.type, "AUDIT_EVENT"),
            eq(notifications.recordRef, capRef),
          ),
        )
        .limit(1);
      if (existing) {
        const prev = Number(String(existing.body || "").split(" ")[0]) || 0;
        await db
          .update(notifications)
          .set({ body: `${prev + n} further audited changes were not itemised. Open Audit & Review to see the trail.` })
          .where(eq(notifications.id, existing.id));
      } else {
        await db.insert(notifications).values({
          userId: uid,
          type: "AUDIT_EVENT",
          title: capTitle,
          body: `${n} further audited changes were not itemised. Open Audit & Review to see the trail.`,
          recordType: null,
          recordId: null,
          recordRef: capRef,
          businessId,
          branchCode: input.branchCode ?? null,
          actorName: null,
          priority: "MEDIUM",
          ownerId: orgId == null ? null : Number(orgId),
        });
      }
    }
    if (sent || held.size) {
      pushAfterBell(
        recipients.map((r) => Number(r.id)),
        {
          type: "AUDIT_EVENT",
          title,
          body,
          url: "/?tab=AUDIT",
        },
      );
    }
    return sent;
  } catch (e) {
    console.error("[notify] notifyAuditEvent failed:", e);
    return 0;
  }
}

/**
 * Max itemised AUDIT_EVENT rows per recipient per 24 h (the trail keeps the
 * rest, and the roll-up row counts toward nothing).
 *
 * This was 12, which a single busy workspace exhausts on ordinary activity —
 * the seeded demo alone produces enough block-mix and flock events to reach it
 * before a single deletion happens. A cap that routinely silences deletions,
 * salary edits and permission changes is worse than no cap: the bell looks
 * healthy while the events that matter are being dropped. The roll-up row is
 * what actually bounds the bell, so the ceiling can afford to be generous.
 */
export const AUDIT_EVENT_DAILY_CAP = 40;

const auditEventVerb = (action: string) => {
  const a = action.toUpperCase();
  if (a.includes("DELETE") || a.includes("REMOVE")) return "deleted";
  if (a.includes("DISABLE")) return "disabled";
  if (a.includes("FORCE_LOGOUT")) return "forced a logout of";
  if (a.includes("SUSPEND")) return "suspended";
  if (a.includes("PASSWORD")) return "changed the password of";
  if (a.includes("PERMISSION") || a.includes("GRANT") || a.includes("REVOKE") || a.includes("ROLE")) return "changed the access of";
  if (a.includes("RESET")) return "reset";
  return "edited";
};

const auditEventTitle = (action: string, label: string | null | undefined, target: string | null | undefined) => {
  const what = label || target || "record";
  const a = action.toUpperCase();
  if (a.includes("DELETE") || a.includes("REMOVE")) return `Record deleted: ${what}`;
  if (a.includes("DISABLE")) return `Account disabled: ${what}`;
  if (a.includes("FORCE_LOGOUT")) return `Session forced out: ${what}`;
  if (a.includes("SUSPEND")) return `Account suspended: ${what}`;
  if (a.includes("PASSWORD")) return `Password changed: ${what}`;
  if (a.includes("PERMISSION") || a.includes("GRANT") || a.includes("REVOKE") || a.includes("ROLE")) return `Access changed: ${what}`;
  return `Record edited: ${what}`;
};

/* ────────────────────────────────────────────────────────────────────────────
 * 4. FLAGGED OPERATIONAL NOTES — a daily note the AI read as WATCH/URGENT is
 *    a supervisor observation worth escalating; an INFO note stays a log.
 * ──────────────────────────────────────────────────────────────────────────── */

export async function notifyOpsNoteFlagged(input: {
  businessId: number;
  branchCode?: string | null;
  noteId: number;
  noteDate: string;
  severity: "WATCH" | "URGENT";
  actorName?: string | null;
  actorUserId?: number | null;
  summary?: string | null;
  flags?: string[] | null;
  excerpt?: string | null;
}): Promise<number> {
  try {
    const businessId = Number(input.businessId);
    if (!businessId) return 0;
    // Unit managers always; the OWNER too when the note is URGENT (the audit
    // escalation pattern — MEDIUM ⇒ managers, HIGH ⇒ + owner).
    const { auditEscalationRecipients } = await import("@/lib/notify");
    const recipients = await auditEscalationRecipients(
      businessId,
      input.severity === "URGENT" ? "HIGH" : "MEDIUM",
      { excludeIds: [input.actorUserId ?? null] },
    );
    if (!recipients.length) return 0;
    const recordRef = `ops-note:${Number(input.noteId)}`;
    const title = `${input.severity === "URGENT" ? "Urgent" : "Watch"} daily note${input.branchCode ? ` — ${input.branchCode}` : ""}: ${input.summary || input.noteDate}`;
    const body =
      `${input.actorName || "Staff"} filed the ${input.noteDate} note` +
      `${input.flags?.length ? ` (${input.flags.slice(0, 4).join(", ")})` : ""}: ` +
      `${String(input.excerpt || input.summary || "").slice(0, 380)} — review it in the branch dashboard.`;
    let sent = 0;
    for (const r of recipients) {
      const [dupe] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, Number(r.id)),
            eq(notifications.type, "OPS_NOTE_FLAGGED"),
            eq(notifications.recordRef, recordRef),
          ),
        )
        .limit(1);
      if (dupe) continue;
      await db.insert(notifications).values({
        userId: Number(r.id),
        type: "OPS_NOTE_FLAGGED",
        title: title.slice(0, 240),
        body: body.slice(0, 600),
        recordType: "daily_notes",
        recordId: Number(input.noteId),
        recordRef,
        businessId,
        branchCode: input.branchCode ?? null,
        actorName: input.actorName ?? null,
        priority: input.severity === "URGENT" ? "HIGH" : "MEDIUM",
        ownerId: (await ownerOrgOfBusiness(businessId)) ?? null,
      });
      sent++;
    }
    if (sent) {
      pushAfterBell(
        recipients.map((r) => Number(r.id)),
        {
          type: "OPS_NOTE_FLAGGED",
          title,
          body,
          url: input.branchCode ? `/?tab=${encodeURIComponent(input.branchCode)}` : "/?tab=COMMAND_CENTER",
        },
      );
    }
    return sent;
  } catch (e) {
    console.error("[notify] notifyOpsNoteFlagged failed:", e);
    return 0;
  }
}

/**
 * A record was permanently deleted. The deletion log is the audit record, so
 * this wraps notifyAuditEvent with the DELETE semantics (HIGH priority) and
 * names the module + reason in the message.
 */
export async function notifyRecordDeletion(input: {
  module: string;
  recordLabel: string;
  reason?: string | null;
  deletedByName?: string | null;
  deletedByUserId?: number | null;
  businessId?: number | null;
  branchCode?: string | null;
  ownerId?: number | null;
}): Promise<number> {
  return notifyAuditEvent({
    actorName: input.deletedByName ?? null,
    actorUserId: input.deletedByUserId ?? null,
    action: "DELETE",
    targetType: String(input.module || "RECORD").toUpperCase(),
    targetLabel: input.recordLabel,
    recordType: String(input.module || "").toLowerCase() || null,
    recordId: null,
    businessId: input.businessId ?? null,
    branchCode: input.branchCode ?? null,
    detail: input.reason ? `Reason: ${input.reason}` : null,
    ownerId: input.ownerId ?? null,
  });
}

/**
 * The unit's operational leads who may NOT see money figures: they get the
 * amount-free "records were entered" heads-up. Deliberately tighter than
 * orderNotificationRecipients() — workers are not money recipients at all.
 */
export async function unitActivityRecipients(businessId: number): Promise<BellRecipient[]> {
  // Deliberately tighter than moneyActivityRecipients: these leads may NOT see
  // money figures, so workers are not recipients at all, and anyone who
  // already gets the real roll-up must not also get an amount-free stub.
  const audience = await workspaceAudience(businessId);
  return audience.filter((u) => {
    const role = String(u.role || "").toUpperCase();
    if (!inRoleGroup("UNIT_LEAD", role)) return false;
    if (role === "OWNER" || role === "CO_OWNER" || u.isSuperAdmin) return false;
    if (canSeeFinancials(u as any)) return false;
    return true;
  });
}

/** Every type this module emits — exported for the UI contract + the suite. */
export const ACTIVITY_NOTIFICATION_TYPES = [
  "SALE_RECORDED",
  "EXPENSE_RECORDED",
  "STOCK_LOW",
  "STOCK_OUT",
  "AUDIT_EVENT",
  "OPS_NOTE_FLAGGED",
] as const;
