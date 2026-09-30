import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { businesses, businessMetrics, creditSales, payrollEntries, supplierOrders, transactions } from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

/**
 * Cash-flow FORECAST (P4, part 2) — the forward-looking complement to the
 * Command Center's historical "Net Operating Cash Flow".
 *
 * Starting cash mirrors that headline exactly (Σ business_metrics.cash_flow_ghs
 * in scope). On top of it the projection layers, per week:
 *
 *  CERTAIN INFLOW   outstanding credit-sale balances, landing on their agreed
 *                   due dates (undated balances ride at the horizon's end);
 *  ESTIMATED INFLOW recurring income run-rate (live last-30-day average,
 *                   seeded baseline excluded);
 *  CERTAIN OUTFLOW  open purchase orders not yet expense-booked, landing on
 *                   their promised supplier ETA (default +7 days);
 *  ESTIMATED OUTFLOW recurring expense run-rate (last 30 days, payroll
 *                   excluded) + next month's payroll (latest run's net total
 *                   per business, landing at month end).
 *
 * Every component is labelled in the response so the UI can show what is
 * committed vs assumed — this is a planning aid, not an accounting statement.
 */

const isSeededBaseline = (t: any) => /^TRX-\d{4}-100[1-6]$/.test(String(t?.transactionNumber || ""));
const OPEN_PO_STATUSES = ["RAISED", "SENT", "SHIPPED", "IN_TRANSIT", "ARRIVED"];
const DAY = 86400000;

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;
    const role = String(user.role || "").toUpperCase();
    if (role === "WORKER") return FORBIDDEN("The cash-flow forecast is a management view.");

    const { searchParams } = new URL(request.url);
    const allowed = await accessibleBusinessIds(user);
    const scopeParam = String(searchParams.get("businessId") || "all").toLowerCase();
    const weeks = Math.min(26, Math.max(4, Number(searchParams.get("weeks")) || 13));

    let bizIds: number[];
    if (scopeParam === "all" || scopeParam === "0") {
      bizIds = allowed === null
        ? (await db.select({ id: businesses.id }).from(businesses)).map((b) => Number(b.id))
        : allowed;
    } else {
      const id = Number(scopeParam);
      if (!id) return NextResponse.json({ success: false, error: "bad businessId" }, { status: 400 });
      if (allowed !== null && !allowed.includes(id)) return FORBIDDEN("That business is outside your scope.");
      bizIds = [id];
    }
    if (!bizIds.length) {
      return NextResponse.json({ success: true, startingCashGhs: 0, weeks: [], assumptions: [] });
    }

    const today = todayISO();
    const todayMs = Date.parse(today);
    const horizonEnd = todayMs + weeks * 7 * DAY;

    // ── Starting cash: same figure the Command Center shows as liquid surplus.
    const metricRows = await db
      .select({ businessId: businessMetrics.businessId, cashFlowGhs: businessMetrics.cashFlowGhs })
      .from(businessMetrics)
      .where(inArray(businessMetrics.businessId, bizIds));
    const startingCash = metricRows.reduce((s, m) => s + (Number(m.cashFlowGhs) || 0), 0);

    // ── Certain inflow: outstanding credit balances on their due dates.
    const credits = await db
      .select({
        businessId: creditSales.businessId,
        customerName: creditSales.customerName,
        creditCode: creditSales.creditCode,
        balanceGhs: creditSales.balanceGhs,
        dueDate: creditSales.dueDate,
      })
      .from(creditSales)
      .where(and(inArray(creditSales.businessId, bizIds), eq(creditSales.status, "ACTIVE")))
      .limit(500);
    const creditLines = credits
      .map((c) => ({ ...c, balanceGhs: Number(c.balanceGhs) || 0 }))
      .filter((c) => c.balanceGhs > 0.009);
    const undatedCredit = creditLines
      .filter((c) => !c.dueDate || Date.parse(String(c.dueDate)) < todayMs - 1 || Date.parse(String(c.dueDate)) > horizonEnd)
      .reduce((s, c) => s + c.balanceGhs, 0);

    // ── Certain outflow: open POs not yet booked as expenses.
    const poRows = await db
      .select({
        businessId: supplierOrders.businessId,
        purchaseNumber: supplierOrders.purchaseNumber,
        supplierName: supplierOrders.supplierName,
        totalGhs: supplierOrders.totalGhs,
        expectedAt: supplierOrders.expectedAt,
        status: supplierOrders.status,
      })
      .from(supplierOrders)
      .where(and(inArray(supplierOrders.businessId, bizIds), inArray(supplierOrders.status, OPEN_PO_STATUSES)))
      .limit(500);
    const openPOs = poRows
      .map((p) => ({ ...p, totalGhs: Number(p.totalGhs) || 0, expectedMs: p.expectedAt ? Date.parse(String(p.expectedAt)) : todayMs + 7 * DAY }))
      .filter((p) => p.totalGhs > 0.009)
      .map((p) => ({ ...p, expectedMs: Number.isFinite(p.expectedMs) ? p.expectedMs : todayMs + 7 * DAY }));

    // ── Run-rates: live last-30-day averages (baseline excluded).
    const since = new Date(todayMs - 30 * DAY).toISOString().slice(0, 10);
    const txnRows = await db
      .select({
        type: transactions.type,
        category: transactions.category,
        amountGhs: transactions.amountGhs,
        transactionNumber: transactions.transactionNumber,
        status: transactions.status,
      })
      .from(transactions)
      .where(and(inArray(transactions.businessId, bizIds), sql`${transactions.date} >= ${since}`))
      .limit(6000);
    const liveTxns = txnRows.filter((t) => !isSeededBaseline(t) && (!t.status || t.status === "COMPLETED"));
    const income30 = liveTxns.filter((t) => t.type === "INCOME").reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const expense30 = liveTxns
      .filter((t) => t.type === "EXPENSE" && !/payroll|salary|wages/i.test(String(t.category || "")))
      .reduce((s, t) => s + Number(t.amountGhs || 0), 0);
    const dailyIncome = income30 / 30;
    const dailyExpense = expense30 / 30;

    // ── Payroll: the latest run's net total per business, next month-end.
    const payRows = await db.execute(
      sql`select pe.business_id, sum(pe.net_pay_ghs) as net
          from payroll_entries pe
          join payroll_runs pr on pr.id = pe.run_id
          where pe.business_id in (${sql.join(bizIds.map((i) => sql`${i}`), sql`, `)})
            and pr.status in ('REVIEWED','APPROVED','PAID')
          group by pe.business_id`,
    );
    const payrollByBiz = new Map<number, number>();
    for (const r of (payRows as any).rows ?? payRows) {
      payrollByBiz.set(Number(r.business_id), Number(r.net) || 0);
    }
    const monthlyPayroll = Array.from(payrollByBiz.values()).reduce((s, n) => s + n, 0);
    // Payroll for the current month is typically paid at its end; the next
    // obligation lands on the upcoming month-end inside the horizon.
    const upcomingMonthEnds: number[] = [];
    {
      const d = new Date();
      for (let m = 0; m <= Math.ceil(weeks / 4) + 1; m++) {
        const end = new Date(d.getFullYear(), d.getMonth() + 1 + m, 0).getTime();
        if (end >= todayMs && end <= horizonEnd) upcomingMonthEnds.push(end);
      }
    }

    // ── Weekly buckets. Nets are rounded to pesewas BEFORE accumulating so
    // the displayed table is perfectly self-consistent (W(n) cumulative +
    // W(n+1) net = W(n+1) cumulative) — no cent drift between rows.
    const buckets = [];
    let cumulative = startingCash;
    for (let w = 0; w < weeks; w++) {
      const from = todayMs + w * 7 * DAY;
      const to = from + 7 * DAY;
      const certainIn = creditLines
        .filter((c) => c.dueDate && Date.parse(String(c.dueDate)) >= from && Date.parse(String(c.dueDate)) < to)
        .reduce((s, c) => s + c.balanceGhs, 0);
      const certainOut = openPOs.filter((p) => p.expectedMs >= from && p.expectedMs < to).reduce((s, p) => s + p.totalGhs, 0);
      const payrollOut = upcomingMonthEnds.filter((m) => m >= from && m < to).reduce((s) => s + monthlyPayroll, 0);
      const estIn = w === weeks - 1 ? undatedCredit + dailyIncome * 7 : dailyIncome * 7;
      const estOut = dailyExpense * 7 + payrollOut;
      const r = (n: number) => Math.round(n * 100) / 100;
      const net = r(certainIn + estIn - certainOut - estOut);
      cumulative = r(cumulative + net);
      buckets.push({
        week: w + 1,
        from: new Date(from).toISOString().slice(0, 10),
        to: new Date(to - DAY).toISOString().slice(0, 10),
        certainInflowGhs: r(certainIn),
        estimatedInflowGhs: r(estIn),
        certainOutflowGhs: r(certainOut + payrollOut),
        estimatedOutflowGhs: r(dailyExpense * 7),
        netGhs: net,
        cumulativeCashGhs: cumulative,
      });
    }
    const firstNegativeWeek = buckets.find((b) => b.cumulativeCashGhs < 0)?.week ?? null;

    return NextResponse.json({
      success: true,
      today,
      weeks,
      scope: scopeParam === "all" || scopeParam === "0" ? "all" : Number(scopeParam),
      startingCashGhs: Math.round(startingCash * 100) / 100,
      projectedEndCashGhs: buckets.length ? buckets[buckets.length - 1].cumulativeCashGhs : Math.round(startingCash * 100) / 100,
      firstNegativeWeek,
      outstandingCreditGhs: Math.round(creditLines.reduce((s, c) => s + c.balanceGhs, 0) * 100) / 100,
      openPurchaseOrdersGhs: Math.round(openPOs.reduce((s, p) => s + p.totalGhs, 0) * 100) / 100,
      monthlyPayrollGhs: Math.round(monthlyPayroll * 100) / 100,
      dailyIncomeRunRateGhs: Math.round(dailyIncome * 100) / 100,
      dailyExpenseRunRateGhs: Math.round(dailyExpense * 100) / 100,
      creditCount: creditLines.length,
      openPoCount: openPOs.length,
      buckets,
      assumptions: [
        "Starting cash = the Command Center's Net Operating Cash Flow (Σ business metrics).",
        "Certain inflow = outstanding credit-sale balances landing on their agreed due dates; undated balances ride at the end of the horizon.",
        "Estimated inflow = recurring income run-rate (live last-30-day average, seeded baseline excluded).",
        "Certain outflow = open purchase orders not yet booked, at their supplier ETA (default +7 days) + next month-end payroll (latest run's net total).",
        "Estimated outflow = recurring expense run-rate (last 30 days, payroll categories excluded to avoid double counting).",
      ],
    });
  } catch (e) {
    console.error("[api/cashflow/forecast]", e);
    return NextResponse.json({ success: false, error: "Could not build the cash-flow forecast." }, { status: 500 });
  }
}
