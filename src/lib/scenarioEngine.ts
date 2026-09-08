/**
 * Scenario & Forecast engine — the single source of truth for GoMina 360
 * what-if projections.
 *
 * BEFORE this engine, the Scenario Planner (UI slider AND /api/scenarios
 * POST) fabricated impacts from hardcoded constants (GH₵850 × %, GH₵12,000
 * per 10%, …) — completely disconnected from the businesses' real revenue,
 * expenses, margins and asset base. Two identical-looking units produced the
 * same "projection", which is meaningless.
 *
 * NOW every impact is COMPUTED from the live baseline:
 *
 *   baseline = seeded 2026-Q1 quarterly close (business_metrics)
 *              + every live transaction dated after the Q1 close
 *              + the live asset register value
 *
 *   Feed/Cement Price +x%  →  cost scenario: profit −x% of the unit's actual
 *                             cost base for that input (matched live spend +
 *                             an industry fallback share of Q1 expenses)
 *   Demand/Price Increase  →  revenue scenario: +x% of quarterly revenue,
 *                             carried to profit at the unit's REAL margin
 *   Branch Expansion       →  +x% of an average unit's quarterly output
 *                             (target unit's own output when scoped)
 *   Everything else        →  blended revenue scenario at 50% pass-through
 *   ROI delta              →  annualised profit impact ÷ asset base × 100
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";

/** End of the seeded quarterly close; transactions after this are live overlay. */
export const SEEDED_QUARTER_END = "2026-03-31";
/** Months in the seeded quarter — used to monthlyise the baseline. */
export const SEEDED_QUARTER_MONTHS = 3;

/** Industry fallback cost shares when no matching live spend exists yet. */
export const FEED_COST_SHARE = 0.45; // poultry/aqua feed ≈ 45% of operating cost
export const CEMENT_COST_SHARE = 0.4; // block/cement raw material ≈ 40%

export interface ScenarioBaseline {
  scope: "enterprise" | "business";
  businessId: number | null;
  /** Quarterly totals (seeded Q1 close + live overlay). */
  revenueQ: number;
  expensesQ: number;
  profitQ: number;
  /** Real net margin, clamped to [0, 0.95] for sane projections. */
  margin: number;
  /** Asset base from the register (falls back to the seeded metric sum). */
  assetsValueQ: number;
  /** Live overlay detail (post-Q1 transactions). */
  liveCount: number;
  liveIncomeQ: number;
  liveExpenseQ: number;
  /** Quarterly cost bases for input-price scenarios. */
  costBaseFeedQ: number;
  costBaseCementQ: number;
  /** Average quarterly revenue of one operating unit (expansion scenarios). */
  avgUnitRevenueQ: number;
  monthlyRevenue: number;
  monthlyExpenses: number;
}

export interface ScenarioImpacts {
  revenueImpact: number;
  profitImpact: number;
  roiDelta: number;
  /** Human-readable derivation, e.g. "GH₵242,136/qtr revenue · 24.8% margin". */
  basis: string;
}

const round0 = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
const ghs = (n: number) => `GH₵ ${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/** Live overlay = everything EXCEPT the seeded ledger rows that the
 *  quarterly metrics already contain (TRX-<year>-1001..1006 — the same
 *  predicate financeReport's isSeededBaselineTxn applies client-side). */
const LIVE_TX_WHERE = `transaction_number !~ '^TRX-\\d{4}-100[1-6]$' AND status <> 'CANCELLED'`;

export async function computeScenarioBaseline(businessId?: number | null): Promise<ScenarioBaseline> {
  const scoped = businessId != null && Number.isFinite(Number(businessId)) && Number(businessId) > 0;
  const bizId = scoped ? Number(businessId) : null;
  const bizFilter = bizId != null ? sql`AND business_id = ${bizId}` : sql``;

  const [m] = (
    await db.execute(sql`
      SELECT COALESCE(SUM(revenue_ghs),0)::float rev, COALESCE(SUM(expenses_ghs),0)::float exp,
             COALESCE(SUM(assets_value_ghs),0)::float assets, COUNT(*)::int units
      FROM business_metrics WHERE 1=1 ${bizFilter}`)
  ).rows as any[];
  const seededRev = Number(m?.rev) || 0;
  const seededExp = Number(m?.exp) || 0;
  const seededAssets = Number(m?.assets) || 0;
  const units = Math.max(1, Number(m?.units) || 1);

  const [live] = (
    await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN type='INCOME' THEN amount_ghs ELSE 0 END),0)::float inc,
        COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount_ghs ELSE 0 END),0)::float exp,
        COUNT(*)::int c,
        COALESCE(SUM(CASE WHEN type='EXPENSE' AND (category ILIKE '%feed%' OR category ILIKE '%maize%' OR category ILIKE '%concentrate%') THEN amount_ghs ELSE 0 END),0)::float feed,
        COALESCE(SUM(CASE WHEN type='EXPENSE' AND (category ILIKE '%cement%' OR category ILIKE '%aggregate%' OR category ILIKE '%sand %' OR category ILIKE '%cement%') THEN amount_ghs ELSE 0 END),0)::float cement
      FROM transactions
      WHERE ${sql.raw(LIVE_TX_WHERE)} ${bizFilter}`)
  ).rows as any[];
  const liveInc = Number(live?.inc) || 0;
  const liveExp = Number(live?.exp) || 0;
  const liveCount = Number(live?.c) || 0;
  const liveFeed = Number(live?.feed) || 0;
  const liveCement = Number(live?.cement) || 0;

  const [a] = (
    await db.execute(sql`
      SELECT COALESCE(SUM(current_value_ghs),0)::float v FROM assets WHERE 1=1 ${bizFilter}`)
  ).rows as any[];
  const liveAssets = Number(a?.v) || 0;

  const revenueQ = seededRev + liveInc;
  const expensesQ = seededExp + liveExp;
  const profitQ = revenueQ - expensesQ;
  const margin = revenueQ > 0 ? Math.min(0.95, Math.max(0, profitQ / revenueQ)) : 0;
  const assetsValueQ = liveAssets > 0 ? liveAssets : seededAssets;

  // Cost bases: matched live spend + the industry-share estimate of the
  // seeded expense close (the seed has no per-category split).
  const costBaseFeedQ = liveFeed + FEED_COST_SHARE * seededExp;
  const costBaseCementQ = liveCement + CEMENT_COST_SHARE * seededExp;

  // Average output of one operating unit inside this scope (expansion
  // scenarios reference it when running enterprise-wide).
  const avgUnitRevenueQ = revenueQ / units;

  return {
    scope: bizId == null ? "enterprise" : "business",
    businessId: bizId,
    revenueQ,
    expensesQ,
    profitQ,
    margin,
    assetsValueQ,
    liveCount,
    liveIncomeQ: liveInc,
    liveExpenseQ: liveExp,
    costBaseFeedQ,
    costBaseCementQ,
    avgUnitRevenueQ,
    monthlyRevenue: revenueQ / SEEDED_QUARTER_MONTHS,
    monthlyExpenses: expensesQ / SEEDED_QUARTER_MONTHS,
  };
}

const isCostVar = (v: string) => /feed|maize|concentrate/i.test(v);
const isCementVar = (v: string) => /cement|aggregate|sand|block\s*raw/i.test(v);
const isExpansionVar = (v: string) => /branch|expansion|production|new\s*unit/i.test(v);
const isRevenueVar = (v: string) => /demand|price\s*increase|sales|market/i.test(v);

/** Compute quarterly what-if impacts from a REAL baseline. */
export function computeScenarioImpacts(
  variableChanged: string,
  percentChange: number,
  b: ScenarioBaseline,
): ScenarioImpacts {
  const v = String(variableChanged || "Market Factor");
  const pct = Number(percentChange) || 0;
  const p = pct / 100;
  let revenueImpact = 0;
  let profitImpact = 0;
  let basis = "";

  if (isCostVar(v) || isCementVar(v)) {
    // Input-cost scenario: no revenue change; profit moves against the
    // unit's actual cost base for that input.
    const costBase = isCostVar(v) ? b.costBaseFeedQ : b.costBaseCementQ;
    const share = isCostVar(v) ? FEED_COST_SHARE : CEMENT_COST_SHARE;
    revenueImpact = 0;
    profitImpact = -p * costBase;
    basis = `${ghs(costBase)}/qtr ${isCostVar(v) ? "feed" : "cement"} cost base (live spend + ${Math.round(share * 100)}% industry share of seeded costs)`;
  } else if (isRevenueVar(v) && !isExpansionVar(v)) {
    // Demand/price scenario: revenue scales; the REAL margin carries it to profit.
    revenueImpact = p * b.revenueQ;
    profitImpact = revenueImpact * b.margin;
    basis = `${ghs(b.revenueQ)}/qtr revenue · ${(b.margin * 100).toFixed(1)}% margin`;
  } else if (isExpansionVar(v)) {
    // Expansion: adds a fraction of the reference unit's quarterly output.
    const ref = b.scope === "business" ? b.revenueQ : b.avgUnitRevenueQ;
    revenueImpact = p * ref;
    profitImpact = revenueImpact * b.margin;
    basis = `${ghs(ref)}/qtr reference output (${b.scope === "business" ? "this unit" : "average unit"}) · ${(b.margin * 100).toFixed(1)}% margin`;
  } else {
    // Blended market factor: conservative 50% revenue pass-through.
    revenueImpact = 0.5 * p * b.revenueQ;
    profitImpact = revenueImpact * b.margin;
    basis = `${ghs(b.revenueQ)}/qtr revenue · ${(b.margin * 100).toFixed(1)}% margin (50% pass-through)`;
  }

  const roiDelta =
    b.assetsValueQ > 0
      ? round1(((profitImpact * 4) / b.assetsValueQ) * 100) // annualised ÷ asset base
      : round1(b.revenueQ > 0 ? (profitImpact / b.revenueQ) * 100 : 0);

  return {
    revenueImpact: round0(revenueImpact),
    profitImpact: round0(profitImpact),
    roiDelta,
    basis,
  };
}
