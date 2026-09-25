// Pure Fish/Batch Performance Benchmarking engine for the Aquaculture module —
// the aquatic adaptation of poultryBenchmarking.ts (same architecture, same
// data-in/data-out contract, no React, no DB). Every number the Fish Farm
// dashboard renders is reproducible from the database.
//
// What it does:
//   1. Resolves a Benchmark Profile for a batch (explicit override →
//      auto-match by species / strain → null = built-in species standard).
//   2. Computes AGE-MATCHED actuals for the batch (avg weight, SGR, ADG,
//      feed intake as % biomass/day, FCR incl. harvested kg, survival,
//      stocking density, feed cost per kg gain, all-in production cost per
//      kg fish, harvest economics …).
//   3. Matches COMPARABLE HISTORICAL BATCHES (closed batches + older growing
//      batches of the same species) and builds p25 / median / p75 bands per
//      week of age for every metric.
//   4. Emits KPIs with variance vs target & vs farm history, an A–D
//      scorecard, a harvest close-out projection and alert-shaped findings
//      that drop straight into the existing AI Smart Alerts grid.
//
// Fallback contract: when no profile resolves AND no comparable history
// exists, `hasAnyBenchmark` is false and callers render nothing new — the
// app behaves exactly as before (fishPerformance.speciesTargetG keeps
// driving the existing growth charts).

import type { AquaAlert } from "./aquacultureAnalytics";
import { speciesTargetG } from "./fishPerformance";

// ─── Types ────────────────────────────────────────────────────────────────

export type FishBenchmarkMetricKey =
  | "AVG_WEIGHT_G"
  | "SGR_PCT"
  | "ADG_G"
  | "FCR"
  | "FEED_RATE_PCT_BIOMASS"
  | "SURVIVAL_PCT"
  | "STOCKING_DENSITY_KG_M3"
  | "FEED_COST_PER_KG_GAIN"
  | "COST_PER_KG_FISH";

export interface FishBenchmarkCurveDef {
  by: "ageDays" | "ageWeeks";
  unit?: string;
  warnPct?: number;
  critPct?: number;
  points: [number, number][];
}

export interface FishBenchmarkCurveMeta {
  harvestAgeDays?: number;
  livePricePerKgGhs?: number;
}

export type FishBenchmarkCurves = Partial<Record<FishBenchmarkMetricKey, FishBenchmarkCurveDef>> & {
  _meta?: FishBenchmarkCurveMeta;
};

export interface FishBenchmarkProfileLike {
  id?: number;
  name: string;
  species: string;
  strain?: string | null;
  source?: string;
  status?: string;
  isDefault?: boolean;
  toleranceWarnPct?: number | null;
  toleranceCritPct?: number | null;
  curves?: FishBenchmarkCurves | null;
  notes?: string | null;
}

export interface FishBenchmarkDataBundle {
  batches: any[];
  feedLogs: any[];
  harvests: any[];
  weightLogs: any[];
  ponds?: any[];
}

export interface FishBenchmarkKpi {
  key: FishBenchmarkMetricKey;
  label: string;
  unit: string;
  actual: number | null;
  target: number | null;
  histMedian: number | null;
  histBest: number | null;
  /** Signed variance vs target (%). Positive = above target. */
  variancePct: number | null;
  /** Direction-aware drift vs target (%). Positive = ahead of target. */
  driftPct: number | null;
  /** Direction-aware drift vs farm-history median (%). */
  histDriftPct: number | null;
  status: "ON_TRACK" | "WATCH" | "OFF_TRACK" | "NO_DATA";
  better: "higher" | "lower";
  note?: string;
}

export interface FishBenchmarkSeriesRow {
  age: string;
  week: number;
  actual?: number | null;
  target?: number | null;
  histMedian?: number | null;
  histP25?: number | null;
  histP75?: number | null;
}

export interface HarvestProjection {
  harvestAgeDays: number;
  daysRemaining: number;
  currentWeightKg: number | null;
  projectedWeightKg: number | null;
  targetWeightKg: number | null | undefined;
  projectedFcr: number | null;
  feedKgRemaining: number | null;
  feedCostRemainingGhs: number | null;
  costPerKgToDateGhs: number | null;
  projectedCostPerKgGhs: number | null;
  livePricePerKgGhs: number;
  revenuePerFishGhs: number | null;
  marginPerFishGhs: number | null;
  marginTotalGhs: number | null;
  assumptions: string[];
}

export interface FishBenchmarkResult {
  batch: any;
  profile: FishBenchmarkProfileLike | null;
  profileResolvedBy: "explicit" | "auto" | null;
  actuals: FishBatchActuals;
  kpis: FishBenchmarkKpi[];
  series: Partial<Record<FishBenchmarkMetricKey, FishBenchmarkSeriesRow[]>>;
  history: { batch: any; note: string | null }[];
  scorecard: { grade: "A" | "B" | "C" | "D" | null; compliancePct: number | null; evaluated: number };
  projection: HarvestProjection | null;
  hasAnyBenchmark: boolean;
}

export interface FishBatchActuals {
  ageDays: number;
  ageWeeks: number;
  weightG: number | null;
  weightKg: number | null;
  adgG: number | null;
  sgrPct: number | null;
  totalFeedKg: number;
  feedCostGhs: number | null;
  feedCostPerKg: number | null;
  feedRatePctBiomass: number | null;
  fcr: number | null;
  survivalPct: number | null;
  cumMortPct: number | null;
  stockingDensityKgM3: number | null;
  biomassKg: number | null;
  fingerlingCostGhs: number;
  feedCostPerKgGain: number | null;
  productionKg: number | null;
  costPerKgFishGhs: number | null;
  harvestedCount: number;
  harvestedKg: number;
  harvestRevenueGhs: number;
  revenuePerKgGhs: number | null;
  weightSamples: { date: string; g: number; ageDays: number }[];
}

// ─── Small helpers ────────────────────────────────────────────────────────

const TODAY = () => new Date().toISOString().split("T")[0];

export const fishAgeDaysOf = (batch: any, date: string) =>
  batch?.hatchDate
    ? Math.max(0, Math.round((new Date(date).getTime() - new Date(batch.hatchDate).getTime()) / 86400000))
    : 0;

const norm = (s: any) => String(s || "").trim().toLowerCase();

/** Piecewise-linear interpolation on a curve's [age, value] points. */
export function interpolateFishCurve(points: [number, number][] | undefined | null, x: number): number | null {
  if (!points || !points.length) return null;
  const pts = points
    .filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
    .sort((a, b) => +a[0] - +b[0]);
  if (!pts.length) return null;
  if (x <= +pts[0][0]) return +pts[0][1];
  if (x >= +pts[pts.length - 1][0]) return +pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= +pts[i][0]) {
      const [x0, y0] = pts[i - 1].map(Number) as [number, number];
      const [x1, y1] = pts[i].map(Number) as [number, number];
      return x1 === x0 ? y1 : +(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)).toFixed(4);
    }
  }
  return +pts[pts.length - 1][1];
}

/** Curve value at a batch age. `by: "ageWeeks"` curves take age/7. */
export function fishCurveAt(
  curves: FishBenchmarkCurves | null | undefined,
  key: FishBenchmarkMetricKey,
  ageDays: number,
): number | null {
  const def = curves?.[key];
  if (!def) return null;
  return interpolateFishCurve(def.points, def.by === "ageWeeks" ? ageDays / 7 : ageDays);
}

const quantile = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : +(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(4);
};

const round = (v: number | null | undefined, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : +(+v).toFixed(dp);

// ─── Built-in templates (seed content for "Copy from Template") ───────────
// Weight curves mirror fishPerformance.speciesTargetG so a farm that adopts
// a template sees identical targets to today's species-standard charts.

export const FISH_BENCHMARK_TEMPLATES: FishBenchmarkProfileLike[] = [
  {
    name: "Tilapia Standard — Volta / Red (500g @ 28 weeks)",
    species: "VOLTA_TILAPIA",
    strain: null,
    source: "TEMPLATE",
    curves: {
      AVG_WEIGHT_G: {
        by: "ageDays", unit: "g",
        points: [[0, 2], [28, 15], [56, 60], [84, 140], [112, 240], [140, 340], [168, 430], [196, 520]],
      },
      // No SGR_PCT curve on purpose: the engine DERIVES the SGR target from
      // the weight curve over each batch's own sample window — always
      // apples-to-apples. (Owners can still define an explicit curve.)
      FCR: {
        by: "ageDays", unit: "",
        points: [[28, 0.9], [56, 1.0], [84, 1.1], [112, 1.2], [140, 1.3], [168, 1.4], [196, 1.5]],
      },
      // Feeding-rate curve is self-consistent with FCR × daily-gain ÷ weight
      // from the weight curve (fry ~8%/day down to ~1%/day at market size).
      FEED_RATE_PCT_BIOMASS: {
        by: "ageDays", unit: "% biomass/day",
        points: [[14, 8], [28, 6], [56, 4.3], [84, 3.2], [112, 2.3], [140, 1.7], [168, 1.3], [196, 1.1]],
      },
      SURVIVAL_PCT: {
        by: "ageDays", unit: "%",
        points: [[28, 97], [56, 95], [84, 93], [112, 91], [140, 90], [168, 89], [196, 88]],
      },
      _meta: { harvestAgeDays: 196, livePricePerKgGhs: 62 },
    },
  },
  {
    name: "African Catfish Standard (1.15kg @ 28 weeks)",
    species: "AFRICAN_CATFISH",
    strain: null,
    source: "TEMPLATE",
    curves: {
      AVG_WEIGHT_G: {
        by: "ageDays", unit: "g",
        points: [[0, 1], [28, 20], [56, 90], [84, 220], [112, 420], [140, 650], [168, 900], [196, 1150]],
      },
      FCR: {
        by: "ageDays", unit: "",
        points: [[28, 0.8], [56, 0.9], [84, 1.0], [112, 1.05], [140, 1.1], [168, 1.15], [196, 1.2]],
      },
      FEED_RATE_PCT_BIOMASS: {
        by: "ageDays", unit: "% biomass/day",
        points: [[14, 10], [28, 8], [56, 4.1], [84, 3.0], [112, 2.3], [140, 1.7], [168, 1.3], [196, 1.05]],
      },
      SURVIVAL_PCT: {
        by: "ageDays", unit: "%",
        points: [[28, 96], [56, 93], [84, 91], [112, 90], [140, 89], [168, 88], [196, 87]],
      },
      _meta: { harvestAgeDays: 196, livePricePerKgGhs: 52 },
    },
  },
];

/** Metric display metadata: label, unit and which direction is "better". */
export const FISH_BENCHMARK_METRIC_META: Record<
  FishBenchmarkMetricKey,
  { label: string; unit: string; better: "higher" | "lower" }
> = {
  AVG_WEIGHT_G: { label: "Avg fish weight", unit: "g", better: "higher" },
  SGR_PCT: { label: "SGR (specific growth rate)", unit: "%/day", better: "higher" },
  ADG_G: { label: "Daily gain", unit: "g/day", better: "higher" },
  FCR: { label: "FCR (feed ÷ gain)", unit: "", better: "lower" },
  FEED_RATE_PCT_BIOMASS: { label: "Feeding rate", unit: "% biomass/day", better: "lower" },
  SURVIVAL_PCT: { label: "Survival", unit: "%", better: "higher" },
  STOCKING_DENSITY_KG_M3: { label: "Stocking density", unit: "kg/m³", better: "lower" },
  FEED_COST_PER_KG_GAIN: { label: "Feed cost / kg fish", unit: "", better: "lower" },
  COST_PER_KG_FISH: { label: "Production cost / kg fish", unit: "", better: "lower" },
};

const SCORECARD_WEIGHTS: Partial<Record<FishBenchmarkMetricKey, number>> = {
  AVG_WEIGHT_G: 3, FCR: 3, SURVIVAL_PCT: 3,
  SGR_PCT: 2, FEED_COST_PER_KG_GAIN: 2,
  ADG_G: 1, FEED_RATE_PCT_BIOMASS: 1, STOCKING_DENSITY_KG_M3: 1, COST_PER_KG_FISH: 1,
};

// ─── Profile resolution ───────────────────────────────────────────────────

/** Explicit batch override → auto-match (species, then strain, prefer
 *  isDefault, newest first). Returns null when nothing fits. */
export function resolveFishProfile(
  batch: any,
  profiles: FishBenchmarkProfileLike[] | undefined | null,
): { profile: FishBenchmarkProfileLike | null; resolvedBy: "explicit" | "auto" | null } {
  const active = (profiles || []).filter((p) => (p.status || "ACTIVE") === "ACTIVE");
  if (!active.length || !batch) return { profile: null, resolvedBy: null };

  if (batch.benchmarkProfileId != null) {
    const explicit = active.find((p) => p.id === Number(batch.benchmarkProfileId));
    if (explicit) return { profile: explicit, resolvedBy: "explicit" };
  }

  const candidates = active.filter((p) => p.species === batch.species);
  if (!candidates.length) return { profile: null, resolvedBy: null };
  const batchStrain = norm(batch.strainGenetics);
  const strainMatches = candidates.filter((p) => {
    const ps = norm(p.strain);
    return ps && batchStrain && (ps === batchStrain || ps.includes(batchStrain) || batchStrain.includes(ps));
  });
  const noStrain = candidates.filter((p) => !p.strain);
  const pool = strainMatches.length ? strainMatches : noStrain.length ? noStrain : candidates;
  pool.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || Number(b.id || 0) - Number(a.id || 0));
  return { profile: pool[0], resolvedBy: "auto" };
}

// ─── Historical batch matching ────────────────────────────────────────────

const SEASON_OF_MONTH = (m: number) =>
  m <= 1 || m === 11 ? "dry harmattan" : m <= 3 ? "major dry" : m <= 5 ? "major rains" : m <= 7 ? "minor dry" : "minor rains";

/** Comparable = different batch, same species, and either closed
 *  (HARVESTED/SOLD/CULLED) or an older GROWING batch that already lived
 *  through this batch's current age. Strain mismatches stay in (with a
 *  note). */
export function matchComparableBatches(batch: any, allBatches: any[]): { batch: any; note: string | null }[] {
  if (!batch) return [];
  const curSeason = SEASON_OF_MONTH(new Date(batch.hatchDate || Date.now()).getMonth());
  return (allBatches || [])
    .filter((b) => b && b.id !== batch.id && b.species === batch.species)
    .filter((b) => {
      const closed = ["HARVESTED", "SOLD", "CULLED", "CLOSED"].includes(String(b.status || "").toUpperCase());
      const olderGrowing =
        !closed && String(b.status || "GROWING") === "GROWING" && b.hatchDate && batch.hatchDate && b.hatchDate < batch.hatchDate;
      return closed || olderGrowing;
    })
    .map((b) => {
      const notes: string[] = [];
      if (b.strainGenetics && batch.strainGenetics && norm(b.strainGenetics) !== norm(batch.strainGenetics))
        notes.push(`different strain (${b.strainGenetics})`);
      const season = SEASON_OF_MONTH(new Date(b.hatchDate || Date.now()).getMonth());
      if (season !== curSeason) notes.push(`stocked in ${season}`);
      return { batch: b, note: notes.join(" · ") || null };
    });
}

// ─── Per-batch actuals ────────────────────────────────────────────────────

const batchLink = (row: any, batch: any) =>
  (row.batchId != null && Number(row.batchId) === Number(batch.id)) ||
  (row.batchNumber && row.batchNumber === batch.batchNumber);

function rowsFor(data: FishBenchmarkDataBundle, batch: any) {
  return {
    feed: (data.feedLogs || []).filter((r: any) => batchLink(r, batch)),
    harvests: (data.harvests || []).filter((r: any) => batchLink(r, batch) || (r.batchId != null && Number(r.batchId) === Number(batch.id))),
    weights: (data.weightLogs || []).filter((r: any) => batchLink(r, batch)),
  };
}

function weightSamplesOf(batch: any, data: FishBenchmarkDataBundle) {
  const { weights } = rowsFor(data, batch);
  const byDate = new Map<string, number[]>();
  for (const w of weights) {
    if ((w.avgWeightG || 0) > 0) byDate.set(w.recordedDate, [...(byDate.get(w.recordedDate) || []), w.avgWeightG]);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, xs]) => ({
      date,
      g: +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1),
      ageDays: fishAgeDaysOf(batch, date),
    }));
}

function aliveEstimates(batch: any, data: FishBenchmarkDataBundle) {
  const { harvests } = rowsFor(data, batch);
  // Fish harvested ON the sampling date still count as alive that morning —
  // a same-day harvest must not collapse the alive estimate (critical for
  // closed batches whose currentCount is 0, otherwise FCR explodes).
  const harvestedFrom = (date: string, inclusive: boolean) =>
    harvests.filter((h: any) => (h.saleDate || "") > date || (inclusive && (h.saleDate || "") === date))
      .reduce((s: number, h: any) => s + (h.harvestedCount || 0), 0);
  return {
    /** Fish alive on `date` (a same-day harvest was alive that morning). */
    aliveOn: (date: string) => Math.max(0, (batch.currentCount || 0) + harvestedFrom(date, true)),
    /** Fish still standing at the END of `date` (same-day harvests excluded). */
    standingOn: (date: string) => Math.max(0, (batch.currentCount || 0) + harvestedFrom(date, false)),
  };
}

/** Mean sampled weight at-or-before a date (g) — for biomass estimates. */
function weightAtOrBefore(samples: { date: string; g: number }[], date: string, fallbackG: number | null): number | null {
  const prior = samples.filter((s) => s.date <= date);
  if (prior.length) return prior[prior.length - 1].g;
  return Number(batch0Fallback(fallbackG)) > 0 ? Number(fallbackG) : null;
}
const batch0Fallback = (v: any) => (Number(v) > 0 ? v : 0);

/** All age-matched actuals for ONE batch as of `asOf` (default today). */
export function computeBatchActuals(
  batch: any,
  data: FishBenchmarkDataBundle,
  asOf?: string,
): FishBatchActuals {
  const ref = asOf || TODAY();
  const { feed, harvests } = rowsFor(data, batch);
  const samples = weightSamplesOf(batch, data);
  const { aliveOn, standingOn } = aliveEstimates(batch, data);

  const ageDays = batch.hatchDate ? fishAgeDaysOf(batch, ref) : 0;

  // Weight + ADG + SGR
  const lastSample = samples.length ? samples[samples.length - 1] : null;
  const firstSample = samples.length ? samples[0] : null;
  const weightG = lastSample ? lastSample.g : Number(batch.avgWeightGrams) > 0 ? Number(batch.avgWeightGrams) : null;
  const spanDays =
    firstSample && lastSample ? Math.max(1, Math.round((new Date(lastSample.date).getTime() - new Date(firstSample.date).getTime()) / 86400000)) : 0;
  const adgG = firstSample && lastSample && spanDays > 0 ? +((lastSample.g - firstSample.g) / spanDays).toFixed(1) : null;
  const sgrPct =
    firstSample && lastSample && spanDays > 0 && firstSample.g > 0 && lastSample.g > 0
      ? +((Math.log(lastSample.g) - Math.log(firstSample.g)) / spanDays * 100).toFixed(2)
      : null;

  // Feed consumption + cost (own-mill rows carry derived cost; purchased
  // consumption rows fall back to this batch's purchase price basis).
  const consumption = feed.filter((f: any) => f.entryType === "CONSUMPTION");
  const totalFeedKg = consumption.reduce((s: number, f: any) => s + (f.quantityKg || 0), 0);
  let feedCost = consumption.reduce((s: number, f: any) => s + (f.totalCostGhs || 0), 0);
  if (!(feedCost > 0) && totalFeedKg > 0) {
    const perKg = consumption.find((f: any) => (f.costPerKgGhs || 0) > 0)?.costPerKgGhs;
    if (perKg) feedCost = totalFeedKg * perKg;
  }
  const purchases = feed.filter((f: any) => f.entryType === "PURCHASE" && (f.costPerKgGhs || 0) > 0);
  const purchaseAvgPerKg = purchases.length
    ? purchases.reduce((s: number, f: any) => s + (f.costPerKgGhs || 0) * (f.quantityKg || 0), 0) /
      purchases.reduce((s: number, f: any) => s + (f.quantityKg || 0), 0)
    : null;
  if (!(feedCost > 0) && totalFeedKg > 0 && purchaseAvgPerKg) feedCost = totalFeedKg * purchaseAvgPerKg;
  feedCost = round(feedCost, 2);
  const feedCostPerKg =
    totalFeedKg > 0 && feedCost != null ? +(feedCost / totalFeedKg).toFixed(2) : purchaseAvgPerKg ? +purchaseAvgPerKg.toFixed(2) : null;

  // Feeding rate: mean % of standing biomass fed per day over the LAST 14
  // LOGGED FEEDING DAYS (one feed row = one day's ration). A recent window,
  // not a whole-cycle mean: the profile curve is the rate prescribed AT each
  // age, so comparing it against a lifetime average that mixes the 8%/day
  // fry phase would read as permanent overfeeding. The weekly trend chart
  // carries the full-history comparison, age-matched.
  let feedRatePctBiomass: number | null = null;
  {
    const byDay = new Map<string, number>();
    for (const f of consumption) {
      if ((f.quantityKg || 0) > 0) byDay.set(f.recordedDate, (byDay.get(f.recordedDate) || 0) + (f.quantityKg || 0));
    }
    const dayRates: number[] = [];
    for (const [date, dayKg] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const g = weightAtOrBefore(samples, date, batch.avgWeightGrams);
      const alive = Math.max(aliveOn(date) || batch.currentCount || 1, 1);
      if (g != null && g > 0) dayRates.push((dayKg * 100) / ((g / 1000) * alive));
    }
    if (dayRates.length) {
      const recent = dayRates.slice(-14);
      feedRatePctBiomass = +(recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(2);
    }
  }

  // FCR (calculated): feed ÷ production gain. Every fish is partitioned into
  // (a) still standing at `ref` — gain = last sample − first sample, or
  // (b) harvested inside the window — gain = harvest kg − first-sample kg.
  // (Fish harvested on the last sample date are NOT in the standing term —
  // their gain arrives via the harvest rows, which are the more precise
  // measurement. Mixing both would double count.)
  let gainKg = 0;
  let fcr: number | null = null;
  if (firstSample && lastSample && (lastSample.g - firstSample.g) > 0) {
    const standingNow = standingOn(ref);
    gainKg = ((lastSample.g - firstSample.g) / 1000) * standingNow;
    for (const h of harvests) {
      if ((h.saleDate || "") > firstSample.date && (h.saleDate || "") <= ref && (h.totalWeightKg || 0) > 0) {
        gainKg += Math.max(0, h.totalWeightKg - ((h.harvestedCount || 0) * firstSample.g) / 1000);
      }
    }
    fcr = totalFeedKg > 0 && gainKg > 0 ? +(totalFeedKg / gainKg).toFixed(2) : null;
  }

  // Survival / mortality
  const cumMortPct = (batch.initialCount || 0) > 0 ? +(((batch.mortalityTotal || 0) / batch.initialCount) * 100).toFixed(2) : null;
  const survivalPct = cumMortPct != null ? +(100 - cumMortPct).toFixed(2) : null;

  // Stocking density (kg fish / m³ of pond water) — the carrying-capacity KPI.
  let stockingDensityKgM3: number | null = null;
  const pond = (data.ponds || []).find((p: any) => Number(p.id) === Number(batch.pondId));
  if (pond && (pond.capacityLiters || 0) > 0 && weightG != null && (batch.currentCount || 0) > 0) {
    const biomass = ((weightG / 1000) * batch.currentCount);
    stockingDensityKgM3 = +(biomass / (pond.capacityLiters / 1000)).toFixed(2);
  }
  const biomassKg = weightG != null && (batch.currentCount || 0) > 0 ? +(((weightG / 1000) * batch.currentCount)).toFixed(1) : null;

  // Harvest economics
  const harvestedCount = harvests.reduce((s: number, h: any) => s + (h.harvestedCount || 0), 0);
  const harvestedKg = +harvests.reduce((s: number, h: any) => s + (h.totalWeightKg || 0), 0).toFixed(1);
  const harvestRevenueGhs = round(harvests.reduce((s: number, h: any) => s + (h.revenueGhs || 0), 0), 2) ?? 0;
  const revenuePerKgGhs = harvestedKg > 0 && harvestRevenueGhs > 0 ? +(harvestRevenueGhs / harvestedKg).toFixed(2) : null;

  // Production economics
  const fingerlingCostGhs = round((Number(batch.costPerFingerlingGhs) || 0) * (batch.initialCount || 0), 2) ?? 0;
  const productionKg = gainKg > 0 ? +gainKg.toFixed(1) : null;
  const feedCostPerKgGain = feedCost != null && gainKg > 0 ? +(feedCost / gainKg).toFixed(2) : null;
  const totalCostGhs = fingerlingCostGhs + (feedCost || 0);
  const costPerKgFishGhs = productionKg != null && productionKg > 0 && totalCostGhs > 0 ? +(totalCostGhs / productionKg).toFixed(2) : null;

  return {
    ageDays, ageWeeks: +(ageDays / 7).toFixed(1),
    weightG, weightKg: weightG != null ? +(weightG / 1000).toFixed(3) : null,
    adgG, sgrPct,
    totalFeedKg: +totalFeedKg.toFixed(1), feedCostGhs: feedCost, feedCostPerKg, feedRatePctBiomass, fcr,
    survivalPct, cumMortPct, stockingDensityKgM3, biomassKg,
    fingerlingCostGhs, feedCostPerKgGain, productionKg, costPerKgFishGhs,
    harvestedCount, harvestedKg, harvestRevenueGhs, revenuePerKgGhs,
    weightSamples: samples,
  };
}

// ─── Weekly per-batch metric series (for historical bands) ────────────────

/** Best anchor date for a batch's "end of cycle" — its last logged activity. */
function lastActivityDate(batch: any, data: FishBenchmarkDataBundle): string {
  const dates: string[] = [];
  const { feed, harvests, weights } = rowsFor(data, batch);
  for (const r of [...feed, ...harvests.map((h: any) => ({ recordedDate: h.saleDate })), ...weights])
    if ((r as any).recordedDate) dates.push((r as any).recordedDate);
  return dates.length ? dates.sort().pop()! : TODAY();
}

function weeklyValues(batch: any, data: FishBenchmarkDataBundle, metric: FishBenchmarkMetricKey): Map<number, number> {
  const out = new Map<number, number[]>();
  const push = (wk: number, v: number) => out.set(wk, [...(out.get(wk) || []), v]);
  const { feed, harvests } = rowsFor(data, batch);
  const { aliveOn, standingOn } = aliveEstimates(batch, data);
  const samples = weightSamplesOf(batch, data);

  if (metric === "AVG_WEIGHT_G") {
    for (const s of samples) push(Math.floor(s.ageDays / 7), s.g);
  } else if (metric === "ADG_G") {
    for (let i = 1; i < samples.length; i++) {
      const days = Math.max(1, samples[i].ageDays - samples[i - 1].ageDays);
      push(Math.floor(samples[i].ageDays / 7), (samples[i].g - samples[i - 1].g) / days);
    }
  } else if (metric === "SGR_PCT") {
    const first = samples[0];
    if (first && first.g > 0) {
      for (let i = 1; i < samples.length; i++) {
        const days = Math.max(1, samples[i].ageDays - first.ageDays);
        if (samples[i].g > 0) push(Math.floor(samples[i].ageDays / 7), ((Math.log(samples[i].g) - Math.log(first.g)) / days) * 100);
      }
    }
  } else if (metric === "FCR") {
    // cumulative feed ÷ cumulative gain at each sample week (≥2 samples)
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      const first = samples[0];
      const gainPerFishKg = (s.g - first.g) / 1000;
      if (gainPerFishKg <= 0) continue;
      const feedKg = feed
        .filter((f: any) => f.entryType === "CONSUMPTION" && f.recordedDate >= first.date && f.recordedDate <= s.date)
        .reduce((s2: number, f: any) => s2 + (f.quantityKg || 0), 0);
      const standing = standingOn(s.date);
      let gainKg = gainPerFishKg * standing;
      for (const h of harvests) {
        if ((h.saleDate || "") > first.date && (h.saleDate || "") <= s.date && (h.totalWeightKg || 0) > 0) {
          gainKg += Math.max(0, h.totalWeightKg - ((h.harvestedCount || 0) * first.g) / 1000);
        }
      }
      if (feedKg > 0 && gainKg > 0) push(Math.floor(s.ageDays / 7), feedKg / gainKg);
    }
  } else if (metric === "SURVIVAL_PCT") {
    // Fish mortality is a batch-level cumulative counter (no dated death
    // events exist), so a per-week survival curve cannot be reconstructed —
    // one honest point at the batch's last activity date.
    if ((batch.initialCount || 0) > 0) {
      const surv = 100 - ((batch.mortalityTotal || 0) / batch.initialCount) * 100;
      push(Math.floor(fishAgeDaysOf(batch, lastActivityDate(batch, data)) / 7), surv);
    }
  } else if (metric === "FEED_RATE_PCT_BIOMASS") {
    const byWeek = new Map<number, { kg: number; biomass: number }>();
    for (const f of feed.filter((f: any) => f.entryType === "CONSUMPTION" && (f.quantityKg || 0) > 0)) {
      const wk = Math.floor(fishAgeDaysOf(batch, f.recordedDate) / 7);
      const g = weightAtOrBefore(samples, f.recordedDate, batch.avgWeightGrams);
      const alive = Math.max(aliveOn(f.recordedDate) || batch.currentCount || 1, 1);
      const e = byWeek.get(wk) || { kg: 0, biomass: 0 };
      e.kg += f.quantityKg || 0;
      if (g != null && g > 0) e.biomass += (g / 1000) * alive;
      byWeek.set(wk, e);
    }
    for (const [wk, e] of byWeek) {
      if (e.kg > 0 && e.biomass > 0) push(wk, (e.kg / e.biomass) * 100);
    }
  }

  const means = new Map<number, number>();
  for (const [wk, xs] of out) means.set(wk, +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3));
  return means;
}

// ─── The main entry point ─────────────────────────────────────────────────

export interface ComputeFishBenchmarksInput extends FishBenchmarkDataBundle {
  batch: any;
  profiles?: FishBenchmarkProfileLike[];
  /** Live price for close-out margin (GH₵/kg); profile _meta default used when omitted. */
  livePricePerKgGhs?: number | null;
  asOf?: string;
}

export function computeFishBenchmarks(input: ComputeFishBenchmarksInput): FishBenchmarkResult {
  const { batch, profiles } = input;

  const { profile, resolvedBy } = resolveFishProfile(batch, profiles);
  const curves = (profile?.curves || null) as FishBenchmarkCurves | null;
  const warnDefault = Number(profile?.toleranceWarnPct) || 5;
  const critDefault = Number(profile?.toleranceCritPct) || 10;

  // Closed batches are benchmarked at their END-OF-CYCLE age (last logged
  // activity), not today — otherwise a harvested batch drifts further off
  // target every day purely by ageing past its harvest.
  const isClosed = ["HARVESTED", "SOLD", "CULLED", "CLOSED"].includes(String(batch?.status || "").toUpperCase());
  const asOf = input.asOf || (isClosed ? lastActivityDate(batch, input) : undefined);

  const actuals = computeBatchActuals(batch, input, asOf);

  // Comparable history
  const history = matchComparableBatches(batch, input.batches || [])
    .map((m) => {
      const mClosed = ["HARVESTED", "SOLD", "CULLED", "CLOSED"].includes(String(m.batch.status || "").toUpperCase());
      const a = computeBatchActuals(m.batch, input, mClosed ? lastActivityDate(m.batch, input) : asOf);
      const hasData = a.weightSamples.length > 0 || a.totalFeedKg > 0 || a.harvestedKg > 0 || (m.batch.mortalityTotal || 0) > 0;
      return { ...m, actuals: a, hasData };
    })
    .filter((m) => m.hasData);

  // ── KPIs ──
  // SGR target is DERIVED from the weight curve over the batch's own sample
  // window (ln-growth between the same two ages the actual SGR covers) —
  // comparing against a marginal weekly SGR curve would be apples-to-oranges.
  // A direct SGR_PCT curve is still honoured when the owner defined one.
  const targetOf = (key: FishBenchmarkMetricKey): number | null => {
    if (key === "SGR_PCT" && curves?.AVG_WEIGHT_G && actuals.weightSamples.length >= 2) {
      const first = actuals.weightSamples[0];
      const last = actuals.weightSamples[actuals.weightSamples.length - 1];
      const days = Math.max(1, last.ageDays - first.ageDays);
      const tFirst = fishCurveAt(curves, "AVG_WEIGHT_G", first.ageDays);
      const tLast = fishCurveAt(curves, "AVG_WEIGHT_G", last.ageDays);
      if (tFirst != null && tLast != null && tFirst > 0 && tLast > tFirst) {
        return +((Math.log(tLast) - Math.log(tFirst)) / days * 100).toFixed(2);
      }
    }
    return fishCurveAt(curves, key, actuals.ageDays);
  };

  // Historical KPI values are AGE-MATCHED: each comparable batch contributes
  // its weekly value at (or nearest within ±3 weeks of) the current batch's
  // age — comparing a 17-week grower against finished 28-week cycles would
  // read as a permanent −45% and bury the signal. Falls back to the batch's
  // final value when no weekly point is near (e.g. survival, which only has
  // an end-of-cycle point).
  const histWeekly = new Map<string, Map<number, number>>();
  const histValue = (key: FishBenchmarkMetricKey, pick: "median" | "best"): number | null => {
    if (!history.length) return null;
    const wk = Math.floor(actuals.ageDays / 7);
    const vals = history
      .map((h) => {
        const ck = `${h.batch.id}:${key}`;
        if (!histWeekly.has(ck)) histWeekly.set(ck, weeklyValues(h.batch, input, key));
        const w = histWeekly.get(ck)!;
        if (w.has(wk)) return w.get(wk)!;
        const weeks = [...w.keys()].sort((a, b) => a - b);
        const near = weeks.filter((x) => Math.abs(x - wk) <= 3);
        if (near.length) {
          const nearest = near.sort((a, b) => Math.abs(a - wk) - Math.abs(b - wk))[0];
          return w.get(nearest)!;
        }
        return fishActualOf(h.actuals, key);
      })
      .filter((v): v is number => v != null);
    if (!vals.length) return null;
    if (pick === "median") return quantile([...vals].sort((a, b) => a - b), 0.5);
    const better = FISH_BENCHMARK_METRIC_META[key].better;
    return better === "higher" ? Math.max(...vals) : Math.min(...vals);
  };

  const kpis: FishBenchmarkKpi[] = (Object.keys(FISH_BENCHMARK_METRIC_META) as FishBenchmarkMetricKey[])
    .map((key) => {
      const meta = FISH_BENCHMARK_METRIC_META[key];
      const actual = fishActualOf(actuals, key);
      const target = targetOf(key);
      const histMedian = histValue(key, "median");
      const histBest = histValue(key, "best");
      const def = curves?.[key];
      const warn = Number(def?.warnPct) || warnDefault;
      const crit = Number(def?.critPct) || critDefault;

      let variancePct: number | null = null;
      let driftPct: number | null = null;
      let histDriftPct: number | null = null;
      let status: FishBenchmarkKpi["status"] = "NO_DATA";
      if (actual != null && target != null && target > 0) {
        variancePct = +(((actual - target) / target) * 100).toFixed(1);
        driftPct = +(meta.better === "higher" ? variancePct : -variancePct).toFixed(1);
        status = driftPct <= -crit ? "OFF_TRACK" : driftPct <= -warn ? "WATCH" : "ON_TRACK";
      } else if (actual != null) {
        status = "NO_DATA";
      }
      if (actual != null && histMedian != null && histMedian > 0) {
        const v = +(((actual - histMedian) / histMedian) * 100).toFixed(1);
        histDriftPct = +(meta.better === "higher" ? v : -v).toFixed(1);
      }
      return {
        key, label: meta.label, unit: meta.unit, actual, target, histMedian, histBest,
        variancePct, driftPct, histDriftPct, status, better: meta.better,
      };
    });

  // ── Weekly age-matched series (actual + target + history band) ──
  const series: Partial<Record<FishBenchmarkMetricKey, FishBenchmarkSeriesRow[]>> = {};
  const seriesMetrics: FishBenchmarkMetricKey[] = ["AVG_WEIGHT_G", "SGR_PCT", "FCR", "SURVIVAL_PCT", "FEED_RATE_PCT_BIOMASS"];
  for (const metric of seriesMetrics) {
    const actualWeekly = weeklyValues(batch, input, metric);
    const hist: Map<number, number[]> = new Map();
    for (const h of history) {
      for (const [wk, v] of weeklyValues(h.batch, input, metric)) hist.set(wk, [...(hist.get(wk) || []), v]);
    }
    const weeks = new Set<number>([...actualWeekly.keys(), ...hist.keys()]);
    const curveDef = curves?.[metric];
    if (curveDef) {
      for (const [a] of curveDef.points) {
        const wk = curveDef.by === "ageWeeks" ? a : a / 7;
        if (Number.isInteger(wk)) weeks.add(wk);
      }
    }
    const rows: FishBenchmarkSeriesRow[] = [...weeks]
      .filter((wk) => wk >= 0 && wk <= Math.ceil(actuals.ageDays / 7) + 1)
      .sort((a, b) => a - b)
      .map((wk) => {
        const ageDays = wk * 7;
        const sorted = [...(hist.get(wk) || [])].sort((a, b) => a - b);
        return {
          age: `W${wk}`, week: wk,
          actual: actualWeekly.has(wk) ? actualWeekly.get(wk) : null,
          target: fishCurveAt(curves, metric, ageDays),
          histMedian: quantile(sorted, 0.5),
          histP25: quantile(sorted, 0.25),
          histP75: quantile(sorted, 0.75),
        };
      })
      .filter((r) => r.actual != null || r.target != null || r.histMedian != null);
    if (rows.length) series[metric] = rows;
  }

  // ── Scorecard ──
  let compliancePct: number | null = null;
  let evaluated = 0;
  const weighted = kpis.filter((k) => k.status !== "NO_DATA" && SCORECARD_WEIGHTS[k.key]);
  if (weighted.length) {
    const totalW = weighted.reduce((s, k) => s + (SCORECARD_WEIGHTS[k.key] || 0), 0);
    const score = weighted.reduce((s, k) => s + (SCORECARD_WEIGHTS[k.key] || 0) * (k.status === "ON_TRACK" ? 1 : k.status === "WATCH" ? 0.6 : 0), 0);
    compliancePct = +((score / totalW) * 100).toFixed(0);
    evaluated = weighted.length;
  }
  const grade = compliancePct == null ? null : compliancePct >= 95 ? "A" : compliancePct >= 85 ? "B" : compliancePct >= 70 ? "C" : "D";

  // ── Harvest close-out projection (needs a weight curve) ──
  let projection: HarvestProjection | null = null;
  const weightCurve = curves?.AVG_WEIGHT_G;
  const harvestAgeDays =
    curves?._meta?.harvestAgeDays ||
    (weightCurve ? weightCurve.points[weightCurve.points.length - 1][0] : null);
  if (harvestAgeDays && actuals.ageDays < harvestAgeDays) {
    const livePrice =
      Number(input.livePricePerKgGhs) ||
      Number(curves?._meta?.livePricePerKgGhs) ||
      (String(batch.species || "").toUpperCase().includes("CATFISH") ? 52 : 62);
    const daysRemaining = Math.max(0, harvestAgeDays - actuals.ageDays);
    const currentW = actuals.weightKg ?? (fishCurveAt(curves, "AVG_WEIGHT_G", actuals.ageDays) ?? 0) / 1000;
    const targetAtHarvestG = fishCurveAt(curves, "AVG_WEIGHT_G", harvestAgeDays);
    const targetNowG = fishCurveAt(curves, "AVG_WEIGHT_G", actuals.ageDays);
    // SGR-compounded projection — along the TARGET CURVE's SGR path (which
    // decays as fish grow), scaled by the batch's observed relative growth
    // (actual window SGR ÷ target window SGR). Compounding the batch's
    // lifetime-average SGR for months would be absurd (a 4%/day fry-rate
    // held to day 196 projects a 25 kg tilapia).
    let relPerf = 1;
    if (actuals.sgrPct != null && actuals.weightSamples.length >= 2) {
      const first = actuals.weightSamples[0];
      const last = actuals.weightSamples[actuals.weightSamples.length - 1];
      const days = Math.max(1, last.ageDays - first.ageDays);
      const tFirst = fishCurveAt(curves, "AVG_WEIGHT_G", first.ageDays);
      const tLast = fishCurveAt(curves, "AVG_WEIGHT_G", last.ageDays);
      if (tFirst != null && tLast != null && tFirst > 0 && tLast > tFirst) {
        const targetWindowSgr = ((Math.log(tLast) - Math.log(tFirst)) / days) * 100;
        if (targetWindowSgr > 0) relPerf = Math.min(1.4, Math.max(0.6, actuals.sgrPct / targetWindowSgr));
      }
    }
    let projectedW: number | null = null;
    if (currentW > 0 && targetAtHarvestG != null && targetNowG != null && targetAtHarvestG > targetNowG) {
      projectedW = +(currentW * Math.exp(Math.log(targetAtHarvestG / targetNowG) * relPerf)).toFixed(3);
    } else if (targetAtHarvestG != null) {
      projectedW = +(targetAtHarvestG / 1000).toFixed(3);
    }
    const fcrBasis = actuals.fcr ?? fishCurveAt(curves, "FCR", harvestAgeDays);
    const gainRemainingPerFish = projectedW != null ? Math.max(0, projectedW - currentW) : null;
    const aliveNow = Math.max(batch.currentCount || 0, 1);
    const feedKgRemaining = fcrBasis && gainRemainingPerFish != null ? +(fcrBasis * gainRemainingPerFish * aliveNow).toFixed(0) : null;
    const costPerKgBasis = actuals.feedCostPerKg ?? null;
    const feedCostRemaining = feedKgRemaining != null && costPerKgBasis ? +(feedKgRemaining * costPerKgBasis).toFixed(2) : null;
    const costToDate = actuals.fingerlingCostGhs + (actuals.feedCostGhs || 0);
    const producedToDateKg = actuals.productionKg ?? 0;
    const gainRemainingKgTotal = gainRemainingPerFish != null ? +(gainRemainingPerFish * aliveNow).toFixed(1) : null;
    const projectedCostPerKg =
      feedCostRemaining != null && gainRemainingKgTotal != null && producedToDateKg + gainRemainingKgTotal > 0
        ? +((costToDate + feedCostRemaining) / (producedToDateKg + gainRemainingKgTotal)).toFixed(2)
        : null;
    const revenuePerFish = projectedW != null ? +(projectedW * livePrice).toFixed(2) : null;
    const projectedCostPerFish = projectedCostPerKg != null && projectedW != null ? +(projectedCostPerKg * projectedW).toFixed(2) : null;
    const marginPerFish = revenuePerFish != null && projectedCostPerFish != null ? +(revenuePerFish - projectedCostPerFish).toFixed(2) : null;
    projection = {
      harvestAgeDays, daysRemaining,
      currentWeightKg: actuals.weightKg, projectedWeightKg: projectedW,
      targetWeightKg: targetAtHarvestG != null ? +(targetAtHarvestG / 1000).toFixed(3) : undefined,
      projectedFcr: fcrBasis, feedKgRemaining, feedCostRemainingGhs: feedCostRemaining,
      costPerKgToDateGhs: actuals.costPerKgFishGhs, projectedCostPerKgGhs: projectedCostPerKg,
      livePricePerKgGhs: livePrice, revenuePerFishGhs: revenuePerFish, marginPerFishGhs: marginPerFish,
      marginTotalGhs: marginPerFish != null ? +(marginPerFish * aliveNow).toFixed(2) : null,
      assumptions: [
        actuals.sgrPct != null
          ? `growth follows the target curve's SGR path × the batch's relative performance (${(relPerf * 100).toFixed(0)}% of target SGR)`
          : "no SGR yet — projection uses the profile target weight",
        fcrBasis ? `feed conversion holds at ${(+fcrBasis).toFixed(2)}` : "FCR unknown — feed-to-harvest not estimated",
        costPerKgBasis ? `feed priced at GH₵${costPerKgBasis}/kg (recent cost basis)` : "no feed cost basis yet",
        `live price GH₵${livePrice}/kg (editable below)`,
      ],
    };
  }

  const hasAnyBenchmark = !!(curves && Object.keys(curves).some((k) => k !== "_meta")) || history.length > 0;

  return {
    batch, profile, profileResolvedBy: resolvedBy, actuals, kpis, series,
    history: history.map((h) => ({ batch: h.batch, note: h.note })),
    scorecard: { grade, compliancePct, evaluated },
    projection,
    hasAnyBenchmark,
  };
}

function fishActualOf(a: FishBatchActuals, key: FishBenchmarkMetricKey): number | null {
  switch (key) {
    case "AVG_WEIGHT_G": return a.weightG;
    case "SGR_PCT": return a.sgrPct;
    case "ADG_G": return a.adgG;
    case "FCR": return a.fcr;
    case "FEED_RATE_PCT_BIOMASS": return a.feedRatePctBiomass;
    case "SURVIVAL_PCT": return a.survivalPct;
    case "STOCKING_DENSITY_KG_M3": return a.stockingDensityKgM3;
    case "FEED_COST_PER_KG_GAIN": return a.feedCostPerKgGain;
    case "COST_PER_KG_FISH": return a.costPerKgFishGhs;
    default: return null;
  }
}

// ─── Alerts (AquaAlert-shaped — drop into the existing AI Smart Alerts) ───

export function computeFishBenchmarkAlerts(res: FishBenchmarkResult | null): AquaAlert[] {
  if (!res || !res.hasAnyBenchmark) return [];
  const today = TODAY();
  const alerts: AquaAlert[] = [];
  const kpi = (key: FishBenchmarkMetricKey) => res.kpis.find((k) => k.key === key);
  const name = res.batch?.batchNumber || "batch";
  const push = (a: AquaAlert) => alerts.push(a);

  const weight = kpi("AVG_WEIGHT_G");
  if (weight && weight.status === "OFF_TRACK") {
    push({
      id: "fish-bench-weight-off", level: "critical", category: "Benchmark",
      title: "Fish Weight Below Benchmark",
      message: `${name} averages ${weight.actual}g at age ${res.actuals.ageDays}d — ${Math.abs(weight.driftPct || 0).toFixed(1)}% behind the "${res.profile?.name || "benchmark"}" target of ${weight.target}g.`,
      recommendation: "Review feeding rate vs the target curve, feed quality and pellet size, water quality (DO, ammonia, temperature) and stocking density. Grade or sort the batch if growth is uneven.",
      timestamp: today, value: `${weight.actual}g`, threshold: `${weight.target}g`,
    });
  } else if (weight && weight.status === "WATCH") {
    push({
      id: "fish-bench-weight-watch", level: "warning", category: "Benchmark",
      title: "Fish Weight Slightly Below Benchmark",
      message: `${name} averages ${weight.actual}g vs target ${weight.target}g (${weight.driftPct}% at age ${res.actuals.ageDays}d).`,
      recommendation: "Tighten feeding-program adherence (weigh feed daily) and re-sample in 5–7 days to confirm the trend before acting.",
      timestamp: today, value: `${weight.actual}g`, threshold: `${weight.target}g`,
    });
  }

  const sgr = kpi("SGR_PCT");
  if (sgr && (sgr.status === "WATCH" || sgr.status === "OFF_TRACK")) {
    push({
      id: "fish-bench-sgr", level: sgr.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "Growth Rate (SGR) Below Benchmark",
      message: `Specific growth rate is ${sgr.actual}%/day vs benchmark ${sgr.target}%/day (${sgr.driftPct}% behind).`,
      recommendation: "Check dissolved oxygen (low DO is the #1 growth killer), water temperature vs species optimum, feeding rate and feed freshness. Consider a partial water exchange.",
      timestamp: today, value: `${sgr.actual}%/day`, threshold: `${sgr.target}%/day`,
    });
  }

  const fcr = kpi("FCR");
  if (fcr && (fcr.status === "WATCH" || fcr.status === "OFF_TRACK")) {
    push({
      id: "fish-bench-fcr", level: fcr.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "FCR Above Benchmark",
      message: `Calculated FCR is ${fcr.actual} vs benchmark ${fcr.target} (${fcr.driftPct}% worse at age ${res.actuals.ageDays}d).`,
      recommendation: "Check feed wastage (sinking feed past the feeding response window), overfeeding vs the % biomass schedule, feed quality/water stability, and grading — small fish behind the average drag FCR.",
      timestamp: today, value: `${fcr.actual}`, threshold: `${fcr.target}`,
    });
  }

  const survival = kpi("SURVIVAL_PCT");
  if (survival && (survival.status === "WATCH" || survival.status === "OFF_TRACK")) {
    push({
      id: "fish-bench-survival", level: survival.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "Survival Below Benchmark",
      message: `Batch survival is ${survival.actual}% vs benchmark ${survival.target}% at age ${res.actuals.ageDays}d (${res.batch?.mortalityTotal || 0} fish lost).`,
      recommendation: "Investigate immediately: test DO (early morning), ammonia and nitrite, check for predation (birds, escape through net holes) and disease signs. Remove morts daily and record counts.",
      timestamp: today, value: `${survival.actual}%`, threshold: `${survival.target}%`,
    });
  }

  const rate = kpi("FEED_RATE_PCT_BIOMASS");
  if (rate && (rate.status === "WATCH" || rate.status === "OFF_TRACK")) {
    push({
      id: "fish-bench-feedrate", level: rate.status === "OFF_TRACK" ? "warning" : "warning", category: "Benchmark",
      title: "Feeding Rate Above Benchmark",
      message: `Feeding ${rate.actual}% of biomass/day vs benchmark ${rate.target}% — overfeeding wastes feed and loads the pond.`,
      recommendation: "Feed to satiation in 15–20 min sessions (reduce the ration), match pellet size to fish size, and cut back on low-DO / cold days. Feed Mill data can confirm the ration actually used.",
      timestamp: today, value: `${rate.actual}%/day`, threshold: `${rate.target}%/day`,
    });
  }

  const cost = kpi("FEED_COST_PER_KG_GAIN");
  if (cost && (cost.status === "WATCH" || cost.status === "OFF_TRACK")) {
    push({
      id: "fish-bench-feedcost", level: "warning", category: "Benchmark",
      title: "Feed Cost per kg Fish Above Benchmark",
      message: `Feed cost is GH₵${cost.actual} per kg produced vs benchmark GH₵${cost.target}.`,
      recommendation: "Compare own-milled vs purchased feed cost per kg (Fish Feed Mill tab) and review FCR drivers — cheaper feed that worsens FCR often costs more per kg fish.",
      timestamp: today, value: `GH₵${cost.actual}`, threshold: `GH₵${cost.target}`,
    });
  }

  const evaluated = res.kpis.filter((k) => k.status !== "NO_DATA");
  if (!alerts.length && evaluated.length >= 2) {
    push({
      id: "fish-bench-on-track", level: "normal", category: "Benchmark",
      title: "Batch Tracking Benchmark",
      message: `${name} is within tolerance on all ${evaluated.length} benchmarked metrics (scorecard ${res.scorecard.grade ?? "—"}).`,
      recommendation: "Keep the current feeding and water-quality management program.",
      timestamp: today, value: res.scorecard.grade ?? "", threshold: "",
    });
  }

  return alerts;
}

// ─── Fallback target helper for charts (built-in curves) ─────────────────

/** Profile target when one resolves, else the built-in species standard —
 *  used by the Fish Growth Analytics overlays so charts keep their current
 *  look when no profile is configured. */
export function fishWeightTargetG(
  batch: any,
  profiles: FishBenchmarkProfileLike[] | null | undefined,
  ageDays: number,
): number | null {
  const { profile } = resolveFishProfile(batch, profiles);
  const fromProfile = fishCurveAt((profile?.curves || null) as FishBenchmarkCurves | null, "AVG_WEIGHT_G", ageDays);
  if (fromProfile != null) return fromProfile;
  return speciesTargetG(batch?.species, ageDays);
}

/** Derive a full curves payload from a real (usually finished) batch — the
 *  "what our own best batch achieved" profile. Weekly means per metric. */
export function deriveFishCurvesFromBatch(batch: any, data: FishBenchmarkDataBundle): FishBenchmarkCurves {
  const curves: FishBenchmarkCurves = {};
  const set = (key: FishBenchmarkMetricKey, by: "ageDays" | "ageWeeks", weekly: Map<number, number>, unit: string) => {
    const pts = [...weekly.entries()].filter(([, v]) => Number.isFinite(v) && v > 0).sort((a, b) => a[0] - b[0]);
    if (pts.length >= 2) (curves as any)[key] = { by, unit, points: pts.map(([wk, v]) => [by === "ageWeeks" ? wk : wk * 7, +(+v).toFixed(3)]) };
  };

  set("AVG_WEIGHT_G", "ageDays", weeklyValues(batch, data, "AVG_WEIGHT_G"), "g");
  set("SGR_PCT", "ageDays", weeklyValues(batch, data, "SGR_PCT"), "%/day");
  set("ADG_G", "ageDays", weeklyValues(batch, data, "ADG_G"), "g/day");
  set("FCR", "ageDays", weeklyValues(batch, data, "FCR"), "");
  set("FEED_RATE_PCT_BIOMASS", "ageDays", weeklyValues(batch, data, "FEED_RATE_PCT_BIOMASS"), "% biomass/day");
  set("SURVIVAL_PCT", "ageDays", weeklyValues(batch, data, "SURVIVAL_PCT"), "%");

  const a = computeBatchActuals(batch, data);
  curves._meta = {
    harvestAgeDays: Math.max(21, Math.round(a.ageDays)),
    livePricePerKgGhs: a.revenuePerKgGhs ?? undefined,
  };
  return curves;
}

// ─── Validation (server-side, used by the benchmarks API) ─────────────────

export const FISH_BENCHMARK_METRIC_KEYS: FishBenchmarkMetricKey[] = [
  "AVG_WEIGHT_G", "SGR_PCT", "ADG_G", "FCR", "FEED_RATE_PCT_BIOMASS",
  "SURVIVAL_PCT", "STOCKING_DENSITY_KG_M3", "FEED_COST_PER_KG_GAIN", "COST_PER_KG_FISH",
];

/** Validates + normalizes a curves payload. Returns null when invalid. */
export function validateFishCurves(raw: any): { curves: FishBenchmarkCurves; error?: string } {
  if (raw == null) return { curves: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { curves: {}, error: "curves must be an object" };
  const out: FishBenchmarkCurves = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "_meta") {
      const m = val as any;
      out._meta = {
        harvestAgeDays: m?.harvestAgeDays != null ? Math.max(1, Math.round(+m.harvestAgeDays)) || undefined : undefined,
        livePricePerKgGhs: m?.livePricePerKgGhs != null && +m.livePricePerKgGhs > 0 ? +(+m.livePricePerKgGhs).toFixed(2) : undefined,
      };
      continue;
    }
    if (!FISH_BENCHMARK_METRIC_KEYS.includes(key as FishBenchmarkMetricKey)) continue; // ignore unknown keys (forward-compat)
    const def = val as FishBenchmarkCurveDef;
    if (!def || typeof def !== "object" || !Array.isArray(def.points)) continue;
    const pts = def.points
      .filter((p: any) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) && +p[0] >= 0)
      .map((p: any) => [+p[0], +p[1]] as [number, number])
      .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
    if (pts.length === 1) return { curves: out, error: `curve ${key} needs at least 2 points` };
    const by = def.by === "ageWeeks" ? "ageWeeks" : "ageDays";
    (out as any)[key] = {
      by,
      unit: typeof def.unit === "string" ? def.unit : undefined,
      warnPct: def.warnPct != null && +def.warnPct > 0 ? +def.warnPct : undefined,
      critPct: def.critPct != null && +def.critPct > 0 ? +def.critPct : undefined,
      points: pts,
    };
  }
  return { curves: out };
}
