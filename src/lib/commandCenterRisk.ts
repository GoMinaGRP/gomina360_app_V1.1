/**
 * Command Center risk scoring.
 *
 * The score is intentionally derived from the CURRENT scoped production data
 * that /api/init returns (businesses + live metrics + ledger + inventory +
 * checklists).  Older deployments drifted toward a uniform fallback value
 * (notably 20 base risk + 20 incomplete-checklist cap = 40/100) whenever
 * newly-created real businesses did not have seeded metric risk rows.  This
 * engine treats the stored metric risk as only one signal and recalculates the
 * business risk from the business' own operating state every render.
 */

export type CommandCenterRiskBand = "LOW" | "MODERATE" | "ELEVATED";

export type CommandCenterRiskResult = {
  riskScore: number;
  band: CommandCenterRiskBand;
  drivers: string[];
};

type MetricLike = {
  id?: number | null;
  businessId?: number | null;
  period?: string | null;
  revenueGhs?: number | null;
  expensesGhs?: number | null;
  netProfitGhs?: number | null;
  roiPercent?: number | null;
  cashFlowGhs?: number | null;
  assetsValueGhs?: number | null;
  inventoryValueGhs?: number | null;
  growthRatePercent?: number | null;
  riskScore?: number | null;
  lastUpdated?: string | Date | null;
  /** Present on GoMinaApp's live metrics after live transactions are layered in. */
  baselineTxId?: number | null;
};

type TransactionLike = {
  id?: number | null;
  businessId?: number | null;
  type?: string | null;
  amountGhs?: number | null;
  status?: string | null;
  date?: string | null;
  transactionNumber?: string | null;
};

type InventoryLike = {
  businessId?: number | null;
  quantity?: number | null;
  minStockThreshold?: number | null;
  status?: string | null;
};

type ChecklistEntryLike = {
  businessId?: number | null;
  checklistDate?: string | null;
  isCompleted?: boolean | null;
  priority?: string | null;
};

type BusinessLike = {
  id?: number | null;
  managerName?: string | null;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const completedTxn = (t: TransactionLike) => !t.status || String(t.status).toUpperCase() === "COMPLETED";
const seededBaselineTxn = (t: TransactionLike) => /^TRX-\d{4}-100[1-6]$/i.test(String(t.transactionNumber || ""));

export function commandCenterRiskBand(score: number): CommandCenterRiskBand {
  if (score < 35) return "LOW";
  if (score < 60) return "MODERATE";
  return "ELEVATED";
}

/** Pick the latest/current metric for one business.  If production ever holds
 * multiple period rows for the same business, do not let Array.find() select an
 * arbitrary older fallback row. */
export function latestBusinessMetric(metrics: MetricLike[] = [], businessId: number): MetricLike | null {
  const rows = (metrics || []).filter((m) => Number(m.businessId) === Number(businessId));
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    const au = a.lastUpdated ? Date.parse(String(a.lastUpdated)) || 0 : 0;
    const bu = b.lastUpdated ? Date.parse(String(b.lastUpdated)) || 0 : 0;
    if (au !== bu) return bu - au;
    const liveA = String(a.period || "").toUpperCase() === "LIVE" ? 1 : 0;
    const liveB = String(b.period || "").toUpperCase() === "LIVE" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return num(b.id) - num(a.id);
  })[0];
}

export function computeCommandCenterBusinessRisk(args: {
  business: BusinessLike;
  metric?: MetricLike | null;
  transactions?: TransactionLike[];
  inventory?: InventoryLike[];
  checklistEntries?: ChecklistEntryLike[];
  todayISO?: string;
}): CommandCenterRiskResult {
  const { business, metric = null } = args;
  const businessId = Number(business?.id);
  const transactions = (args.transactions || []).filter((t) => Number(t.businessId) === businessId && completedTxn(t));
  const nonSeededTx = transactions.filter((t) => !seededBaselineTxn(t));
  const inventory = (args.inventory || []).filter((i) => Number(i.businessId) === businessId);
  const checklistEntries = (args.checklistEntries || []).filter((e) => Number(e.businessId) === businessId);
  const todayISO = args.todayISO || new Date().toLocaleDateString("en-CA");

  const metricAlreadyIncludesLive = metric?.baselineTxId != null && Number.isFinite(Number(metric.baselineTxId));
  const txIncome = nonSeededTx.filter((t) => String(t.type).toUpperCase() === "INCOME").reduce((s, t) => s + num(t.amountGhs), 0);
  const txExpense = nonSeededTx.filter((t) => String(t.type).toUpperCase() === "EXPENSE").reduce((s, t) => s + num(t.amountGhs), 0);

  const revenue = num(metric?.revenueGhs) + (metricAlreadyIncludesLive ? 0 : txIncome);
  const expenses = num(metric?.expensesGhs) + (metricAlreadyIncludesLive ? 0 : txExpense);
  const baseNetProfit = metric?.netProfitGhs != null ? num(metric.netProfitGhs) : num(metric?.revenueGhs) - num(metric?.expensesGhs);
  const netProfit = baseNetProfit + (metricAlreadyIncludesLive ? 0 : txIncome - txExpense);
  const cashFlow = num(metric?.cashFlowGhs) + (metricAlreadyIncludesLive ? 0 : txIncome - txExpense);
  const assetsValue = num(metric?.assetsValueGhs);
  const inventoryValue = num(metric?.inventoryValueGhs);
  const growthRate = num(metric?.growthRatePercent);
  const legacyRisk = num(metric?.riskScore);

  const outOfStockCount = inventory.filter((i) => String(i.status || "").toUpperCase() === "OUT_OF_STOCK" || num(i.quantity) <= 0).length;
  const lowStockCount = inventory.filter((i) => {
    const qty = num(i.quantity);
    const threshold = num(i.minStockThreshold);
    return String(i.status || "").toUpperCase() === "LOW_STOCK" || (qty > 0 && threshold > 0 && qty <= threshold);
  }).length;
  const stockItemCount = inventory.length;

  const todayEntries = checklistEntries.filter((e) => e.checklistDate === todayISO);
  // If time-zone skew means today's rows are not in the payload yet, fall back
  // to the recent scoped window rather than treating the business as risk-free.
  const checklistScope = todayEntries.length ? todayEntries : checklistEntries;
  const openChecklist = checklistScope.filter((e) => !e.isCompleted).length;
  const criticalOpenChecklist = checklistScope.filter((e) => !e.isCompleted && String(e.priority || "").toUpperCase() === "CRITICAL").length;
  const checklistCompletion = checklistScope.length
    ? 1 - openChecklist / checklistScope.length
    : null;

  // Start from a neutral operating score.  The stored metric risk adjusts this
  // gently when it exists, but default/fallback metric rows can no longer pin
  // a real business to 20/40 forever.
  let risk = 24;
  const drivers: string[] = [];

  // Respect a non-zero metric risk as an advisory prior, not as the answer.
  // Default/new-business metric rows usually carry 20, so this adjustment is
  // small and cannot dominate real operational evidence.
  if (legacyRisk > 0) {
    risk += clamp((legacyRisk - 30) * 0.25, -4, 14);
  }

  // Financial health.
  if (revenue > 0) {
    const expenseRatio = expenses / revenue;
    const margin = netProfit / revenue;
    if (netProfit < 0) {
      risk += 18;
      drivers.push("operating loss");
    } else if (margin < 0.08) {
      risk += 10;
      drivers.push("thin profit margin");
    } else if (margin >= 0.25) {
      risk -= 4;
    }
    if (expenseRatio > 1) {
      risk += 8;
      drivers.push("expenses exceed revenue");
    } else if (expenseRatio > 0.85) {
      risk += 5;
      drivers.push("high expense ratio");
    }
  } else if (nonSeededTx.length === 0) {
    risk += 8;
    drivers.push("no live sales/expense activity captured");
  }

  if (cashFlow < 0) {
    risk += 10;
    drivers.push("negative cash flow");
  } else if (expenses > 0 && cashFlow < expenses * 0.15) {
    risk += 4;
    drivers.push("tight cash buffer");
  } else if (cashFlow > expenses * 0.4 && revenue > expenses) {
    risk -= 3;
  }

  if (growthRate < 0) {
    risk += 7;
    drivers.push("negative growth trend");
  } else if (growthRate > 15) {
    risk -= 2;
  }

  // Inventory and stock fulfilment.
  if (stockItemCount > 0) {
    const outRatio = outOfStockCount / stockItemCount;
    const lowRatio = lowStockCount / stockItemCount;
    const stockPenalty = Math.min(26, outOfStockCount * 6 + lowStockCount * 2 + outRatio * 10 + lowRatio * 5);
    risk += stockPenalty;
    if (outOfStockCount) drivers.push(`${outOfStockCount} out-of-stock item${outOfStockCount === 1 ? "" : "s"}`);
    if (lowStockCount) drivers.push(`${lowStockCount} low-stock item${lowStockCount === 1 ? "" : "s"}`);
  } else if (inventoryValue > 0) {
    risk += 5;
    drivers.push("inventory value exists but no stock detail loaded");
  }

  // Daily/operational compliance.  Scale by completion ratio so a generated
  // checklist that is simply waiting to be worked does not stamp every unit
  // with the same +20 penalty.
  if (checklistScope.length > 0) {
    const incompleteRatio = openChecklist / checklistScope.length;
    risk += Math.min(14, incompleteRatio * 10 + criticalOpenChecklist * 4);
    if (criticalOpenChecklist) drivers.push(`${criticalOpenChecklist} critical checklist task${criticalOpenChecklist === 1 ? "" : "s"} open`);
    if (openChecklist && !criticalOpenChecklist) drivers.push("open daily checklist tasks");
  } else {
    risk += 3;
    drivers.push("no daily checklist data in scope");
  }

  // Setup/data completeness signals: real businesses with no operating data
  // are not automatically low risk just because the metric fallback says 20.
  if (!metric) {
    risk += 5;
    drivers.push("no performance metric row");
  }
  if (!business?.managerName) {
    risk += 2;
    drivers.push("manager not assigned");
  }
  if (assetsValue <= 0 && inventoryValue <= 0 && stockItemCount === 0 && nonSeededTx.length === 0) {
    risk += 6;
    drivers.push("setup/data capture incomplete");
  }

  // Reward genuinely clean operations.
  if (
    revenue > 0 &&
    netProfit > 0 &&
    cashFlow >= 0 &&
    outOfStockCount === 0 &&
    lowStockCount === 0 &&
    (checklistCompletion === null || checklistCompletion >= 0.9)
  ) {
    risk -= 6;
  }

  const riskScore = Math.round(clamp(risk, 1, 100));
  return { riskScore, band: commandCenterRiskBand(riskScore), drivers };
}

export function averageRiskScore(rows: { riskScore?: number | null }[]): number {
  const scores = (rows || []).map((r) => num(r.riskScore)).filter((n) => n > 0);
  return scores.length ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : 0;
}
