/**
 * GoMina 360 — Unified Financial Report engine (pure functions, unit-testable).
 *
 * ONE source of truth for every business dashboard's "Financial Report"
 * section. It blends two layers WITHOUT ever double-counting:
 *
 *   1. Q1-2026 seeded baseline (business_metrics quarterly close). The seed
 *      series TRX-<year>-1001..1006 is already inside those quarterly totals,
 *      so those rows are recognised and excluded from ledger sums.
 *   2. The live transaction ledger (transactions table) — fed in REAL TIME by
 *      every module: sales, purchases / stock-ins, production stock-outs,
 *      order fulfilment, washes, expenses and payments.
 *
 * KPI totals include the baseline only on the All-Time view; every dated
 * range is a pure ledger view, and the baseline card stays visible so the
 * full picture is never lost.
 */

export type FinanceGranularity = "DAY" | "MONTH" | "YEAR";

export interface FinancePeriodDef {
  key: string;
  label: string;
  /** ISO date YYYY-MM-DD inclusive; null = unbounded. */
  start: string | null;
  end: string | null;
}

export interface FinanceBaseline {
  revenueGhs: number;
  expensesGhs: number;
  label: string; // e.g. "Q1-2026 baseline (system records)"
}

export interface FinanceReportInput {
  transactions: any[];
  /** null = whole accessible enterprise scope. */
  businessId?: number | null;
  /** Optional branch/register code filter (txn.branchCode). */
  branchCode?: string | null;
  /** Recovered baseline for the scope (see recoverBaseline). */
  baseline?: FinanceBaseline | null;
  period: FinancePeriodDef;
  granularity: FinanceGranularity;
  today?: Date;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The seeded quarter-close rows that are already inside business_metrics. */
export function isSeededBaselineTxn(t: any): boolean {
  return /^TRX-\d{4}-100[1-6]$/.test(String(t?.transactionNumber || ""));
}

/**
 * All selectable date ranges — days, months, years — computed from `today`.
 * end is always inclusive; start/end are null only for ALL_TIME.
 */
export function financePeriods(today: Date = new Date()): FinancePeriodDef[] {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const shift = (days: number) => {
    const d = new Date(t);
    d.setDate(d.getDate() + days);
    return isoLocal(d);
  };
  const monthStart = (offset: number) =>
    isoLocal(new Date(t.getFullYear(), t.getMonth() + offset, 1));
  const monthEnd = (offset: number) =>
    isoLocal(new Date(t.getFullYear(), t.getMonth() + offset + 1, 0));
  const todayIso = isoLocal(t);
  return [
    { key: "TODAY", label: "Today", start: todayIso, end: todayIso },
    { key: "YESTERDAY", label: "Yesterday", start: shift(-1), end: shift(-1) },
    { key: "LAST_7_DAYS", label: "Last 7 Days", start: shift(-6), end: todayIso },
    { key: "THIS_MONTH", label: "This Month", start: monthStart(0), end: todayIso },
    { key: "LAST_MONTH", label: "Last Month", start: monthStart(-1), end: monthEnd(-1) },
    { key: "LAST_3_MONTHS", label: "Last 3 Months", start: monthStart(-2), end: todayIso },
    { key: "LAST_6_MONTHS", label: "Last 6 Months", start: monthStart(-5), end: todayIso },
    { key: "YEAR_TO_DATE", label: "Year to Date", start: monthStart(-t.getMonth()), end: todayIso },
    {
      key: "LAST_YEAR",
      label: `${t.getFullYear() - 1} (Last Year)`,
      start: `${t.getFullYear() - 1}-01-01`,
      end: `${t.getFullYear() - 1}-12-31`,
    },
    { key: "ALL_TIME", label: "All Time", start: null, end: null },
  ];
}

export function getFinancePeriod(key: string, today: Date = new Date()): FinancePeriodDef {
  const all = financePeriods(today);
  return all.find((p) => p.key === key) || all[all.length - 1];
}

/** Sensible default granularity for a range ("filter by days, months, years"). */
export function defaultGranularity(p: FinancePeriodDef): FinanceGranularity {
  if (!p.start || !p.end) return "MONTH";
  const days =
    (new Date(p.end + "T00:00:00").getTime() - new Date(p.start + "T00:00:00").getTime()) / 86400000 + 1;
  if (days <= 62) return "DAY";
  if (days <= 800) return "MONTH";
  return "YEAR";
}

/**
 * Recover the seeded quarterly close hidden inside a live metric row.
 * GoMinaApp's liveMetrics = seeded metric + transactions created THIS session
 * (id > baselineTxId). Subtracting that overlay returns the clean baseline.
 * If the metric carries no baselineTxId, it is used as-is (pure baseline).
 */
export function recoverBaseline(metric: any, txns: any[], label = "Q1-2026 baseline (system records)"): FinanceBaseline | null {
  if (!metric) return null;
  const cutoff = Number.isFinite(metric?.baselineTxId) ? Number(metric.baselineTxId) : -1;
  let inc = 0;
  let exp = 0;
  for (const t of txns || []) {
    if ((t.id || 0) <= cutoff) continue;
    if (t.businessId !== metric.businessId) continue;
    const amt = t.amountGhs || 0;
    if (t.type === "INCOME") inc += amt;
    else if (t.type === "EXPENSE") exp += amt;
  }
  return {
    revenueGhs: Math.max(0, (metric.revenueGhs || 0) - inc),
    expensesGhs: Math.max(0, (metric.expensesGhs || 0) - exp),
    label,
  };
}

export interface TrendBucket {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  profit: number;
  /** INCOME postings inside this bucket (drives the sales-volume chart). */
  receipts?: number;
  /** True when the seeded baseline was folded into this bucket. */
  withBaseline?: boolean;
}

export interface FinanceReport {
  rangeLabel: string;
  revenue: number;
  expenses: number;
  profit: number;
  marginPct: number;
  salesCount: number;
  expenseCount: number;
  avgTicket: number;
  cashCollected: number; // completed income = payments collected
  investments: number;
  transfers: number;
  prevRevenue: number | null;
  prevExpenses: number | null;
  revenueDeltaPct: number | null;
  expenseDeltaPct: number | null;
  profitDeltaPct: number | null;
  baselineIncludedInTotals: boolean;
  baseline: FinanceBaseline | null;
  incomeByCategory: { name: string; total: number; count: number }[];
  expenseByCategory: { name: string; total: number; count: number }[];
  paymentsInByMethod: { name: string; total: number; count: number }[];
  paymentsOutByMethod: { name: string; total: number; count: number }[];
  trend: TrendBucket[];
  trendGranularity: FinanceGranularity;
  pendingCollections: { id: any; label: string; status: string; method: string; amount: number; date: string }[];
  branchesKey: { code: string; revenue: number; expenses: number; profit: number; sales: number }[];
  ledger: any[];
  liveTxnCount: number;
}

const MONEY_TYPES = new Set(["INCOME", "EXPENSE", "INVESTMENT", "TRANSFER"]);
const INCOME_WORDS = /sale|revenue|receipt|income|wash|harvest|order|service|delivery|installation/i;
const PURCHASE_WORDS = /purchase|stock|restock|suppl|feed|material|ingredient|cement|goods|inventory|grain|fingerling|chick|drum|chemical/i;
export const PURCHASE_CATEGORY_RE = PURCHASE_WORDS;

function groupSum(rows: any[], keyOf: (t: any) => string): { name: string; total: number; count: number }[] {
  const m: Record<string, { total: number; count: number }> = {};
  for (const t of rows) {
    const k = keyOf(t) || "Other";
    if (!m[k]) m[k] = { total: 0, count: 0 };
    m[k].total += t.amountGhs || 0;
    m[k].count++;
  }
  return Object.entries(m)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketKey(dateIso: string, g: FinanceGranularity): string {
  const s = String(dateIso || "").slice(0, 10);
  if (g === "DAY") return s;
  if (g === "MONTH") return s.slice(0, 7);
  return s.slice(0, 4);
}

export function bucketLabel(key: string, g: FinanceGranularity): string {
  if (g === "DAY") {
    const [, m, d] = key.split("-");
    return `${Number(d)} ${MONTH_LABELS[Number(m) - 1] || m}`;
  }
  if (g === "MONTH") {
    const [y, m] = key.split("-");
    return `${MONTH_LABELS[Number(m) - 1] || m} '${String(y).slice(2)}`;
  }
  return key;
}

/** Inclusive range test on ISO date strings (null = unbounded). */
function inRange(dateIso: string, start: string | null, end: string | null): boolean {
  const d = String(dateIso || "").slice(0, 10);
  if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

export function computeFinancialReport(input: FinanceReportInput): FinanceReport {
  const { period, baseline = null } = input;
  const granularity = input.granularity;
  const today = input.today || new Date();

  // 1. Scope: business + branch.
  const scoped = (input.transactions || []).filter((t) => {
    if (input.businessId != null && t.businessId !== input.businessId) return false;
    if (input.branchCode != null && input.branchCode !== "" && String(t.branchCode || "") !== input.branchCode) return false;
    return true;
  });

  // 2. Live ledger: money movements excluding the seeded quarter-close rows
  //    (those are already inside the metrics baseline).
  const ledgerAll = scoped.filter((t) => MONEY_TYPES.has(t.type) && !isSeededBaselineTxn(t));

  // 3. Range partition.
  const inSel = ledgerAll.filter((t) => inRange(t.date, period.start, period.end));

  const sums = (rows: any[]) => {
    let revenue = 0;
    let expenses = 0;
    let investments = 0;
    let transfers = 0;
    let salesCount = 0;
    let expenseCount = 0;
    for (const t of rows) {
      const amt = t.amountGhs || 0;
      if (t.type === "INCOME") {
        revenue += amt;
        salesCount++;
      } else if (t.type === "EXPENSE") {
        expenses += amt;
        expenseCount++;
      } else if (t.type === "INVESTMENT") investments += amt;
      else if (t.type === "TRANSFER") transfers += amt;
    }
    return { revenue, expenses, investments, transfers, salesCount, expenseCount };
  };

  const cur = sums(inSel);

  // Previous equivalent window (for trend deltas) — ledger only.
  let prev: ReturnType<typeof sums> | null = null;
  if (period.start && period.end) {
    const s = new Date(period.start + "T00:00:00").getTime();
    const e = new Date(period.end + "T00:00:00").getTime();
    const len = e - s + 86400000;
    const ps = isoLocal(new Date(s - len));
    const pe = isoLocal(new Date(s - 86400000));
    prev = sums(ledgerAll.filter((t) => inRange(t.date, ps, pe)));
  }

  // Baseline folding: the quarterly close joins totals only on the unscoped
  // All Time view — a branch/register filter has no baseline attribution.
  const baselineIncludedInTotals =
    !!baseline && period.key === "ALL_TIME" && (input.branchCode == null || input.branchCode === "");
  const revenue = cur.revenue + (baselineIncludedInTotals ? baseline!.revenueGhs : 0);
  const expenses = cur.expenses + (baselineIncludedInTotals ? baseline!.expensesGhs : 0);
  const profit = revenue - expenses;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  const pct = (curV: number, prevV: number | null): number | null => {
    if (prevV == null || prevV <= 0) return null;
    return ((curV - prevV) / prevV) * 100;
  };

  // 4. Trend buckets. Baseline folds into its quarter close (Mar 2026) on the
  //    monthly view and into the year bucket on the yearly view — All Time only.
  const trendMap: Record<string, TrendBucket> = {};
  const put = (key: string) => {
    if (!trendMap[key]) trendMap[key] = { key, label: bucketLabel(key, granularity), revenue: 0, expenses: 0, profit: 0, receipts: 0 };
    return trendMap[key];
  };
  if (period.start && period.end) {
    // Seed zero-buckets so short ranges (Today, 7D, Month) render a readable axis.
    const s = new Date(period.start + "T00:00:00");
    const e = new Date(period.end + "T00:00:00");
    const maxSteps = granularity === "DAY" ? 62 : granularity === "MONTH" ? 36 : 12;
    let steps = 0;
    const d = new Date(s);
    while (d.getTime() <= e.getTime() && steps < maxSteps) {
      put(bucketKey(isoLocal(d), granularity));
      if (granularity === "DAY") d.setDate(d.getDate() + 1);
      else if (granularity === "MONTH") d.setMonth(d.getMonth() + 1);
      else d.setFullYear(d.getFullYear() + 1);
      steps++;
    }
  }
  for (const t of inSel) {
    const b = put(bucketKey(t.date, granularity));
    if (t.type === "INCOME") {
      b.revenue += t.amountGhs || 0;
      b.receipts = (b.receipts || 0) + 1;
    } else if (t.type === "EXPENSE") b.expenses += t.amountGhs || 0;
  }
  if (baselineIncludedInTotals) {
    if (granularity === "YEAR") {
      const b = put("2026");
      b.revenue += baseline!.revenueGhs;
      b.expenses += baseline!.expensesGhs;
      b.withBaseline = true;
    } else if (granularity === "MONTH") {
      const b = put("2026-03");
      b.label = "Mar '26 · Q1 close";
      b.revenue += baseline!.revenueGhs;
      b.expenses += baseline!.expensesGhs;
      b.withBaseline = true;
    }
  }
  const trend = Object.values(trendMap)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((b) => ({ ...b, profit: b.revenue - b.expenses }));

  // 5. Breakdowns.
  const incomeRows = inSel.filter((t) => t.type === "INCOME");
  const expenseRows = inSel.filter((t) => t.type === "EXPENSE");
  const incomeByCategory = groupSum(incomeRows, (t) => t.category);
  const expenseByCategory = groupSum(expenseRows, (t) => t.category);
  const paymentsInByMethod = groupSum(incomeRows, (t) => String(t.paymentMethod || "CASH").replace(/_/g, " "));
  const paymentsOutByMethod = groupSum(expenseRows, (t) => String(t.paymentMethod || "CASH").replace(/_/g, " "));

  // 6. Outstanding collections — CURRENT position (scope-wide, not range-bound):
  //    unverified MoMo + offline-queued money still to clear.
  const pendingCollections = scoped
    .filter((t) => ["PENDING_MOMO_VERIFICATION", "OFFLINE_QUEUED", "PENDING"].includes(String(t.status || "")))
    .map((t) => ({
      id: t.id,
      label: t.description || t.category,
      status: String(t.status),
      method: String(t.paymentMethod || "").replace(/_/g, " "),
      amount: t.amountGhs || 0,
      date: t.date,
    }))
    .sort((a, b) => b.amount - a.amount);

  // 7. Per-branch split inside the scope (ledger, range-bound).
  const branchMap: Record<string, { revenue: number; expenses: number; sales: number }> = {};
  for (const t of inSel) {
    const code = String(t.branchCode || "MAIN");
    if (!branchMap[code]) branchMap[code] = { revenue: 0, expenses: 0, sales: 0 };
    if (t.type === "INCOME") {
      branchMap[code].revenue += t.amountGhs || 0;
      branchMap[code].sales++;
    } else if (t.type === "EXPENSE") branchMap[code].expenses += t.amountGhs || 0;
  }
  const branchesKey = Object.entries(branchMap)
    .map(([code, v]) => ({ code, ...v, profit: v.revenue - v.expenses }))
    .sort((a, b) => b.revenue - a.revenue);

  const rangeLabel =
    period.key === "ALL_TIME"
      ? "All time"
      : period.start === period.end
      ? period.start!
      : `${period.start} → ${period.end}`;

  return {
    rangeLabel,
    revenue,
    expenses,
    profit,
    marginPct,
    salesCount: cur.salesCount,
    expenseCount: cur.expenseCount,
    avgTicket: cur.salesCount > 0 ? cur.revenue / cur.salesCount : 0,
    cashCollected: revenue,
    investments: cur.investments,
    transfers: cur.transfers,
    prevRevenue: prev ? prev.revenue : null,
    prevExpenses: prev ? prev.expenses : null,
    revenueDeltaPct: pct(cur.revenue, prev?.revenue ?? null),
    expenseDeltaPct: pct(cur.expenses, prev?.expenses ?? null),
    profitDeltaPct:
      prev && prev.revenue - prev.expenses !== 0
        ? (((cur.revenue - cur.expenses) - (prev.revenue - prev.expenses)) /
            Math.max(1, Math.abs(prev.revenue - prev.expenses))) * 100
        : null,
    baselineIncludedInTotals,
    baseline,
    incomeByCategory,
    expenseByCategory,
    paymentsInByMethod,
    paymentsOutByMethod,
    trend,
    trendGranularity: granularity,
    pendingCollections,
    branchesKey,
    ledger: [...inSel].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 15),
    liveTxnCount: ledgerAll.length,
  };
}

/** Sales-vs-purchases purchase heuristic used by the linkage chips. */
export function isPurchaseLikeExpense(t: any): boolean {
  return t.type === "EXPENSE" && PURCHASE_WORDS.test(String(t.category || "") + " " + String(t.description || ""));
}
export function isSalesLikeIncome(t: any): boolean {
  return t.type === "INCOME" && INCOME_WORDS.test(String(t.category || ""));
}
