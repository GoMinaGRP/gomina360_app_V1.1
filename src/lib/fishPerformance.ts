// Pure computation library for the Aquaculture Production & Growth Analytics
// panel. Given the raw module datasets (ponds, batches, feed logs, harvests,
// daily weight-sampling logs) + scope filters, it derives every series the
// dashboard charts render: growth vs species standard, average weight by
// age, feed consumption, survival/mortality per batch, harvest production,
// estimated biomass — plus KPI chips incl. FCR calculated from weighings.

const TODAY = () => new Date().toISOString().split("T")[0];

/** Mirrors the dashboard date-filter semantics (ALL/TODAY/LAST_7/LAST_30). */
export function withinDateFilter(dateStr: string | undefined | null, dateFilter?: string): boolean {
  if (!dateStr) return false;
  const f = dateFilter || "ALL";
  if (f === "ALL") return true;
  const today = TODAY();
  if (f === "TODAY") return dateStr === today;
  const limit = new Date();
  if (f === "LAST_7") limit.setDate(limit.getDate() - 7);
  else if (f === "LAST_30") limit.setDate(limit.getDate() - 30);
  else return true;
  return new Date(dateStr) >= limit;
}

const ageDaysBetween = (birth: string, date: string) =>
  Math.max(0, Math.round((new Date(date).getTime() - new Date(birth).getTime()) / 86400000));

/** Species target live weight (grams) by age in days. Tilapia: fingerling
 *  ~2g → table size ~500g at ~7 months. Catfish grows faster (~1.2kg). */
export function speciesTargetG(species: string, ageDays: number): number {
  const isCatfish = /CATFISH/i.test(species || "");
  const pts: [number, number][] = isCatfish
    ? [[0, 1], [28, 20], [56, 90], [84, 220], [112, 420], [140, 650], [168, 900], [196, 1150]]
    : [[0, 2], [28, 15], [56, 60], [84, 140], [112, 240], [140, 340], [168, 430], [196, 520]];
  if (ageDays <= 0) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (ageDays <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return +(y0 + ((y1 - y0) * (ageDays - x0)) / (x1 - x0)).toFixed(1);
    }
  }
  return pts[pts.length - 1][1];
}

const MEAN = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface FishPerfFilters {
  dateFilter?: string; // ALL | TODAY | LAST_7 | LAST_30
  batchNumber?: string; // exact batch code
  batchId?: number | null;
  pondId?: number | null;
  species?: string; // ALL | species code
  branchCode?: string; // ALL | branch code
}

export interface FishPerfResult {
  /** Daily average sampled weight (g) vs species-standard target */
  growthTrend: { date: string; avgWeightG: number; targetG: number }[];
  /** Average sampled weight (g) bucketed by batch age (weeks) vs target */
  weightByAge: { age: string; avgWeightG: number; targetG: number }[];
  /** Daily feed consumption (kg) in scope */
  feedDaily: { date: string; kg: number }[];
  /** Survival/mortality per batch (bars) */
  survivalByBatch: { batch: string; survivalPct: number; deaths: number; alive: number }[];
  /** Daily harvests (fish count + total kg + revenue) */
  harvestDaily: { date: string; count: number; weightKg: number; revenueGhs: number }[];
  /** Daily estimated standing biomass (kg) = avg sampled weight × estimated fish alive that day */
  biomassDaily: { date: string; biomassKg: number }[];
  kpis: {
    totalFeedKg: number;
    calcFcr: number | null;
    survivalPct: number | null;
    totalDeaths: number;
    stocked: number;
    aliveFish: number;
    avgDailyGainG: number | null;
    biomassKg: number | null;
    avgWeightG: number | null;
    harvested: number;
    harvestKg: number;
  };
}

export function computeFishPerformance(
  {
    batches,
    feedLogs,
    harvests,
    weightLogs,
  }: { batches: any[]; feedLogs: any[]; harvests: any[]; weightLogs?: any[] },
  filters: FishPerfFilters,
): FishPerfResult {
  const batchById = new Map((batches || []).map((b) => [b.id, b]));
  const batchByNumber = new Map((batches || []).map((b) => [b.batchNumber, b]));
  const batchOf = (row: any) => row.batchNumber || batchById.get(row.batchId)?.batchNumber || null;
  const pondOf = (row: any) => row.pondId ?? batchById.get(row.batchId)?.pondId ?? batchByNumber.get(batchOf(row))?.pondId ?? null;
  const speciesOf = (row: any) => row.species || batchById.get(row.batchId)?.species || batchByNumber.get(batchOf(row))?.species || null;

  const keep = (row: any, dateField = "recordedDate") =>
    withinDateFilter(row[dateField], filters.dateFilter) &&
    (!filters.batchNumber || filters.batchNumber === "ALL" || batchOf(row) === filters.batchNumber) &&
    (!filters.batchId || row.batchId === filters.batchId || batchOf(row) === batchById.get(filters.batchId)?.batchNumber) &&
    (!filters.pondId || pondOf(row) === filters.pondId) &&
    (!filters.species || filters.species === "ALL" || speciesOf(row) === filters.species) &&
    (!filters.branchCode || filters.branchCode === "ALL" || row.branchCode === filters.branchCode);

  const feed = (feedLogs || []).filter((f) => keep(f) && f.entryType === "CONSUMPTION");
  const harv = (harvests || []).filter((h) => keep(h, "saleDate"));
  const wlogs = (weightLogs || []).filter((w) => keep(w) && (w.avgWeightG || 0) > 0);

  const selBatches = (batches || []).filter(
    (b) =>
      (!filters.batchNumber || filters.batchNumber === "ALL" || b.batchNumber === filters.batchNumber) &&
      (!filters.batchId || b.id === filters.batchId) &&
      (!filters.pondId || b.pondId === filters.pondId) &&
      (!filters.species || filters.species === "ALL" || b.species === filters.species) &&
      (!filters.branchCode || filters.branchCode === "ALL" || b.branchCode === filters.branchCode),
  );
  const stocked = selBatches.reduce((s, b) => s + (b.initialCount || 0), 0);
  const aliveFish = selBatches.reduce((s, b) => s + (b.currentCount || 0), 0);
  const totalDeaths = selBatches.reduce((s, b) => s + (b.mortalityTotal || 0), 0);

  // ── Daily growth trend (sampled g vs species target) ─────────────────
  const byDate = new Map<string, { w: number[]; t: number[] }>();
  for (const w of wlogs) {
    const batch = (w.batchId && batchById.get(w.batchId)) || batchByNumber.get(w.batchNumber);
    const age = batch?.hatchDate ? ageDaysBetween(batch.hatchDate, w.recordedDate) : null;
    const e = byDate.get(w.recordedDate) || { w: [], t: [] };
    e.w.push(w.avgWeightG);
    if (age != null) e.t.push(speciesTargetG(w.species || batch?.species, age));
    byDate.set(w.recordedDate, e);
  }
  const growthTrend = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, avgWeightG: +MEAN(v.w).toFixed(1), targetG: v.t.length ? +MEAN(v.t).toFixed(1) : null as any }))
    .filter((r) => r.targetG != null);

  // ── Average weight by age (weekly buckets) ───────────────────────────
  const byAge = new Map<number, { w: number[]; t: number[] }>();
  for (const w of wlogs) {
    const batch = (w.batchId && batchById.get(w.batchId)) || batchByNumber.get(w.batchNumber);
    if (!batch?.hatchDate) continue;
    const age = ageDaysBetween(batch.hatchDate, w.recordedDate);
    const wk = Math.floor(age / 7);
    const e = byAge.get(wk) || { w: [], t: [] };
    e.w.push(w.avgWeightG);
    e.t.push(speciesTargetG(w.species || batch.species, age));
    byAge.set(wk, e);
  }
  const weightByAge = [...byAge.entries()].sort((a, b) => a[0] - b[0])
    .map(([wk, v]) => ({ age: `W${wk}`, avgWeightG: +MEAN(v.w).toFixed(1), targetG: +MEAN(v.t).toFixed(1) }));

  // ── Daily feed consumption ───────────────────────────────────────────
  const feedMap = new Map<string, number>();
  for (const f of feed) feedMap.set(f.recordedDate, (feedMap.get(f.recordedDate) || 0) + (f.quantityKg || 0));
  const feedDaily = [...feedMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, kg]) => ({ date, kg: +kg.toFixed(2) }));

  // ── Survival / mortality per batch ───────────────────────────────────
  const survivalByBatch = selBatches
    .filter((b) => (b.initialCount || 0) > 0)
    .map((b) => ({
      batch: b.batchNumber,
      survivalPct: +(((b.currentCount || 0) / b.initialCount) * 100).toFixed(1),
      deaths: b.mortalityTotal || 0,
      alive: b.currentCount || 0,
    }))
    .sort((a, b) => a.batch.localeCompare(b.batch));

  // ── Daily harvest production ─────────────────────────────────────────
  const harvMap = new Map<string, { count: number; weightKg: number; revenueGhs: number }>();
  for (const h of harv) {
    const e = harvMap.get(h.saleDate) || { count: 0, weightKg: 0, revenueGhs: 0 };
    e.count += h.harvestedCount || 0;
    e.weightKg += h.totalWeightKg || 0;
    e.revenueGhs += h.revenueGhs || 0;
    harvMap.set(h.saleDate, e);
  }
  const harvestDaily = [...harvMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, count: v.count, weightKg: +v.weightKg.toFixed(1), revenueGhs: +v.revenueGhs.toFixed(2) }));

  // ── Estimated standing biomass (kg) ──────────────────────────────────
  const harvAfter = (batch: any, date: string) =>
    harv.filter((h) => batchOf(h) === batch.batchNumber && h.saleDate > date)
      .reduce((s, h) => s + (h.harvestedCount || 0), 0);
  const aliveOn = (batch: any, date: string) => (batch.currentCount || 0) + harvAfter(batch, date);
  const sampleByDateBatch = new Map<string, number[]>();
  for (const w of wlogs) {
    const batch = (w.batchId && batchById.get(w.batchId)) || batchByNumber.get(w.batchNumber);
    if (!batch) continue;
    const k = `${w.recordedDate}|${batch.batchNumber}`;
    sampleByDateBatch.set(k, [...(sampleByDateBatch.get(k) || []), w.avgWeightG]);
  }
  const bioMap = new Map<string, number>();
  for (const [k, xs] of sampleByDateBatch) {
    const [date, batchNum] = k.split("|");
    const batch = batchByNumber.get(batchNum);
    if (!batch) continue;
    bioMap.set(date, (bioMap.get(date) || 0) + (MEAN(xs) / 1000) * aliveOn(batch, date));
  }
  const biomassDaily = [...bioMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, kg]) => ({ date, biomassKg: +kg.toFixed(1) }));

  // ── KPIs ─────────────────────────────────────────────────────────────
  const totalFeedKg = feedDaily.reduce((s, r) => s + r.kg, 0);
  const survivalPct = stocked > 0 ? +((aliveFish / stocked) * 100).toFixed(1) : null;
  const avgDailyGainG = growthTrend.length >= 2
    ? +((growthTrend[growthTrend.length - 1].avgWeightG - growthTrend[0].avgWeightG) /
        Math.max(1, ageDaysBetween(growthTrend[0].date, growthTrend[growthTrend.length - 1].date))).toFixed(1)
    : null;
  // FCR calculated from actual weighings × feed rows.
  let totalGainKg = 0;
  const sampleDatesByBatch = new Map<string, string[]>();
  for (const k of sampleByDateBatch.keys()) {
    const [date, batchNum] = k.split("|");
    sampleDatesByBatch.set(batchNum, [...(sampleDatesByBatch.get(batchNum) || []), date]);
  }
  for (const [batchNum, dates] of sampleDatesByBatch) {
    const batch = batchByNumber.get(batchNum);
    if (!batch || !selBatches.some((b) => b.batchNumber === batchNum)) continue;
    const uniq = [...new Set(dates)].sort();
    if (uniq.length < 2) continue;
    const first = uniq[0], last = uniq[uniq.length - 1];
    const wFirst = MEAN(sampleByDateBatch.get(`${first}|${batchNum}`) || []);
    const wLast = MEAN(sampleByDateBatch.get(`${last}|${batchNum}`) || []);
    const gainPerFishKg = (wLast - wFirst) / 1000;
    if (gainPerFishKg <= 0) continue;
    const aliveMid = (aliveOn(batch, first) + aliveOn(batch, last)) / 2;
    totalGainKg += gainPerFishKg * aliveMid;
  }
  const calcFcr = totalFeedKg > 0 && totalGainKg > 0 ? +(totalFeedKg / totalGainKg).toFixed(2) : null;
  const avgWeightG = growthTrend.length ? growthTrend[growthTrend.length - 1].avgWeightG : null;
  const biomassKg = biomassDaily.length ? biomassDaily[biomassDaily.length - 1].biomassKg : null;
  const harvested = harvestDaily.reduce((s, r) => s + r.count, 0);
  const harvestKg = harvestDaily.reduce((s, r) => s + r.weightKg, 0);

  return {
    growthTrend, weightByAge, feedDaily, survivalByBatch, harvestDaily, biomassDaily,
    kpis: { totalFeedKg: +totalFeedKg.toFixed(1), calcFcr, survivalPct, totalDeaths, stocked, aliveFish, avgDailyGainG, biomassKg, avgWeightG, harvested, harvestKg: +harvestKg.toFixed(1) },
  };
}
