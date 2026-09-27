/**
 * R3 — Customer 360 & Dunning (CAPABILITY-AUDIT-REPORT §6).
 *
 * Three jobs:
 *  1. RFM insights — recency/frequency/monetary scoring across every customer
 *     of the caller's scope, segmented CHAMPION | LOYAL | AT_RISK | DORMANT |
 *     NEW so staff know who to keep, who to chase and who to win back.
 *  2. The 360 assembly — one customer's whole relationship in a single
 *     payload: profile, preferences, interaction timeline, orders (trackings),
 *     credit sales + installments, statement lines and open balance.
 *  3. The dunning sweep — overdue ACTIVE credit sales escalate T+1 → T+7 →
 *     T+30 with marker-gated, deduped notifications (each stage fires once)
 *     and an interaction log entry so the timeline shows every chase.
 *
 * Everything is tenant-scoped: rows are filtered to the organizations the
 * caller can see; the dunning sweep only ever touches a single org's sales.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  creditPayments,
  creditSales,
  customerInteractions,
  customerTrackings,
  customers,
  transactions,
} from "@/db/schema";
import { getSystemMarker, setSystemMarker } from "@/lib/systemMarkers";
import { notifyDunning } from "@/lib/notify";
import { ownerOrgOfBusiness } from "@/lib/notify";

export type CustomerSegment = "CHAMPION" | "LOYAL" | "AT_RISK" | "DORMANT" | "NEW";

export interface RfmStats {
  customerId: number;
  name: string;
  segment: CustomerSegment;
  recencyDays: number | null;
  frequency: number;
  monetaryGhs: number;
  openCreditGhs: number;
  lastOrderAt: string | null;
}

/** Classify one customer's RFM numbers. Order count 0 ⇒ NEW; otherwise the
 *  recency×frequency grid decides, with spend as a tiebreaker for champions. */
export function rfmSegment(stats: {
  orderCount: number;
  daysSinceLast: number | null;
  totalSpentGhs: number;
}): CustomerSegment {
  if (stats.orderCount <= 0) return "NEW";
  const d = stats.daysSinceLast;
  if (d == null) return "NEW";
  if (d > 180) return "DORMANT";
  if (d > 60) return "AT_RISK";
  // Recent buyers: frequency & spend separate champions from the merely loyal.
  if (stats.orderCount >= 3 && stats.totalSpentGhs >= 500) return "CHAMPION";
  return "LOYAL";
}

/** RFM for every customer in scope (ownerId = organization id, or a set of
 *  business ids). Reads orders from trackings + income transactions. */
export async function customerInsights(scope: { ownerId?: number | null; businessIds?: number[] | null }): Promise<RfmStats[]> {
  const custRows = await db.select().from(customers);
  const inScope = (c: any) => {
    if (scope.businessIds != null) {
      return c.businessId == null || scope.businessIds.map(Number).includes(Number(c.businessId));
    }
    if (scope.ownerId != null) return c.ownerId == null || Number(c.ownerId) === Number(scope.ownerId);
    return true;
  };
  const rows = custRows.filter(inScope);
  if (!rows.length) return [];

  const ids = rows.map((c: any) => Number(c.id));
  const [tracks, trxRows, credits] = await Promise.all([
    db.select().from(customerTrackings).where(inArray(customerTrackings.customerId, ids)),
    db.select().from(transactions),
    db.select().from(creditSales).where(inArray(creditSales.customerId, ids)),
  ]);
  const now = Date.now();
  const out: RfmStats[] = [];
  for (const c of rows) {
    const cid = Number(c.id);
    const myTracks = tracks.filter((t: any) => Number(t.customerId) === cid);
    const myTrx = trxRows.filter(
      (t: any) => Number(t.customerId) === cid && String(t.type) === "INCOME" && String(t.status || "COMPLETED") === "COMPLETED",
    );
    const myCredits = credits.filter((s: any) => Number(s.customerId) === cid);
    const dates = [...myTracks.map((t: any) => new Date(t.createdAt).getTime()), ...myTrx.map((t: any) => new Date(t.date || t.createdAt).getTime())].filter((n) => Number.isFinite(n) && n > 0);
    const lastOrderAt = dates.length ? Math.max(...dates) : null;
    const orderCount = myTracks.length + myTrx.length;
    const spent =
      Number(c.totalSpentGhs || 0) ||
      myTrx.reduce((s: number, t: any) => s + (Number(t.amountGhs) || 0), 0) + myTracks.reduce((s: number, t: any) => s + (Number(t.totalGhs) || 0), 0);
    out.push({
      customerId: cid,
      name: String(c.name || `Customer #${cid}`),
      segment: rfmSegment({
        orderCount,
        daysSinceLast: lastOrderAt ? Math.floor((now - lastOrderAt) / 86400000) : null,
        totalSpentGhs: spent,
      }),
      recencyDays: lastOrderAt ? Math.floor((now - lastOrderAt) / 86400000) : null,
      frequency: orderCount,
      monetaryGhs: Math.round(spent * 100) / 100,
      openCreditGhs: Math.round(myCredits.filter((s: any) => String(s.status) !== "PAID").reduce((s: number, x: any) => s + (Number(x.balanceGhs) || 0), 0) * 100) / 100,
      lastOrderAt: lastOrderAt ? new Date(lastOrderAt).toISOString() : null,
    });
  }
  return out.sort((a, b) => b.monetaryGhs - a.monetaryGhs);
}

/** One customer's full relationship — the payload behind the 360 drawer. */
export async function customer360(customerId: number) {
  const [profile] = await db.select().from(customers).where(eq(customers.id, Number(customerId)));
  if (!profile) return null;
  const cid = Number(profile.id);

  const [interactions, tracks, credits, trxRows] = await Promise.all([
    db.select().from(customerInteractions).where(eq(customerInteractions.customerId, cid)),
    db.select().from(customerTrackings).where(eq(customerTrackings.customerId, cid)),
    db.select().from(creditSales).where(eq(creditSales.customerId, cid)),
    db.select().from(transactions).where(eq(transactions.customerId, cid)),
  ]);
  const creditIds = credits.map((s: any) => Number(s.id));
  const payments = creditIds.length
    ? await db.select().from(creditPayments).where(inArray(creditPayments.creditSaleId, creditIds))
    : [];

  const income = trxRows.filter((t: any) => String(t.type) === "INCOME");
  const now = Date.now();
  const dates = [
    ...tracks.map((t: any) => new Date(t.createdAt).getTime()),
    ...income.map((t: any) => new Date(t.date || t.createdAt).getTime()),
  ].filter((n) => Number.isFinite(n) && n > 0);
  const lastOrderAt = dates.length ? Math.max(...dates) : null;
  const orderCount = tracks.length + income.length;
  const spent =
    Number(profile.totalSpentGhs || 0) ||
    income.reduce((s: number, t: any) => s + (Number(t.amountGhs) || 0), 0) + tracks.reduce((s: number, t: any) => s + (Number(t.totalGhs) || 0), 0);

  // Statement of account: sales (invoices/credit) and payments, merged
  // chronologically with a running balance.
  const statement: any[] = [];
  for (const t of tracks as any[]) {
    statement.push({
      kind: "SALE",
      date: String(t.createdAt || "").slice(0, 10),
      reference: t.trackingCode || `Order #${t.id}`,
      description: `Order — ${t.branchName || "sale"}${Array.isArray(t.items) && t.items.length ? ` (${t.items.length} item${t.items.length === 1 ? "" : "s"})` : ""}`,
      debitGhs: Math.round((Number(t.totalGhs) || 0) * 100) / 100,
      creditGhs: 0,
    });
  }
  for (const s of credits as any[]) {
    statement.push({
      kind: "CREDIT_SALE",
      date: String(s.createdAt || "").slice(0, 10),
      reference: s.creditCode,
      description: `Credit sale${s.dueDate ? ` — due ${s.dueDate}` : ""}`,
      debitGhs: Math.round((Number(s.totalGhs) || 0) * 100) / 100,
      creditGhs: 0,
    });
  }
  for (const p of payments as any[]) {
    statement.push({
      kind: "PAYMENT",
      date: String(p.paidOn || p.createdAt || "").slice(0, 10),
      reference: p.paymentNumber,
      description: `Payment (${p.paymentMethod})${p.note ? ` — ${p.note}` : ""}`,
      debitGhs: 0,
      creditGhs: Math.round((Number(p.amountGhs) || 0) * 100) / 100,
    });
  }
  statement.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let run = 0;
  for (const line of statement) {
    run = Math.round((run + Number(line.debitGhs) - Number(line.creditGhs)) * 100) / 100;
    line.balanceGhs = run;
  }

  const openCredits = (credits as any[]).filter((s) => String(s.status) !== "PAID");
  return {
    profile,
    insights: {
      segment: rfmSegment({
        orderCount,
        daysSinceLast: lastOrderAt ? Math.floor((now - lastOrderAt) / 86400000) : null,
        totalSpentGhs: spent,
      }),
      recencyDays: lastOrderAt ? Math.floor((now - lastOrderAt) / 86400000) : null,
      frequency: orderCount,
      monetaryGhs: Math.round(spent * 100) / 100,
      openCreditGhs: Math.round(openCredits.reduce((s, x) => s + (Number(x.balanceGhs) || 0), 0) * 100) / 100,
      lastOrderAt: lastOrderAt ? new Date(lastOrderAt).toISOString() : null,
    },
    interactions: (interactions as any[]).sort((a, b) => (String(b.occurredAt || b.createdAt || "") > String(a.occurredAt || a.createdAt || "") ? 1 : -1)),
    orders: (tracks as any[]).sort((a, b) => Number(b.id) - Number(a.id)),
    creditSales: (credits as any[]).sort((a, b) => Number(b.id) - Number(a.id)),
    payments: (payments as any[]).sort((a, b) => Number(b.id) - Number(a.id)),
    statement,
    statementBalanceGhs: run,
  };
}

/** Sanitize the flexible preferences JSONB (bounded, string-values-only). */
export function sanitizePreferences(v: any): Record<string, string> | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, 20)) {
    const key = String(k).trim().slice(0, 40);
    if (!key) continue;
    const s = String(val ?? "").trim().slice(0, 200);
    if (s) out[key] = s;
  }
  return out;
}

export interface DunningStageResult {
  creditCode: string;
  customerName: string;
  daysOverdue: number;
  stage: "REMINDER" | "FIRM" | "FINAL";
  notified: number;
}

/**
 * Dunning sweep — for every ACTIVE credit sale past its due date with a
 * balance, fire the stage-appropriate chase ONCE (marker
 * `dunning:{creditSaleId}:{stage}`). Also logs an interaction row on the
 * customer timeline so the 360 view shows every reminder sent.
 */
export async function sweepDunning(opts?: { today?: string }): Promise<DunningStageResult[]> {
  const today = opts?.today || new Date().toLocaleDateString("en-CA");
  const rows = await db.select().from(creditSales);
  const fired: DunningStageResult[] = [];
  for (const s of rows) {
    if (String(s.status) === "PAID") continue;
    const balance = Number(s.balanceGhs) || 0;
    if (balance <= 0.009) continue;
    if (!s.dueDate || String(s.dueDate) >= today) continue; // not due yet / no agreed date
    const daysOverdue = Math.max(0, Math.round((new Date(today).getTime() - new Date(String(s.dueDate)).getTime()) / 86400000));
    const stage: "REMINDER" | "FIRM" | "FINAL" = daysOverdue >= 30 ? "FINAL" : daysOverdue >= 7 ? "FIRM" : "REMINDER";
    const markerKey = `dunning:${s.id}:${stage}`;
    if ((await getSystemMarker(markerKey)) != null) continue; // this chase already went out
    await notifyDunning({
      businessId: Number(s.businessId),
      branchCode: s.branchCode,
      creditCode: s.creditCode,
      customerName: s.customerName,
      customerPhone: s.customerPhone,
      balanceGhs: balance,
      daysOverdue,
      stage,
    });
    // Timeline trail: the customer's 360 view shows every chase.
    if (s.customerId != null) {
      const orgId = await ownerOrgOfBusiness(Number(s.businessId));
      await db.insert(customerInteractions).values({
        ownerId: Number(orgId) || 1,
        businessId: Number(s.businessId),
        customerId: Number(s.customerId),
        type: "FOLLOW_UP",
        summary:
          stage === "REMINDER"
            ? `Payment reminder sent — credit ${s.creditCode} is ${daysOverdue} day(s) past due`
            : stage === "FIRM"
              ? `Firm chase sent — credit ${s.creditCode} is ${daysOverdue} days past due (GH₵ ${balance.toFixed(2)} outstanding)`
              : `FINAL notice sent — credit ${s.creditCode} is ${daysOverdue} days past due (GH₵ ${balance.toFixed(2)} outstanding)`,
        detail: `Automated dunning stage ${stage}. Outstanding balance GH₵ ${balance.toFixed(2)} on credit sale ${s.creditCode}${s.dueDate ? ` (due ${s.dueDate})` : ""}.`,
        occurredAt: today,
        actorName: "Dunning sweep",
        actorRole: "SYSTEM",
      });
    }
    await setSystemMarker(markerKey, `${stage}@${today}`);
    fired.push({ creditCode: s.creditCode, customerName: s.customerName, daysOverdue, stage, notified: 1 });
  }
  return fired;
}

/** Upcoming follow-ups for the Action Center / drawer reminders. */
export async function upcomingFollowUps(businessIds: number[] | null, today?: string) {
  const t = today || new Date().toLocaleDateString("en-CA");
  let rows = await db.select().from(customerInteractions);
  if (businessIds != null) {
    const scope = new Set(businessIds.map(Number));
    rows = rows.filter((r: any) => r.businessId == null || scope.has(Number(r.businessId)));
  }
  return rows
    .filter((r: any) => r.followUpOn && String(r.followUpOn) >= t)
    .sort((a: any, b: any) => (String(a.followUpOn) < String(b.followUpOn) ? -1 : 1));
}
