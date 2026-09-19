/**
 * Feed-Mill analytics — pure data-in/data-out (no React), mirroring the
 * discipline of poultryPerformance.ts so every figure can be re-derived and
 * verified straight from the database. Consumed by the Feed Mill tab and by
 * the verification suite.
 *
 * FINANCE INVARIANT (asserted in tests): ingredient spend is expensed ONCE at
 * purchase intake; batch costs are derived from the stock-draw and are never
 * re-booked; own-mill consumption never creates a transaction.
 */
import { formatMoney } from "./currency";

export type FmAlertLevel = "critical" | "warning" | "normal";
export interface FmAlert {
  id: string;
  level: FmAlertLevel;
  category: "Raw Materials" | "Finished Feed" | "Quality" | "Cost" | "Production";
  title: string;
  message: string;
  recommendation: string;
  value?: string;
  threshold?: string;
  /** criticals also fan out to the bell (server-side, on the triggering write) */
  criticalType?: string;
}

export interface FeedMillKpis {
  finishedFeedKg: number;
  daysOfFeed: number | null; // against recent own-mill+purchased consumption burn
  rawMaterialCoverageDays: number | null; // most-binding BOM ingredient
  rawMaterialLowItems: number;
  producedKg: number;
  consumedOwnMillKg: number;
  batchCount: number;
  releasedCount: number;
  holdCount: number;
  rejectedCount: number;
  lastBatch: null | {
    batchNumber: string;
    costPerKgGhs: number;
    yieldPct: number | null;
    status: string;
    daysAgo: number;
  };
  commercialBaselineGhs: number | null; // per-kg reference used for savings
  baselineSource: "FORMULATION_REF" | "PURCHASE_AVG" | null;
  savingPerKgGhs: number | null;
  savingAllTimeGhs: number;
  avgYieldPct: number | null;
  avgCostPerKgGhs: number | null;
  costPerKgTrend: { batchNumber: string; costPerKgGhs: number; productionDate: string }[];
}

const TODAY = () => new Date().toISOString().split("T")[0];
const daysAgoStr = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; };
const daysFrom = (dateStr?: string | null) => {
  if (!dateStr) return 9999;
  const a = new Date(`${dateStr}T00:00:00Z`);
  const n = new Date(`${TODAY()}T00:00:00Z`);
  return Math.round((n.getTime() - a.getTime()) / 86400000);
};

interface Input {
  formulations: any[];
  formulationItems: any[];
  batches: any[];
  batchInputs: any[];
  qcChecks: any[];
  /** inventory rows for the business (raw materials + finished feeds) */
  inventory: any[];
  /** poultry_feed_logs rows for the business (all entries, any source) */
  feedLogs: any[];
  currentCurrency: string;
}

const RAW_CAT = /feed raw materials/i;
const MILL_CAT = /animal feed \(milled\)/i;

export const isRawMaterialItem = (i: any) => RAW_CAT.test(`${i.category}`);
export const isMilledFeedItem = (i: any) => MILL_CAT.test(`${i.category}`);

/** Average kg/day consumed over the last 14 recorded days (any source). */
function recentDailyBurn(feedLogs: any[]): number {
  const from = daysAgoStr(14);
  const rows = feedLogs.filter((f) => f.entryType === "CONSUMPTION" && f.recordedDate >= from);
  const days = new Set(rows.map((f) => f.recordedDate)).size;
  if (!days) return 0;
  return rows.reduce((s, f) => s + (f.quantityKg || 0), 0) / days;
}

/** Historical commercial purchase average (GH₵/kg) over the last 90 days. */
export function commercialPurchaseAvg(feedLogs: any[]): number | null {
  const from = daysAgoStr(90);
  const rows = feedLogs.filter(
    (f) => f.entryType === "PURCHASE" && (f.quantityKg || 0) > 0 && (f.costPerKgGhs || 0) > 0 && f.recordedDate >= from,
  );
  if (!rows.length) return null;
  const kg = rows.reduce((s, f) => s + f.quantityKg, 0);
  return kg > 0 ? rows.reduce((s, f) => s + f.quantityKg * f.costPerKgGhs, 0) / kg : null;
}

export function computeFeedMillAnalytics(inp: Input): { kpis: FeedMillKpis; alerts: FmAlert[] } {
  const { formulations, formulationItems, batches, batchInputs, qcChecks, inventory, feedLogs, currentCurrency } = inp;
  const today = TODAY();
  const alerts: FmAlert[] = [];
  const money = (v: number) => formatMoney(v, currentCurrency as any);

  const rawItems = inventory.filter(isRawMaterialItem);
  const millFeeds = inventory.filter(isMilledFeedItem);
  const finishedFeedKg = millFeeds.reduce((s, i) => s + (i.quantity || 0), 0);

  const burn = recentDailyBurn(feedLogs);
  const daysOfFeed = burn > 0 ? Math.round((finishedFeedKg / burn) * 10) / 10 : null;

  // Most-binding raw-material coverage: for every ingredient referenced by an
  // ACTIVE formulation, days = stock ÷ daily draw under full production burn.
  const activeForms = formulations.filter((f) => f.active !== false);
  const bomIngredients = new Set(
    formulationItems.filter((it) => activeForms.some((f) => f.id === it.formulationId)).map((it) => it.inventoryId),
  );
  let coverage: number | null = null;
  let bindingItem: any = null;
  if (burn > 0) {
    for (const invId of bomIngredients) {
      const item = rawItems.find((i) => i.id === invId);
      if (!item) continue;
      const days = (item.quantity || 0) / burn;
      if (coverage === null || days < coverage) { coverage = days; bindingItem = item; }
    }
  }
  const rawMaterialCoverageDays = coverage != null ? Math.round(coverage * 10) / 10 : null;

  const lowStock = rawItems.filter((i) => (i.quantity || 0) <= 0 || i.quantity <= (i.minStockThreshold || 0));
  const outStock = rawItems.filter((i) => (i.quantity || 0) <= 0);

  const holdCount = batches.filter((b) => b.status === "QC_HOLD" || b.status === "MIXING").length;
  const releasedCount = batches.filter((b) => b.status === "RELEASED").length;
  const rejectedCount = batches.filter((b) => b.status === "REJECTED").length;
  const producedKg = batches.filter((b) => b.status !== "REJECTED").reduce((s, b) => s + (b.stockedQtyKg || 0), 0);
  const consumedOwnMillKg = feedLogs
    .filter((f) => f.entryType === "CONSUMPTION" && f.sourceType === "OWN_MILL")
    .reduce((s, f) => s + (f.quantityKg || 0), 0);

  const sortedBatches = [...batches]
    .filter((b) => b.status !== "REJECTED")
    .sort((a, b) => (b.productionDate || "").localeCompare(a.productionDate || "") || (b.id - a.id));
  const last = sortedBatches[0] || null;
  const costTrend = sortedBatches
    .filter((b) => (b.costPerKgGhs || 0) > 0)
    .slice(0, 12)
    .reverse()
    .map((b) => ({ batchNumber: b.batchNumber, costPerKgGhs: b.costPerKgGhs, productionDate: b.productionDate }));

  const avgCostPerKg = (() => {
    const xs = sortedBatches.filter((b) => (b.costPerKgGhs || 0) > 0).map((b) => b.costPerKgGhs);
    return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null;
  })();
  const avgYieldPct = (() => {
    const xs = sortedBatches.filter((b) => (b.yieldPct || 0) > 0).map((b) => b.yieldPct);
    return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null;
  })();

  // Savings baseline: the LAST BATCH's formulation reference price (explicit
  // configuration wins), otherwise the business's own purchase average.
  let baseline: number | null = null;
  let baselineSource: FeedMillKpis["baselineSource"] = null;
  if (last) {
    const form = formulations.find((f) => f.id === last.formulationId);
    if (form && (form.commercialRefPriceGhs || 0) > 0) {
      baseline = form.commercialRefPriceGhs;
      baselineSource = "FORMULATION_REF";
    }
  }
  if (baseline == null) {
    baseline = commercialPurchaseAvg(feedLogs);
    if (baseline != null) baselineSource = "PURCHASE_AVG";
  }
  const savingPerKg =
    baseline != null && last && (last.costPerKgGhs || 0) > 0 ? +(baseline - last.costPerKgGhs).toFixed(3) : null;

  // All-time savings ≈ (chosen per-formulation baseline − batch cost) × batch kg
  let savingAllTime = 0;
  const purchaseAvgAll = commercialPurchaseAvg(feedLogs);
  for (const b of sortedBatches) {
    const form = formulations.find((f) => f.id === b.formulationId);
    const ref = (form?.commercialRefPriceGhs || 0) > 0 ? form!.commercialRefPriceGhs! : purchaseAvgAll;
    if (ref != null && (b.costPerKgGhs || 0) > 0) savingAllTime += (ref - b.costPerKgGhs) * (b.stockedQtyKg || 0);
  }
  savingAllTime = Math.round(savingAllTime * 100) / 100;

  // ── alerts ────────────────────────────────────────────────────────────
  if (outStock.length) {
    alerts.push({
      id: "fm-raw-out", level: "critical", category: "Raw Materials",
      title: "Raw material out of stock",
      message: `${outStock.length} ingredient(s) are out: ${outStock.map((i) => i.name).slice(0, 3).join(", ")}. Production is blocked from running BOM draws.`,
      recommendation: "Top up immediately from the Raw Materials tab (one-step intake) or raise a supplier order.",
      value: `${outStock.length} out`, threshold: "0", criticalType: "FEED_RAW_OUT",
    });
  } else if (lowStock.length) {
    alerts.push({
      id: "fm-raw-low", level: "warning", category: "Raw Materials",
      title: "Raw materials running low",
      message: `${lowStock.length} ingredient(s) are at/below threshold: ${lowStock.map((i) => i.name).slice(0, 3).join(", ")}.`,
      recommendation: "Plan the next intake before the next production run.",
      value: `${lowStock.length} low`, threshold: "0",
    });
  } else if (rawItems.length) {
    alerts.push({
      id: "fm-raw-ok", level: "normal", category: "Raw Materials",
      title: "Raw materials healthy",
      message: rawMaterialCoverageDays != null && bindingItem
        ? `${rawMaterialCoverageDays} days of coverage at the current burn (binding: ${bindingItem.name}).`
        : `${rawItems.length} ingredient(s) on hand.`,
      recommendation: "Keep ≥ 5 days of the most-binding ingredient.",
      threshold: "≥ 5 days",
    });
  }

  if (finishedFeedKg <= 0 && batches.length > 0) {
    alerts.push({
      id: "fm-feed-out", level: "critical", category: "Finished Feed",
      title: "No milled feed in stock",
      message: "Finished-feed inventory is empty. Birds on own-mill rations will fall back to commercial purchases.",
      recommendation: "Schedule a production run and release it after QC.",
      value: "0 kg", threshold: "> 0", criticalType: "FEED_MILL_OUT",
    });
  } else if (daysOfFeed != null && daysOfFeed < 3 && finishedFeedKg > 0) {
    alerts.push({
      id: "fm-feed-low", level: "warning", category: "Finished Feed",
      title: "Milled feed cover below 3 days",
      message: `Only ~${daysOfFeed} days of finished feed (${finishedFeedKg.toFixed(0)} kg) at the current consumption rate.`,
      recommendation: "Queue the next batch now; QC + release takes hours, not days.",
      value: `${daysOfFeed} days`, threshold: "≥ 3 days",
    });
  } else if (finishedFeedKg > 0) {
    alerts.push({
      id: "fm-feed-ok", level: "normal", category: "Finished Feed",
      title: "Finished feed stock healthy",
      message: daysOfFeed != null
        ? `${finishedFeedKg.toFixed(0)} kg milled ≈ ${daysOfFeed} days of feed.`
        : `${finishedFeedKg.toFixed(0)} kg milled feed in stock.`,
      recommendation: "Keep ≥ 3 days of finished feed.",
      threshold: "≥ 3 days",
    });
  }

  if (holdCount > 0) {
    const oldestHold = batches.filter((b) => b.status === "QC_HOLD" || b.status === "MIXING")
      .sort((a, b) => (a.productionDate || "").localeCompare(b.productionDate || ""))[0];
    const heldDays = daysFrom(oldestHold?.productionDate);
    alerts.push({
      id: "fm-qc-hold", level: heldDays >= 2 ? "warning" : "normal", category: "Quality",
      title: `${holdCount} batch(es) on QC hold`,
      message: heldDays >= 2
        ? `Oldest held batch ${oldestHold?.batchNumber || ""} has waited ${heldDays} days — held feed cannot be consumed or sold.`
        : `${holdCount} batch(es) awaiting a finished-feed QC pass. They stay locked until released.`,
      recommendation: "Run the finished-feed checks (moisture, texture, bagging weight) and release or reject each batch.",
      value: `${heldDays >= 9000 ? "—" : `${heldDays}d`} held`, threshold: "< 2 days",
    });
  }

  const failedToday = qcChecks.filter((q) => q.passFail === "FAIL" && String(q.testedAt || "").slice(0, 10) === today);
  if (failedToday.length) {
    alerts.push({
      id: "fm-qc-fail", level: "critical", category: "Quality",
      title: "QC failure today",
      message: `${failedToday.length} check(s) failed today (${failedToday.map((q) => q.testName).slice(0, 2).join(", ")}).`,
      recommendation: "Investigate the batch, adjust moisture/grind or reject — failed batches never reach the flock.",
      value: `${failedToday.length} FAIL`, threshold: "0", criticalType: "FEED_QC_FAIL",
    });
  }

  if (savingPerKg != null) {
    if (savingPerKg < 0) {
      alerts.push({
        id: "fm-cost-high", level: "warning", category: "Cost",
        title: "Milling costs more than buying",
        message: `Last batch cost ${money(last!.costPerKgGhs)}/kg vs the ${money(baseline!)}/kg commercial baseline — milling loses ${money(Math.abs(savingPerKg))} per kg right now.`,
        recommendation: "Renegotiate the biggest BOM ingredient, raise batch yield, or pause milling until raw-material prices ease.",
        value: `${money(savingPerKg)}/kg`, threshold: "≥ 0",
      });
    } else {
      alerts.push({
        id: "fm-cost-ok", level: "normal", category: "Cost",
        title: "In-house milling is saving money",
        message: `Last batch at ${money(last!.costPerKgGhs)}/kg vs ${money(baseline!)}/kg baseline: saving ${money(savingPerKg)} on every kg milled.`,
        recommendation: "Track the trend per batch — alert drift if ingredient prices climb.",
        value: `${money(savingPerKg)}/kg`, threshold: "≥ 0",
      });
    }
  }

  const trend = costTrend;
  if (trend.length >= 2) {
    const first = trend[0].costPerKgGhs, lastC = trend[trend.length - 1].costPerKgGhs;
    const drift = first > 0 ? ((lastC - first) / first) * 100 : 0;
    if (Math.abs(drift) >= 15) {
      alerts.push({
        id: "fm-cost-drift", level: "warning", category: "Cost",
        title: "Batch cost drift",
        message: `Cost/kg moved ${drift >= 0 ? "+" : ""}${drift.toFixed(0)}% across the last ${trend.length} batches (${money(first)} → ${money(lastC)}).`,
        recommendation: drift > 0
          ? "Check which BOM line's unit cost moved — the batch input ledger keeps the snapshots."
          : "Falling costs confirmed — lock supplier prices while the saving holds.",
        value: `${drift.toFixed(0)}%`, threshold: "±15%",
      });
    }
  }

  const kpis: FeedMillKpis = {
    finishedFeedKg: +finishedFeedKg.toFixed(1),
    daysOfFeed,
    rawMaterialCoverageDays,
    rawMaterialLowItems: lowStock.length,
    producedKg: +producedKg.toFixed(1),
    consumedOwnMillKg: +consumedOwnMillKg.toFixed(1),
    batchCount: batches.length,
    releasedCount,
    holdCount,
    rejectedCount,
    lastBatch: last
      ? {
          batchNumber: last.batchNumber,
          costPerKgGhs: last.costPerKgGhs || 0,
          yieldPct: last.yieldPct ?? null,
          status: last.status,
          daysAgo: daysFrom(last.productionDate),
        }
      : null,
    commercialBaselineGhs: baseline != null ? +baseline.toFixed(3) : null,
    baselineSource,
    savingPerKgGhs: savingPerKg,
    savingAllTimeGhs: savingAllTime,
    avgYieldPct,
    avgCostPerKgGhs: avgCostPerKg,
    costPerKgTrend: costTrend,
  };
  return { kpis, alerts };
}
