// Pure Flock Performance Benchmarking engine for the Poultry module.
// Data-in/data-out (no React, no DB) — same pattern as poultryPerformance.ts,
// so every number the dashboard renders is reproducible from the database.
//
// What it does:
//   1. Resolves a Benchmark Profile for a flock (explicit override →
//      auto-match by bird type / breed → null = built-in curves unchanged).
//   2. Computes AGE-MATCHED actuals for the flock (weight, ADG, feed intake,
//      FCR, mortality, lay %, egg weight, feed cost/kg gain, cost/bird …).
//   3. Matches COMPARABLE HISTORICAL FLOCKS (closed flocks + older active
//      flocks of the same bird type) and builds p25 / median / p75 bands
//      per week of age for every metric.
//   4. Emits KPIs with variance vs target & vs farm history, an A–D
//      scorecard, a close-out projection and alert-shaped findings that
//      drop straight into the existing PoultryAnalyticsAlerts panel.
//
// Fallback contract: when no profile resolves AND no comparable history
// exists, `hasAnyBenchmark` is false and callers render nothing new — the
// app behaves exactly as before (hard-coded breed-standard curves in
// poultryPerformance.ts keep driving the existing charts).

import type { PoultryAlert } from "./poultryAnalytics";
import { broilerTargetKg, layerTargetKg } from "./poultryPerformance";

// ─── Types ────────────────────────────────────────────────────────────────

export type BenchmarkMetricKey =
  | "BODY_WEIGHT_KG"
  | "ADG_G"
  | "FCR"
  | "MORTALITY_CUM_PCT"
  | "FEED_INTAKE_G_BIRD"
  | "LAY_PCT"
  | "EGG_WEIGHT_G"
  | "FEED_COST_PER_KG_GAIN"
  | "COST_PER_BIRD"
  | "COST_PER_EGG";

export interface BenchmarkCurveDef {
  by: "ageDays" | "ageWeeks";
  unit?: string;
  warnPct?: number;
  critPct?: number;
  points: [number, number][];
}

export interface BenchmarkCurveMeta {
  marketAgeDays?: number;
  livePricePerKgGhs?: number;
}

export type BenchmarkCurves = Partial<Record<BenchmarkMetricKey, BenchmarkCurveDef>> & {
  _meta?: BenchmarkCurveMeta;
};

export interface BenchmarkProfileLike {
  id?: number;
  name: string;
  birdType: string;
  breed?: string | null;
  source?: string;
  status?: string;
  isDefault?: boolean;
  toleranceWarnPct?: number | null;
  toleranceCritPct?: number | null;
  curves?: BenchmarkCurves | null;
  notes?: string | null;
}

export interface BenchmarkDataBundle {
  flocks: any[];
  feedLogs: any[];
  healthRecords: any[];
  production: any[];
  weightLogs?: any[];
}

export interface BenchmarkKpi {
  key: BenchmarkMetricKey;
  label: string;
  unit: string;
  actual: number | null;
  target: number | null;
  histMedian: number | null;
  histBest: number | null;
  /** Signed variance vs target (%). Positive = above target. */
  variancePct: number | null;
  /** Direction-aware drift vs target (%). Positive = behind target. */
  driftPct: number | null;
  /** Direction-aware drift vs farm-history median (%). */
  histDriftPct: number | null;
  status: "ON_TRACK" | "WATCH" | "OFF_TRACK" | "NO_DATA";
  better: "higher" | "lower";
  /** Informational metrics (PPEF, cost/egg) render without target chips. */
  informational?: boolean;
  note?: string;
}

export interface BenchmarkSeriesRow {
  age: string;
  week: number;
  actual?: number | null;
  target?: number | null;
  histMedian?: number | null;
  histP25?: number | null;
  histP75?: number | null;
}

export interface CloseOutProjection {
  marketAgeDays: number;
  daysRemaining: number;
  currentWeightKg: number | null;
  projectedWeightKg: number | null;
  targetWeightKg: number | null | undefined;
  projectedFcr: number | null;
  feedKgRemaining: number | null;
  feedCostRemainingGhs: number | null;
  costPerBirdToDateGhs: number | null;
  projectedCostPerBirdGhs: number | null;
  livePricePerKgGhs: number;
  revenuePerBirdGhs: number | null;
  marginPerBirdGhs: number | null;
  marginTotalGhs: number | null;
  assumptions: string[];
}

export interface BenchmarkResult {
  flock: any;
  profile: BenchmarkProfileLike | null;
  profileResolvedBy: "explicit" | "auto" | null;
  actuals: FlockActuals;
  kpis: BenchmarkKpi[];
  series: Partial<Record<BenchmarkMetricKey, BenchmarkSeriesRow[]>>;
  history: { flock: any; note: string | null }[];
  scorecard: { grade: "A" | "B" | "C" | "D" | null; compliancePct: number | null; evaluated: number };
  projection: CloseOutProjection | null;
  hasAnyBenchmark: boolean;
}

export interface FlockActuals {
  ageDays: number;
  ageWeeks: number;
  weightKg: number | null;
  adgG: number | null;
  totalFeedKg: number;
  feedCostGhs: number | null;
  feedCostPerKg: number | null;
  feedIntakeGBirdDay: number | null;
  fcr: number | null;
  cumMortPct: number | null;
  layPct: number | null;
  eggWeightG: number | null;
  feedCostPerKgGain: number | null;
  costPerBirdGhs: number | null;
  costPerEggGhs: number | null;
  eggsTotal: number;
  healthCostGhs: number;
  ppef: number | null;
  weightSamples: { date: string; kg: number; ageDays: number }[];
}

// ─── Small helpers ────────────────────────────────────────────────────────

const TODAY = () => new Date().toISOString().split("T")[0];

export const ageDaysOf = (flock: any, date: string) =>
  flock?.arrivalDate
    ? Math.max(0, Math.round((new Date(date).getTime() - new Date(flock.arrivalDate).getTime()) / 86400000))
    : 0;

const norm = (s: any) => String(s || "").trim().toLowerCase();

/** Piecewise-linear interpolation on a curve's [age, value] points. */
export function interpolateCurve(
  points: [number, number][] | undefined | null,
  x: number,
): number | null {
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

/** Curve value at a flock age. `by: "ageWeeks"` curves take age/7. */
export function curveAt(curves: BenchmarkCurves | null | undefined, key: BenchmarkMetricKey, ageDays: number): number | null {
  const def = curves?.[key];
  if (!def) return null;
  return interpolateCurve(def.points, def.by === "ageWeeks" ? ageDays / 7 : ageDays);
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
// Values mirror the hard-coded breed-standard curves in poultryPerformance.ts
// so a farm that adopts a template sees identical targets to today's charts.

export const BENCHMARK_TEMPLATES: BenchmarkProfileLike[] = [
  {
    name: "Broiler Standard — Cobb 500 / Ross 308",
    birdType: "BROILERS",
    breed: null,
    source: "TEMPLATE",
    curves: {
      BODY_WEIGHT_KG: {
        by: "ageDays", unit: "kg",
        points: [[0, 0.042], [7, 0.19], [14, 0.47], [21, 0.85], [28, 1.33], [35, 1.9], [42, 2.5], [49, 3.02], [56, 3.48]],
      },
      ADG_G: {
        by: "ageDays", unit: "g/day",
        points: [[7, 21], [14, 40], [21, 54], [28, 69], [35, 81], [42, 86], [49, 74], [56, 66]],
      },
      FCR: {
        by: "ageDays", unit: "",
        points: [[7, 0.85], [14, 1.05], [21, 1.2], [28, 1.35], [35, 1.48], [42, 1.6], [49, 1.72], [56, 1.84]],
      },
      MORTALITY_CUM_PCT: {
        by: "ageDays", unit: "%",
        points: [[7, 0.5], [14, 1], [21, 1.5], [28, 1.9], [35, 2.2], [42, 2.5], [49, 2.8], [56, 3]],
      },
      FEED_INTAKE_G_BIRD: {
        by: "ageDays", unit: "g/bird/day",
        points: [[7, 19], [14, 33], [21, 53], [28, 72], [35, 93], [42, 110], [49, 125], [56, 138]],
      },
      _meta: { marketAgeDays: 42 },
    },
  },
  {
    name: "Layer Standard — Isa Brown / Lohmann",
    birdType: "LAYERS",
    breed: null,
    source: "TEMPLATE",
    curves: {
      BODY_WEIGHT_KG: {
        by: "ageDays", unit: "kg",
        points: [[0, 0.04], [21, 0.19], [42, 0.45], [63, 0.78], [84, 1.15], [105, 1.4], [126, 1.55], [147, 1.7], [175, 1.83], [210, 1.9], [280, 1.95], [420, 2], [630, 2.05]],
      },
      LAY_PCT: {
        by: "ageWeeks", unit: "%",
        points: [[19, 0], [20, 30], [21, 50], [22, 62], [23, 72], [24, 81], [25, 88], [30, 92], [38, 92], [50, 86], [60, 81], [80, 71]],
      },
      EGG_WEIGHT_G: {
        by: "ageWeeks", unit: "g",
        points: [[18, 47], [20, 49], [24, 55], [28, 58], [32, 60], [36, 61.5], [40, 62.5], [45, 63.5], [50, 64], [60, 65], [80, 66]],
      },
      MORTALITY_CUM_PCT: {
        by: "ageDays", unit: "%",
        points: [[21, 0.8], [42, 1.2], [126, 2], [210, 2.6], [350, 3.4], [560, 4.2]],
      },
      FEED_INTAKE_G_BIRD: {
        by: "ageDays", unit: "g/bird/day",
        points: [[42, 40], [84, 58], [126, 74], [154, 100], [210, 112], [350, 116], [560, 114]],
      },
    },
  },
];

/** Metric display metadata: label, unit and which direction is "better". */
export const BENCHMARK_METRIC_META: Record<
  BenchmarkMetricKey,
  { label: string; unit: string; better: "higher" | "lower"; appliesTo: (birdType: string) => boolean; informational?: boolean }
> = {
  BODY_WEIGHT_KG: { label: "Body weight", unit: "kg", better: "higher", appliesTo: () => true },
  ADG_G: { label: "Daily gain", unit: "g/day", better: "higher", appliesTo: (b) => b !== "LAYERS" },
  FCR: { label: "FCR (calc)", unit: "", better: "lower", appliesTo: () => true },
  MORTALITY_CUM_PCT: { label: "Mortality (cum.)", unit: "%", better: "lower", appliesTo: () => true },
  FEED_INTAKE_G_BIRD: { label: "Feed intake", unit: "g/bird/day", better: "lower", appliesTo: () => true },
  LAY_PCT: { label: "Lay rate", unit: "%", better: "higher", appliesTo: (b) => b === "LAYERS" },
  EGG_WEIGHT_G: { label: "Egg weight", unit: "g", better: "higher", appliesTo: (b) => b === "LAYERS" },
  FEED_COST_PER_KG_GAIN: { label: "Feed cost / kg gain", unit: "", better: "lower", appliesTo: () => true },
  COST_PER_BIRD: { label: "Cost / bird to date", unit: "", better: "lower", appliesTo: () => true },
  COST_PER_EGG: { label: "Feed+health cost / egg", unit: "", better: "lower", appliesTo: (b) => b === "LAYERS", informational: true },
};

const SCORECARD_WEIGHTS: Partial<Record<BenchmarkMetricKey, number>> = {
  BODY_WEIGHT_KG: 3, FCR: 3, MORTALITY_CUM_PCT: 3, LAY_PCT: 3,
  ADG_G: 2, EGG_WEIGHT_G: 2, FEED_COST_PER_KG_GAIN: 2,
  FEED_INTAKE_G_BIRD: 1, COST_PER_BIRD: 1,
};

// ─── Profile resolution ───────────────────────────────────────────────────

/** Explicit flock override → auto-match (bird type, then breed, prefer
 *  isDefault, newest first). Returns null when nothing fits. */
export function resolveProfile(
  flock: any,
  profiles: BenchmarkProfileLike[] | undefined | null,
): { profile: BenchmarkProfileLike | null; resolvedBy: "explicit" | "auto" | null } {
  const active = (profiles || []).filter((p) => (p.status || "ACTIVE") === "ACTIVE");
  if (!active.length || !flock) return { profile: null, resolvedBy: null };

  if (flock.benchmarkProfileId != null) {
    const explicit = active.find((p) => p.id === Number(flock.benchmarkProfileId));
    if (explicit) return { profile: explicit, resolvedBy: "explicit" };
  }

  const candidates = active.filter((p) => p.birdType === flock.birdType);
  if (!candidates.length) return { profile: null, resolvedBy: null };
  const flockBreed = norm(flock.breed);
  const breedMatches = candidates.filter((p) => {
    const pb = norm(p.breed);
    return pb && flockBreed && (pb === flockBreed || pb.includes(flockBreed) || flockBreed.includes(pb));
  });
  const noBreed = candidates.filter((p) => !p.breed);
  const pool = breedMatches.length ? breedMatches : noBreed.length ? noBreed : candidates;
  pool.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || Number(b.id || 0) - Number(a.id || 0));
  return { profile: pool[0], resolvedBy: "auto" };
}

// ─── Historical flock matching ────────────────────────────────────────────

const SEASON_OF_MONTH = (m: number) =>
  m <= 1 || m === 11 ? "dry harmattan" : m <= 3 ? "major dry" : m <= 5 ? "major rains" : m <= 7 ? "minor dry" : "minor rains";

/** Comparable = different flock, same bird type, and either closed
 *  (SOLD/CULLED/CLOSED) or an older ACTIVE flock that already lived through
 *  this flock's current age. Breed mismatches stay in (with a note). */
export function matchComparableFlocks(flock: any, allFlocks: any[]): { flock: any; note: string | null }[] {
  if (!flock) return [];
  const curSeason = SEASON_OF_MONTH(new Date(flock.arrivalDate || Date.now()).getMonth());
  return (allFlocks || [])
    .filter((f) => f && f.id !== flock.id && f.birdType === flock.birdType)
    .filter((f) => {
      const closed = ["SOLD", "CULLED", "CLOSED", "DEPLETED"].includes(String(f.status || "").toUpperCase());
      const olderActive = String(f.status || "ACTIVE") === "ACTIVE" && f.arrivalDate && flock.arrivalDate && f.arrivalDate < flock.arrivalDate;
      return closed || olderActive;
    })
    .map((f) => {
      const notes: string[] = [];
      if (f.breed && flock.breed && norm(f.breed) !== norm(flock.breed)) notes.push(`different breed (${f.breed})`);
      const season = SEASON_OF_MONTH(new Date(f.arrivalDate || Date.now()).getMonth());
      if (season !== curSeason) notes.push(`placed in ${season}`);
      return { flock: f, note: notes.join(" · ") || null };
    });
}

// ─── Per-flock actuals ────────────────────────────────────────────────────

const flockLink = (row: any, flock: any) =>
  (row.flockId != null && Number(row.flockId) === Number(flock.id)) ||
  (row.batchNumber && row.batchNumber === flock.batchNumber);

function rowsFor(data: BenchmarkDataBundle, flock: any) {
  return {
    feed: (data.feedLogs || []).filter((r: any) => flockLink(r, flock)),
    health: (data.healthRecords || []).filter((r: any) => flockLink(r, flock)),
    production: (data.production || []).filter((r: any) => flockLink(r, flock)),
    weights: (data.weightLogs || []).filter((r: any) => flockLink(r, flock)),
  };
}

function weightSamplesOf(flock: any, data: BenchmarkDataBundle) {
  const { production, weights } = rowsFor(data, flock);
  const byDate = new Map<string, number[]>();
  for (const p of production) {
    if ((p.productionType === "BROILER_WEIGHT" || p.productionType === "BROILER") && (p.avgWeightKg || 0) > 0)
      byDate.set(p.recordedDate, [...(byDate.get(p.recordedDate) || []), p.avgWeightKg]);
  }
  for (const w of weights) {
    if (w.weightKind === "BIRD" && (w.avgWeightG || 0) > 0)
      byDate.set(w.recordedDate, [...(byDate.get(w.recordedDate) || []), (w.avgWeightG || 0) / 1000]);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, xs]) => ({
      date,
      kg: +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3),
      ageDays: ageDaysOf(flock, date),
    }));
}

function aliveEstimates(flock: any, data: BenchmarkDataBundle) {
  const { health, production } = rowsFor(data, flock);
  const deathsAfter = (date: string) =>
    health.filter((h: any) => h.recordType === "MORTALITY" && (h.recordedDate || "") > date)
      .reduce((s: number, h: any) => s + (h.mortalityCount || 0), 0);
  // Harvests ON the sampling date still count as alive: farms weigh in the
  // morning and load out in the afternoon, so a same-day sale must not
  // collapse the alive estimate (critical for SOLD flocks whose
  // currentCount is 0 — otherwise FCR explodes on the final sample).
  const harvestedAfter = (date: string) =>
    production.filter((p: any) => (p.recordedDate || "") >= date)
      .reduce((s: number, p: any) => s + (p.birdsHarvested || 0), 0);
  return (date: string) => Math.max(0, (flock.currentCount || 0) + deathsAfter(date) + harvestedAfter(date));
}

/** All age-matched actuals for ONE flock as of `asOf` (default today). */
export function computeFlockActuals(
  flock: any,
  data: BenchmarkDataBundle,
  asOf?: string,
): FlockActuals {
  const ref = asOf || TODAY();
  const { feed, health, production, weights } = rowsFor(data, flock);
  const samples = weightSamplesOf(flock, data);
  const aliveOn = aliveEstimates(flock, data);

  const ageDays = flock.arrivalDate ? ageDaysOf(flock, ref) : Number(flock.ageWeeks || 0) * 7;

  // Weight + ADG
  const lastSample = samples.length ? samples[samples.length - 1] : null;
  const firstSample = samples.length ? samples[0] : null;
  const weightKg = lastSample ? lastSample.kg : null;
  const spanDays = firstSample && lastSample ? Math.max(1, Math.round((new Date(lastSample.date).getTime() - new Date(firstSample.date).getTime()) / 86400000)) : 0;
  const adgG = firstSample && lastSample && spanDays > 0 ? +(((lastSample.kg - firstSample.kg) * 1000) / spanDays).toFixed(1) : null;

  // Feed consumption + cost (own-mill rows carry derived cost; purchased
  // consumption rows fall back to this flock's purchase price basis).
  const consumption = feed.filter((f: any) => f.entryType === "CONSUMPTION");
  const totalFeedKg = consumption.reduce((s: number, f: any) => s + (f.quantityKg || 0), 0);
  let feedCost = consumption.reduce((s: number, f: any) => s + (f.totalCostGhs || 0), 0);
  if (!(feedCost > 0) && totalFeedKg > 0) {
    const perKg = consumption.find((f: any) => (f.costPerKgGhs || 0) > 0)?.costPerKgGhs;
    if (perKg) feedCost = totalFeedKg * perKg;
  }
  const purchases = feed.filter((f: any) => f.entryType === "PURCHASE" && (f.costPerKgGhs || 0) > 0);
  const purchaseAvgPerKg = purchases.length
    ? purchases.reduce((s: number, f: any) => s + (f.costPerKgGhs || 0) * (f.quantityKg || 0), 0) / purchases.reduce((s: number, f: any) => s + (f.quantityKg || 0), 0)
    : null;
  if (!(feedCost > 0) && totalFeedKg > 0 && purchaseAvgPerKg) feedCost = totalFeedKg * purchaseAvgPerKg;
  feedCost = round(feedCost, 2);
  const feedCostPerKg = totalFeedKg > 0 && feedCost != null ? +(feedCost / totalFeedKg).toFixed(2) : purchaseAvgPerKg ? +purchaseAvgPerKg.toFixed(2) : null;

  // Feed intake per bird per day (days with logged feed)
  const feedDays = new Set(consumption.map((f: any) => f.recordedDate)).size;
  const aliveNow = Math.max(flock.currentCount || 0, 1);
  const feedIntakeGBirdDay = totalFeedKg > 0 && feedDays > 0 ? +(((totalFeedKg * 1000) / aliveNow) / feedDays).toFixed(0) : null;

  // Layer production (needed before FCR — layers benchmark feed per kg egg mass)
  const eggRows = production.filter((p: any) => p.productionType === "EGGS");
  const eggsTotal = eggRows.reduce((s: number, p: any) => s + (p.eggsCollected || 0), 0);
  const recentEggRows = eggRows.filter((p: any) => p.recordedDate >= addDays(ref, -9));
  const layPct = recentEggRows.length
    ? +(recentEggRows.reduce((s: number, p: any) => s + (p.layPercentage || 0), 0) / recentEggRows.length).toFixed(1)
    : null;
  const eggWeights = weights.filter((w: any) => w.weightKind === "EGG" && (w.avgWeightG || 0) > 0).sort((a: any, b: any) => (a.recordedDate || "").localeCompare(b.recordedDate || ""));
  const eggWeightG = eggWeights.length ? eggWeights[eggWeights.length - 1].avgWeightG : null;

  // FCR (calculated). Broilers: feed ÷ live-weight gain. Layers: feed per kg
  // EGG MASS (matches the Feed Mill's FCR-egg convention).
  let fcr: number | null = null;
  let gainBirdsKg = 0;
  const isLayerFlock = String(flock.birdType || "") === "LAYERS";
  if (isLayerFlock) {
    const eggMassKg = eggsTotal > 0 && eggWeightG
      ? eggsTotal * (eggWeightG / 1000)
      : eggRows.reduce((s: number, p: any) => s + (p.totalWeightKg || 0), 0);
    fcr = totalFeedKg > 0 && eggMassKg > 0 ? +(totalFeedKg / eggMassKg).toFixed(2) : null;
  } else if (firstSample && lastSample && (lastSample.kg - firstSample.kg) > 0) {
    const aliveMid = (aliveOn(firstSample.date) + aliveOn(lastSample.date)) / 2;
    gainBirdsKg = (lastSample.kg - firstSample.kg) * Math.max(aliveMid, 1);
    fcr = totalFeedKg > 0 ? +(totalFeedKg / gainBirdsKg).toFixed(2) : null;
  }

  // Mortality
  const cumMortPct = (flock.initialCount || 0) > 0
    ? +(((flock.mortalityTotal || 0) / flock.initialCount) * 100).toFixed(2)
    : null;

  // Economics
  const healthCostGhs = round(health.reduce((s: number, h: any) => s + (h.costGhs || 0), 0), 2);
  const chickCost = (flock.costPerBirdGhs || 0) * (flock.initialCount || 0);
  const costPerBirdGhs = (flock.currentCount || 0) > 0 && (chickCost || feedCost || healthCostGhs)
    ? +((chickCost + (feedCost || 0) + healthCostGhs) / flock.currentCount).toFixed(2)
    : null;
  // Layers: feed cost per kg egg mass; others: per kg live-weight gain.
  const layerEggMassKg = eggsTotal > 0 && eggWeightG ? eggsTotal * (eggWeightG / 1000) : null;
  const feedCostPerKgGain = isLayerFlock
    ? (feedCost != null && layerEggMassKg != null && layerEggMassKg > 0 ? +(feedCost / layerEggMassKg).toFixed(2) : null)
    : feedCost != null && gainBirdsKg > 0 ? +(feedCost / gainBirdsKg).toFixed(2) : null;
  const costPerEggGhs = eggsTotal > 0 && ((feedCost || 0) + healthCostGhs) > 0 ? +(((feedCost || 0) + healthCostGhs) / eggsTotal).toFixed(3) : null;

  // Broiler efficiency index: (livability% × weight kg) / (FCR × age days) × 100
  const livability = cumMortPct != null ? 100 - cumMortPct : null;
  const ppef = livability != null && weightKg && fcr && ageDays > 0
    ? +((livability * weightKg) / (fcr * ageDays) * 100).toFixed(0)
    : null;

  return {
    ageDays, ageWeeks: +(ageDays / 7).toFixed(1), weightKg, adgG, totalFeedKg: +totalFeedKg.toFixed(1),
    feedCostGhs: feedCost, feedCostPerKg, feedIntakeGBirdDay, fcr, cumMortPct, layPct, eggWeightG,
    feedCostPerKgGain, costPerBirdGhs, costPerEggGhs,
    eggsTotal, healthCostGhs: healthCostGhs ?? 0, ppef, weightSamples: samples,
  };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ─── Weekly per-flock metric series (for historical bands) ────────────────

/** Best anchor date for a flock's "end of life" — its last logged activity. */
function lastActivityDate(flock: any, data: BenchmarkDataBundle): string {
  const dates: string[] = [];
  const { feed, health, production, weights } = rowsFor(data, flock);
  for (const r of [...feed, ...health, ...production, ...weights]) if (r.recordedDate) dates.push(r.recordedDate);
  return dates.length ? dates.sort().pop()! : TODAY();
}

function weeklyValues(flock: any, data: BenchmarkDataBundle, metric: BenchmarkMetricKey): Map<number, number> {
  const out = new Map<number, number[]>();
  const push = (wk: number, v: number) => out.set(wk, [...(out.get(wk) || []), v]);
  const { feed, health, production, weights } = rowsFor(data, flock);
  const aliveOn = aliveEstimates(flock, data);
  const isLayerFlock = String(flock.birdType || "") === "LAYERS";

  if (metric === "BODY_WEIGHT_KG") {
    for (const s of weightSamplesOf(flock, data)) push(Math.floor(s.ageDays / 7), s.kg);
  } else if (metric === "MORTALITY_CUM_PCT") {
    const deaths = health.filter((h: any) => h.recordType === "MORTALITY").sort((a: any, b: any) => (a.recordedDate || "").localeCompare(b.recordedDate || ""));
    let cum = 0;
    for (const h of deaths) {
      cum += h.mortalityCount || 0;
      push(Math.floor(ageDaysOf(flock, h.recordedDate) / 7), ((cum / (flock.initialCount || 1)) * 100));
    }
    // flocks maintained via flock.mortalityTotal only: single point at last activity
    if (!deaths.length && (flock.mortalityTotal || 0) > 0 && flock.arrivalDate) {
      push(Math.floor(ageDaysOf(flock, lastActivityDate(flock, data)) / 7), ((flock.mortalityTotal / (flock.initialCount || 1)) * 100));
    }
  } else if (metric === "LAY_PCT") {
    for (const p of production.filter((p: any) => p.productionType === "EGGS" && (p.layPercentage || 0) > 0))
      push(Math.floor(ageDaysOf(flock, p.recordedDate) / 7), p.layPercentage);
  } else if (metric === "EGG_WEIGHT_G") {
    for (const w of weights.filter((w: any) => w.weightKind === "EGG" && (w.avgWeightG || 0) > 0))
      push(Math.floor(ageDaysOf(flock, w.recordedDate) / 7), w.avgWeightG);
  } else if (metric === "FEED_INTAKE_G_BIRD") {
    // weekly mean daily feed per bird: feed kg that week ÷ (alive × logged days)
    const byWeek = new Map<number, { kg: number; days: Set<string> }>();
    for (const f of feed.filter((f: any) => f.entryType === "CONSUMPTION" && (f.quantityKg || 0) > 0)) {
      const wk = Math.floor(ageDaysOf(flock, f.recordedDate) / 7);
      const e = byWeek.get(wk) || { kg: 0, days: new Set<string>() };
      e.kg += f.quantityKg || 0;
      e.days.add(f.recordedDate);
      byWeek.set(wk, e);
    }
    for (const [wk, e] of byWeek) {
      if (e.kg > 0 && e.days.size > 0) {
        const alive = Math.max(aliveOn([...e.days].sort().pop()!) || flock.currentCount || 1, 1);
        push(wk, (e.kg * 1000) / (alive * e.days.size));
      }
    }
  } else if (metric === "FCR") {
    const samples = weightSamplesOf(flock, data);
    if (isLayerFlock) {
      // layers: cumulative feed ÷ cumulative egg mass at each week with eggs
      const eggRows = production.filter((p: any) => p.productionType === "EGGS" && (p.eggsCollected || 0) > 0);
      const eggW = weights.filter((w: any) => w.weightKind === "EGG" && (w.avgWeightG || 0) > 0);
      for (const p of eggRows) {
        const wk = Math.floor(ageDaysOf(flock, p.recordedDate) / 7);
        const feedKg = feed.filter((f: any) => f.entryType === "CONSUMPTION" && f.recordedDate <= p.recordedDate)
          .reduce((s: number, f: any) => s + (f.quantityKg || 0), 0);
        const eggs = eggRows.filter((e: any) => e.recordedDate <= p.recordedDate).reduce((s: number, e: any) => s + (e.eggsCollected || 0), 0);
        const g = eggW.filter((w: any) => w.recordedDate <= p.recordedDate).pop() as any;
        const massKg = eggs * ((g?.avgWeightG || 58) / 1000);
        if (feedKg > 0 && massKg > 0) push(wk, feedKg / massKg);
      }
    } else {
      // broilers: cumulative feed ÷ cumulative gain at each weight sample week
      for (const s of samples) {
        const prior = samples.filter((x) => x.date <= s.date);
        if (prior.length < 2) continue;
        const first = prior[0];
        const gainPerBird = s.kg - first.kg;
        if (gainPerBird <= 0) continue;
        const feedKg = feed.filter((f: any) => f.entryType === "CONSUMPTION" && f.recordedDate <= s.date && f.recordedDate >= first.date)
          .reduce((s2: number, f: any) => s2 + (f.quantityKg || 0), 0);
        const aliveMid = (aliveOn(first.date) + aliveOn(s.date)) / 2;
        const gain = gainPerBird * Math.max(aliveMid, 1);
        if (feedKg > 0 && gain > 0) push(Math.floor(s.ageDays / 7), feedKg / gain);
      }
    }
  }

  const means = new Map<number, number>();
  for (const [wk, xs] of out) means.set(wk, +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3));
  return means;
}

// ─── The main entry point ─────────────────────────────────────────────────

export interface ComputeBenchmarksInput extends BenchmarkDataBundle {
  flock: any;
  profiles?: BenchmarkProfileLike[];
  /** Live price for close-out margin (GH₵/kg); profile _meta default used when omitted. */
  livePricePerKgGhs?: number | null;
  asOf?: string;
}

export function computeBenchmarks(input: ComputeBenchmarksInput): BenchmarkResult {
  const { flock, profiles, asOf } = input;
  const birdType = String(flock?.birdType || "");
  const isLayer = birdType === "LAYERS";

  const { profile, resolvedBy } = resolveProfile(flock, profiles);
  const curves = (profile?.curves || null) as BenchmarkCurves | null;
  const warnDefault = Number(profile?.toleranceWarnPct) || 5;
  const critDefault = Number(profile?.toleranceCritPct) || 10;

  const actuals = computeFlockActuals(flock, input, asOf);

  // Comparable history
  const history = matchComparableFlocks(flock, input.flocks || [])
    .map((m) => {
      const a = computeFlockActuals(m.flock, input, asOf);
      const hasData = a.weightSamples.length > 0 || a.totalFeedKg > 0 || a.eggsTotal > 0 || (m.flock.mortalityTotal || 0) > 0;
      return { ...m, actuals: a, hasData };
    })
    .filter((m) => m.hasData);

  // ── KPIs ──
  // ADG target is DERIVED from the body-weight curve over the SAME sample
  // window the actual ADG covers (avg gain since first sample) — comparing
  // against a marginal weekly-gain curve would be apples-to-oranges. A direct
  // ADG_G curve is still honoured when the owner defined one explicitly.
  const targetOf = (key: BenchmarkMetricKey): number | null => {
    if (key === "ADG_G" && curves?.BODY_WEIGHT_KG && actuals.weightSamples.length >= 2) {
      const first = actuals.weightSamples[0];
      const last = actuals.weightSamples[actuals.weightSamples.length - 1];
      const days = Math.round((new Date(last.date).getTime() - new Date(first.date).getTime()) / 86400000);
      if (days > 0) {
        const tFirst = curveAt(curves, "BODY_WEIGHT_KG", first.ageDays);
        const tLast = curveAt(curves, "BODY_WEIGHT_KG", last.ageDays);
        if (tFirst != null && tLast != null && tLast > tFirst) {
          return +(((tLast - tFirst) * 1000) / days).toFixed(1);
        }
      }
    }
    return curveAt(curves, key, actuals.ageDays);
  };

  const histValue = (key: BenchmarkMetricKey, pick: "median" | "best"): number | null => {
    const vals = history
      .map((h) => actualOf(h.actuals, key))
      .filter((v): v is number => v != null);
    if (!vals.length) return null;
    if (pick === "median") return quantile([...vals].sort((a, b) => a - b), 0.5);
    const better = BENCHMARK_METRIC_META[key].better;
    return better === "higher" ? Math.max(...vals) : Math.min(...vals);
  };

  const kpis: BenchmarkKpi[] = (Object.keys(BENCHMARK_METRIC_META) as BenchmarkMetricKey[])
    .filter((key) => BENCHMARK_METRIC_META[key].appliesTo(birdType))
    .map((key) => {
      const meta = BENCHMARK_METRIC_META[key];
      const actual = actualOf(actuals, key);
      const target = meta.informational ? null : targetOf(key);
      const histMedian = histValue(key, "median");
      const histBest = histValue(key, "best");
      const def = curves?.[key];
      const warn = Number(def?.warnPct) || warnDefault;
      const crit = Number(def?.critPct) || critDefault;

      let variancePct: number | null = null;
      let driftPct: number | null = null;
      let histDriftPct: number | null = null;
      let status: BenchmarkKpi["status"] = "NO_DATA";
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
        key, label: layerLabel(key, isLayer), unit: meta.unit, actual, target, histMedian, histBest,
        variancePct, driftPct, histDriftPct, status, better: meta.better,
        informational: meta.informational || undefined,
      };
    });

  // PPEF (broiler efficiency index) is exposed through `actuals.ppef` and
  // rendered by the panel directly — no target curve ships for it, so it is
  // not part of the scored KPI list.

  // ── Weekly age-matched series (actual + target + history band) ──
  const series: Partial<Record<BenchmarkMetricKey, BenchmarkSeriesRow[]>> = {};
  const seriesMetrics: BenchmarkMetricKey[] = ["BODY_WEIGHT_KG", "MORTALITY_CUM_PCT", "LAY_PCT", "EGG_WEIGHT_G", "FCR", "FEED_INTAKE_G_BIRD"];
  for (const metric of seriesMetrics) {
    if (!BENCHMARK_METRIC_META[metric].appliesTo(birdType)) continue;
    const actualWeekly = weeklyValues(flock, input, metric);
    const hist: Map<number, number[]> = new Map();
    for (const h of history) {
      for (const [wk, v] of weeklyValues(h.flock, input, metric)) hist.set(wk, [...(hist.get(wk) || []), v]);
    }
    const weeks = new Set<number>([...actualWeekly.keys(), ...hist.keys()]);
    const curveDef = curves?.[metric];
    if (curveDef) {
      // include curve coverage weeks so the target line spans the template
      for (const [a] of curveDef.points) {
        const wk = curveDef.by === "ageWeeks" ? a : a / 7;
        if (Number.isInteger(wk)) weeks.add(wk);
      }
    }
    const rows: BenchmarkSeriesRow[] = [...weeks]
      .filter((wk) => wk >= 0 && wk <= Math.ceil(actuals.ageDays / 7) + 1)
      .sort((a, b) => a - b)
      .map((wk) => {
        const ageDays = wk * 7;
        const sorted = [...(hist.get(wk) || [])].sort((a, b) => a - b);
        return {
          age: `W${wk}`, week: wk,
          actual: actualWeekly.has(wk) ? actualWeekly.get(wk) : null,
          target: curveAt(curves, metric, ageDays),
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
  const weighted = kpis.filter((k) => !k.informational && k.status !== "NO_DATA" && SCORECARD_WEIGHTS[k.key]);
  if (weighted.length) {
    const totalW = weighted.reduce((s, k) => s + (SCORECARD_WEIGHTS[k.key] || 0), 0);
    const score = weighted.reduce((s, k) => s + (SCORECARD_WEIGHTS[k.key] || 0) * (k.status === "ON_TRACK" ? 1 : k.status === "WATCH" ? 0.6 : 0), 0);
    compliancePct = +((score / totalW) * 100).toFixed(0);
    evaluated = weighted.length;
  }
  const grade = compliancePct == null ? null : compliancePct >= 95 ? "A" : compliancePct >= 85 ? "B" : compliancePct >= 70 ? "C" : "D";

  // ── Close-out projection (broilers, or any flock with a weight curve) ──
  let projection: CloseOutProjection | null = null;
  const weightCurve = curves?.BODY_WEIGHT_KG;
  const marketAgeDays = curves?._meta?.marketAgeDays || (weightCurve ? weightCurve.points[weightCurve.points.length - 1][0] : null);
  if (marketAgeDays && actuals.ageDays < marketAgeDays && (actuals.weightKg || curveAt(curves, "BODY_WEIGHT_KG", actuals.ageDays))) {
    const livePrice = Number(input.livePricePerKgGhs) || Number(curves?._meta?.livePricePerKgGhs) || 45;
    const daysRemaining = Math.max(0, marketAgeDays - actuals.ageDays);
    const currentW = actuals.weightKg ?? curveAt(curves, "BODY_WEIGHT_KG", actuals.ageDays) ?? 0;
    const targetAtMarket = curveAt(curves, "BODY_WEIGHT_KG", marketAgeDays);
    const projectedW = actuals.adgG != null ? +(currentW + (actuals.adgG / 1000) * daysRemaining).toFixed(2) : targetAtMarket;
    const fcrBasis = actuals.fcr ?? curveAt(curves, "FCR", marketAgeDays);
    const gainRemainingPerBird = Math.max(0, (projectedW || 0) - currentW);
    const feedKgRemaining = fcrBasis ? +(fcrBasis * gainRemainingPerBird * (flock.currentCount || 0)).toFixed(0) : null;
    const costPerKgBasis = actuals.feedCostPerKg ?? null;
    const feedCostRemaining = feedKgRemaining != null && costPerKgBasis ? +(feedKgRemaining * costPerKgBasis).toFixed(2) : null;
    const birds = flock.currentCount || 0;
    const costPerBirdNow = actuals.costPerBirdGhs;
    const feedRemainPerBird = feedKgRemaining != null && birds > 0 ? feedKgRemaining / birds : null;
    const projectedCostPerBird = costPerBirdNow != null && feedRemainPerBird != null && costPerKgBasis
      ? +(costPerBirdNow + feedRemainPerBird * costPerKgBasis).toFixed(2) : null;
    const revenuePerBird = projectedW != null ? +(projectedW * livePrice).toFixed(2) : null;
    const marginPerBird = revenuePerBird != null && projectedCostPerBird != null ? +(revenuePerBird - projectedCostPerBird).toFixed(2) : null;
    projection = {
      marketAgeDays, daysRemaining, currentWeightKg: actuals.weightKg, projectedWeightKg: projectedW,
      targetWeightKg: targetAtMarket, projectedFcr: fcrBasis, feedKgRemaining, feedCostRemainingGhs: feedCostRemaining,
      costPerBirdToDateGhs: costPerBirdNow, projectedCostPerBirdGhs: projectedCostPerBird,
      livePricePerKgGhs: livePrice, revenuePerBirdGhs: revenuePerBird, marginPerBirdGhs: marginPerBird,
      marginTotalGhs: marginPerBird != null ? +(marginPerBird * birds).toFixed(2) : null,
      assumptions: [
        actuals.adgG != null ? `growth continues at the current ${actuals.adgG} g/day` : "no ADG yet — projection uses the profile target weight",
        fcrBasis ? `feed conversion holds at ${(+fcrBasis).toFixed(2)}` : "FCR unknown — feed-to-finish not estimated",
        costPerKgBasis ? `feed priced at GH₵${costPerKgBasis}/kg (recent cost basis)` : "no feed cost basis yet",
        `live price GH₵${livePrice}/kg (editable below)`,
      ],
    };
  }

  const hasAnyBenchmark = !!(curves && Object.keys(curves).some((k) => k !== "_meta")) || history.length > 0;

  return {
    flock, profile, profileResolvedBy: resolvedBy, actuals, kpis, series,
    history: history.map((h) => ({ flock: h.flock, note: h.note })),
    scorecard: { grade, compliancePct, evaluated },
    projection,
    hasAnyBenchmark,
  };
}

function actualOf(a: FlockActuals, key: BenchmarkMetricKey): number | null {
  switch (key) {
    case "BODY_WEIGHT_KG": return a.weightKg;
    case "ADG_G": return a.adgG;
    case "FCR": return a.fcr;
    case "MORTALITY_CUM_PCT": return a.cumMortPct;
    case "FEED_INTAKE_G_BIRD": return a.feedIntakeGBirdDay;
    case "LAY_PCT": return a.layPct;
    case "EGG_WEIGHT_G": return a.eggWeightG;
    case "FEED_COST_PER_KG_GAIN": return a.feedCostPerKgGain;
    case "COST_PER_BIRD": return a.costPerBirdGhs;
    case "COST_PER_EGG": return a.costPerEggGhs;
    default: return null;
  }
}

function layerLabel(key: BenchmarkMetricKey, isLayer: boolean): string {
  if (key === "FEED_COST_PER_KG_GAIN" && isLayer) return "Feed cost / kg egg mass";
  if (key === "FCR" && isLayer) return "FCR (feed/kg egg mass)";
  return BENCHMARK_METRIC_META[key].label;
}

// ─── Alerts (PoultryAlert-shaped — drop into the existing panel) ──────────

export function computeBenchmarkAlerts(res: BenchmarkResult | null): PoultryAlert[] {
  if (!res || !res.hasAnyBenchmark) return [];
  const today = TODAY();
  const alerts: PoultryAlert[] = [];
  const kpi = (key: BenchmarkMetricKey) => res.kpis.find((k) => k.key === key && !k.informational);
  const name = res.flock?.batchNumber || "flock";
  const push = (a: PoultryAlert) => alerts.push(a);

  const weight = kpi("BODY_WEIGHT_KG");
  if (weight && weight.status === "OFF_TRACK") {
    push({
      id: "bench-weight-off", level: "critical", category: "Benchmark",
      title: "Weight Below Benchmark",
      message: `${name} weighs ${weight.actual}kg at age ${res.actuals.ageDays}d — ${Math.abs(weight.driftPct || 0).toFixed(1)}% behind the "${res.profile?.name || "benchmark"}" target of ${weight.target}kg.`,
      recommendation: "Review feed intake and quality vs the target curve, check for disease (coccidiosis, respiratory signs), density and temperature. A vet check is advisable when the gap exceeds 10%.",
      timestamp: today, value: `${weight.actual}kg`, threshold: `${weight.target}kg`,
    });
  } else if (weight && weight.status === "WATCH") {
    push({
      id: "bench-weight-watch", level: "warning", category: "Benchmark",
      title: "Weight Slightly Below Benchmark",
      message: `${name} weighs ${weight.actual}kg vs target ${weight.target}kg (${weight.driftPct}% at age ${res.actuals.ageDays}d).`,
      recommendation: "Tighten feeding program adherence and re-weigh in 3–4 days to confirm the trend before acting.",
      timestamp: today, value: `${weight.actual}kg`, threshold: `${weight.target}kg`,
    });
  }

  const fcr = kpi("FCR");
  if (fcr && (fcr.status === "WATCH" || fcr.status === "OFF_TRACK")) {
    push({
      id: "bench-fcr-watch", level: fcr.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "FCR Above Benchmark",
      message: `Calculated FCR is ${fcr.actual} vs benchmark ${fcr.target} (${fcr.driftPct}% worse at age ${res.actuals.ageDays}d).`,
      recommendation: "Check feed wastage at feeders, house temperature (cold birds over-eat), feed quality and pelleting, and bird health.",
      timestamp: today, value: `${fcr.actual}`, threshold: `${fcr.target}`,
    });
  }

  const mort = kpi("MORTALITY_CUM_PCT");
  if (mort && (mort.status === "WATCH" || mort.status === "OFF_TRACK")) {
    push({
      id: "bench-mortality-off", level: mort.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "Mortality Above Benchmark",
      message: `Cumulative mortality is ${mort.actual}% vs benchmark ${mort.target}% at age ${res.actuals.ageDays}d.`,
      recommendation: "Investigate immediately: review recent health records, litter/ammonia conditions, water lines, and heat or transport stress. Escalate to a vet if daily mortality exceeds 1%.",
      timestamp: today, value: `${mort.actual}%`, threshold: `${mort.target}%`,
    });
  }

  const lay = kpi("LAY_PCT");
  if (lay && (lay.status === "WATCH" || lay.status === "OFF_TRACK")) {
    push({
      id: "bench-lay-off", level: lay.status === "OFF_TRACK" ? "critical" : "warning", category: "Benchmark",
      title: "Lay Rate Below Benchmark",
      message: `Lay rate is ${lay.actual}% vs benchmark ${lay.target}% at age ${res.actuals.ageWeeks}w.`,
      recommendation: "Verify lighting program (14–16h), feed intake and calcium level, water availability, and heat stress. Check for disease signs.",
      timestamp: today, value: `${lay.actual}%`, threshold: `${lay.target}%`,
    });
  }

  const cost = kpi("FEED_COST_PER_KG_GAIN");
  if (cost && (cost.status === "WATCH" || cost.status === "OFF_TRACK")) {
    push({
      id: "bench-feedcost-watch", level: "warning", category: "Benchmark",
      title: "Feed Cost per kg Gain Above Benchmark",
      message: `Feed cost is GH₵${cost.actual} per kg gained vs benchmark GH₵${cost.target}.`,
      recommendation: "Compare own-milled vs purchased feed cost per kg (Feed Mill tab) and review FCR drivers — cheaper feed that worsens FCR often costs more per kg gain.",
      timestamp: today, value: `GH₵${cost.actual}`, threshold: `GH₵${cost.target}`,
    });
  }

  const evaluated = res.kpis.filter((k) => !k.informational && k.status !== "NO_DATA");
  if (!alerts.length && evaluated.length >= 2) {
    push({
      id: "bench-on-track", level: "normal", category: "Benchmark",
      title: "Flock Tracking Benchmark",
      message: `${name} is within tolerance on all ${evaluated.length} benchmarked metrics (scorecard ${res.scorecard.grade ?? "—" }).`,
      recommendation: "Keep the current feeding and management program.",
      timestamp: today, value: res.scorecard.grade ?? "", threshold: "",
    });
  }

  return alerts;
}

// ─── Fallback target helpers for charts (built-in curves) ─────────────────

/** Profile target when one resolves, else the built-in breed curve — used by
 *  the Growth Analytics overlays so charts keep their current look when no
 *  profile is configured. */
export function weightTargetFor(flock: any, profiles: BenchmarkProfileLike[] | null | undefined, ageDays: number): number | null {
  const { profile } = resolveProfile(flock, profiles);
  const fromProfile = curveAt((profile?.curves || null) as BenchmarkCurves | null, "BODY_WEIGHT_KG", ageDays);
  if (fromProfile != null) return fromProfile;
  return flock?.birdType === "LAYERS" ? layerTargetKg(ageDays) : broilerTargetKg(ageDays);
}

/** Derive a full curves payload from a real (usually finished) flock — the
 *  "what our own best batch achieved" profile. Weekly means per metric. */
export function deriveCurvesFromFlock(flock: any, data: BenchmarkDataBundle): BenchmarkCurves {
  const isLayerFlock = String(flock?.birdType || "") === "LAYERS";
  const curves: BenchmarkCurves = {};
  const set = (key: BenchmarkMetricKey, by: "ageDays" | "ageWeeks", weekly: Map<number, number>, unit: string) => {
    const pts = [...weekly.entries()].filter(([, v]) => Number.isFinite(v) && v > 0).sort((a, b) => a[0] - b[0]);
    if (pts.length >= 2) (curves as any)[key] = { by, unit, points: pts.map(([wk, v]) => [by === "ageWeeks" ? wk : wk * 7, +(+v).toFixed(3)]) };
  };

  set("BODY_WEIGHT_KG", "ageDays", weeklyValues(flock, data, "BODY_WEIGHT_KG"), "kg");
  set("MORTALITY_CUM_PCT", "ageDays", weeklyValues(flock, data, "MORTALITY_CUM_PCT"), "%");
  set("FCR", "ageDays", weeklyValues(flock, data, "FCR"), "");
  set("FEED_INTAKE_G_BIRD", "ageDays", weeklyValues(flock, data, "FEED_INTAKE_G_BIRD"), "g/bird/day");
  if (isLayerFlock) {
    set("LAY_PCT", "ageWeeks", weeklyValues(flock, data, "LAY_PCT"), "%");
    set("EGG_WEIGHT_G", "ageWeeks", weeklyValues(flock, data, "EGG_WEIGHT_G"), "g");
  }

  const a = computeFlockActuals(flock, data);
  curves._meta = {
    marketAgeDays: Math.max(21, Math.round(a.ageDays)),
    livePricePerKgGhs: undefined,
  };
  return curves;
}

// ─── Validation (server-side, used by the benchmarks API) ─────────────────

export const BENCHMARK_METRIC_KEYS: BenchmarkMetricKey[] = [
  "BODY_WEIGHT_KG", "ADG_G", "FCR", "MORTALITY_CUM_PCT", "FEED_INTAKE_G_BIRD",
  "LAY_PCT", "EGG_WEIGHT_G", "FEED_COST_PER_KG_GAIN", "COST_PER_BIRD", "COST_PER_EGG",
];

/** Validates + normalizes a curves payload. Returns null when invalid. */
export function validateCurves(raw: any): { curves: BenchmarkCurves; error?: string } {
  if (raw == null) return { curves: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { curves: {}, error: "curves must be an object" };
  const out: BenchmarkCurves = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "_meta") {
      const m = val as any;
      out._meta = {
        marketAgeDays: m?.marketAgeDays != null ? Math.max(1, Math.round(+m.marketAgeDays)) || undefined : undefined,
        livePricePerKgGhs: m?.livePricePerKgGhs != null && +m.livePricePerKgGhs > 0 ? +(+m.livePricePerKgGhs).toFixed(2) : undefined,
      };
      continue;
    }
    if (!BENCHMARK_METRIC_KEYS.includes(key as BenchmarkMetricKey)) continue; // ignore unknown keys (forward-compat)
    const def = val as BenchmarkCurveDef;
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
