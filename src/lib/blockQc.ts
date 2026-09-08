// Block Factory QC analytics — pure functions shared by the QC dashboard
// (BlockQcCenter) and the verification suites. Everything derives from the
// rows in block_qc_checks joined to production batches (block_factory_logs),
// so the pipeline Raw Materials → Production → Curing → QC → Inventory →
// Sales stays linked end-to-end.

export const QC_STAGES = ["RAW_MATERIAL", "MIXING", "PRODUCTION", "CURING", "FINISHED_BLOCK"] as const;
export type QcStage = (typeof QC_STAGES)[number];

export const QC_STAGE_LABELS: Record<string, string> = {
  RAW_MATERIAL: "Raw Materials",
  MIXING: "Mixing",
  PRODUCTION: "Production",
  CURING: "Curing",
  FINISHED_BLOCK: "Finished Blocks",
};

// Ghana Standards GS 1193-aligned defaults for load-bearing concrete blocks.
export const STRENGTH_STANDARD_MPA = 3.5;
export const CURING_MIN_DAYS = 7;

// Heuristic target weights per block type when the tester hasn't entered a
// bespoke standard — used only for the weight-variation guide line.
export const BLOCK_WEIGHT_TARGET_KG: Record<string, number> = {
  "6-INCH-SOLID": 18,
  "6-INCH-HOLLOW": 14,
  "5-INCH-SOLID": 14,
  "5-INCH-HOLLOW": 11,
  "4-INCH-SOLID": 12,
  "4-INCH-HOLLOW": 9,
  "PAVING-BRICKS": 4,
};
export const blockWeightTargetKg = (blockType?: string | null) =>
  BLOCK_WEIGHT_TARGET_KG[String(blockType || "").toUpperCase()] ?? null;

export interface QcFilters {
  branchCode?: string; // ALL | code
  batchId?: string; // ALL | batch id
  blockType?: string; // ALL | type key
  dateFilter?: string; // ALL | YYYY-MM-DD
  tester?: string; // ALL | tester name
}

const ok = (v: any) => v !== undefined && v !== null && v !== "";
const day = (t: any): string => (t ? new Date(t).toISOString().slice(0, 10) : "");

export function filterQcChecks(checks: any[], f: QcFilters): any[] {
  return (checks || []).filter((c) => {
    if (f.branchCode && f.branchCode !== "ALL" && c.branchCode !== f.branchCode) return false;
    if (f.batchId && f.batchId !== "ALL" && c.batchId !== f.batchId) return false;
    if (f.blockType && f.blockType !== "ALL" && c.blockType !== f.blockType) return false;
    if (f.tester && f.tester !== "ALL" && (c.testerName || "") !== f.tester) return false;
    if (f.dateFilter && f.dateFilter !== "ALL" && day(c.testedAt) !== f.dateFilter) return false;
    return true;
  });
}

/** Auto-compute density (kg/m³) from weight + dimensions when not supplied. */
export function deriveDensityKgm3(c: { weightKg?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null; densityKgm3?: number | null }): number | null {
  if (ok(c.densityKgm3)) return Number(c.densityKgm3);
  const { weightKg: w, lengthMm: l, widthMm: wi, heightMm: h } = c;
  if (ok(w) && ok(l) && ok(wi) && ok(h) && Number(l) > 0 && Number(wi) > 0 && Number(h) > 0) {
    const m3 = (Number(l) / 1000) * (Number(wi) / 1000) * (Number(h) / 1000);
    return Math.round((Number(w) / m3) * 10) / 10;
  }
  return null;
}

/** Suggested PASS/FAIL from the structured measurements (tester can override). */
export function suggestVerdict(c: any): "PASS" | "FAIL" | null {
  const fails: boolean[] = [];
  if (ok(c.compressiveStrengthMpa)) fails.push(Number(c.compressiveStrengthMpa) >= STRENGTH_STANDARD_MPA ? true : false);
  if (ok(c.cracksCount)) fails.push(Number(c.cracksCount) === 0);
  if (c.surfaceQuality) fails.push(String(c.surfaceQuality).toUpperCase() !== "POOR");
  if (ok(c.defectsCount)) fails.push(Number(c.defectsCount) === 0);
  if (fails.length === 0) return null;
  return fails.every(Boolean) ? "PASS" : "FAIL";
}

export function computeBlockQc(
  checksIn: any[],
  productionIn: any[],
  f: QcFilters = {}
) {
  const checks = filterQcChecks(checksIn, f).sort(
    (a, b) => +new Date(a.testedAt || a.createdAt || 0) - +new Date(b.testedAt || b.createdAt || 0)
  );
  // Production batches respect the same filters where the fields exist.
  const production = (productionIn || []).filter((p) => {
    if (f.batchId && f.batchId !== "ALL" && p.batchId !== f.batchId) return false;
    if (f.blockType && f.blockType !== "ALL" && p.blockType !== f.blockType) return false;
    if (f.dateFilter && f.dateFilter !== "ALL" && p.recordedDate !== f.dateFilter) return false;
    return true;
  });

  // ── KPIs ──────────────────────────────────────────────────────────────
  const checksTotal = checks.length;
  const passCount = checks.filter((c) => c.passFail === "PASS").length;
  const failCount = checks.filter((c) => c.passFail === "FAIL").length;
  const passRatePct = checksTotal ? Math.round((passCount / checksTotal) * 1000) / 10 : 0;

  const strengthVals = checks.filter((c) => ok(c.compressiveStrengthMpa)).map((c) => Number(c.compressiveStrengthMpa));
  const avgStrengthMpa = strengthVals.length
    ? Math.round((strengthVals.reduce((s, v) => s + v, 0) / strengthVals.length) * 100) / 100
    : 0;
  const minStrengthMpa = strengthVals.length ? Math.min(...strengthVals) : 0;

  const weightVals = checks.filter((c) => ok(c.weightKg)).map((c) => Number(c.weightKg));
  const avgWeightKg = weightVals.length
    ? Math.round((weightVals.reduce((s, v) => s + v, 0) / weightVals.length) * 100) / 100
    : 0;
  const weightVariationPct =
    weightVals.length >= 2 && avgWeightKg > 0
      ? Math.round(((Math.max(...weightVals) - Math.min(...weightVals)) / avgWeightKg) * 1000) / 10
      : 0;

  const densityVals = checks.map((c) => deriveDensityKgm3(c)).filter((v): v is number => Number.isFinite(v as number));
  const avgDensityKgm3 = densityVals.length
    ? Math.round((densityVals.reduce((s, v) => s + Number(v), 0) / densityVals.length) * 10) / 10
    : 0;

  const defectsTotal = checks.reduce((s, c) => s + (Number(c.defectsCount) || 0), 0);
  const cracksTotal = checks.reduce((s, c) => s + (Number(c.cracksCount) || 0), 0);
  const rejectedBlocks = checks.reduce((s, c) => s + (Number(c.rejectedBlocks) || 0), 0);

  const moldedInScope = production.reduce((s, p) => s + (Number(p.blocksMolded) || 0), 0);
  // Defect rate: failing checks share + blocks rejected share vs molded.
  const checkFailRatePct = checksTotal ? Math.round((failCount / checksTotal) * 1000) / 10 : 0;
  const rejectedRatePct = moldedInScope > 0 ? Math.round((rejectedBlocks / moldedInScope) * 1000) / 10 : 0;

  // ── Batch linkage: Production → Curing → QC → (Inventory/Sales UI) ────
  const byBatch: Record<string, { batch: any; checks: any[] }> = {};
  for (const p of production) byBatch[p.batchId] = { batch: p, checks: [] };
  for (const c of checks) {
    if (!c.batchId) continue;
    if (!byBatch[c.batchId]) byBatch[c.batchId] = { batch: null, checks: [] };
    byBatch[c.batchId].checks.push(c);
  }
  const batches = Object.entries(byBatch)
    .map(([batchId, { batch, checks: bc }]) => {
      const failed = bc.filter((c) => c.passFail === "FAIL").length;
      const passed = bc.filter((c) => c.passFail === "PASS").length;
      const finished = bc.filter((c) => c.stage === "FINISHED_BLOCK");
      const cured = bc.some((c) => c.stage === "CURING" && c.passFail === "PASS");
      const avgStr = (() => {
        const v = bc.filter((c) => ok(c.compressiveStrengthMpa)).map((c) => Number(c.compressiveStrengthMpa));
        return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;
      })();
      const status = failed > 0 ? "FAILED" : finished.some((c) => c.passFail === "PASS") ? "PASSED" : bc.length > 0 ? "IN_QC" : "NO_QC";
      return {
        batchId,
        blockType: batch?.blockType || bc.find((c) => c.blockType)?.blockType || null,
        recordedDate: batch?.recordedDate || null,
        molded: batch?.blocksMolded ?? null,
        broken: batch?.blocksBroken ?? null,
        checks: bc.length,
        passed,
        failed,
        cured,
        avgStrengthMpa: avgStr,
        rejected: bc.reduce((s, c) => s + (Number(c.rejectedBlocks) || 0), 0),
        status, // PASSED | FAILED | IN_QC | NO_QC
      };
    })
    .sort((a, b) => String(b.recordedDate || "").localeCompare(String(a.recordedDate || "")));

  const passedBatches = batches.filter((b) => b.status === "PASSED").length;
  const failedBatches = batches.filter((b) => b.status === "FAILED").length;
  const batchesAwaitingQc = batches.filter((b) => b.status === "NO_QC" || b.status === "IN_QC").length;

  // ── Charts ────────────────────────────────────────────────────────────
  // Pass/Fail stacked per stage.
  const passFailByStage = QC_STAGES.map((stage) => {
    const sc = checks.filter((c) => c.stage === stage);
    return {
      stage: QC_STAGE_LABELS[stage],
      pass: sc.filter((c) => c.passFail === "PASS").length,
      fail: sc.filter((c) => c.passFail === "FAIL").length,
      checks: sc.length,
    };
  });

  // Daily pass rate (quality trend).
  const byDay: Record<string, { pass: number; fail: number }> = {};
  for (const c of checks) {
    const d = day(c.testedAt);
    if (!d) continue;
    byDay[d] ||= { pass: 0, fail: 0 };
    byDay[d][c.passFail === "PASS" ? "pass" : "fail"]++;
  }
  const qualityTrendDaily = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      passRate: v.pass + v.fail ? Math.round((v.pass / (v.pass + v.fail)) * 1000) / 10 : 0,
      checks: v.pass + v.fail,
    }));

  // Strength trend vs the GS 1193 standard line.
  const strByDay: Record<string, number[]> = {};
  for (const c of checks) {
    if (!ok(c.compressiveStrengthMpa)) continue;
    const v = Number(c.compressiveStrengthMpa);
    const d = day(c.testedAt);
    if (!Number.isFinite(v) || !d) continue;
    (strByDay[d] ||= []).push(v);
  }
  const strengthDaily = Object.entries(strByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date,
      avgMpa: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100,
      minMpa: Math.min(...vals),
      standardMpa: STRENGTH_STANDARD_MPA,
    }));

  // Weight trend (avg / min / max) + type target hint.
  const wByDay: Record<string, number[]> = {};
  for (const c of checks) {
    if (!ok(c.weightKg)) continue;
    const v = Number(c.weightKg);
    const d = day(c.testedAt);
    if (!Number.isFinite(v) || !d) continue;
    (wByDay[d] ||= []).push(v);
  }
  const weightDaily = Object.entries(wByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date,
      avgKg: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100,
      minKg: Math.min(...vals),
      maxKg: Math.max(...vals),
    }));

  // Defect breakdown — FAILED checks grouped by test name (Pareto).
  const defByTest: Record<string, number> = {};
  for (const c of checks) {
    if (c.passFail !== "FAIL") continue;
    const key = c.testName || "Unnamed check";
    defByTest[key] = (defByTest[key] || 0) + 1;
  }
  const defectBreakdown = Object.entries(defByTest)
    .map(([test, fails]) => ({ test, fails }))
    .sort((a, b) => b.fails - a.fails)
    .slice(0, 8);

  // ── Alerts ────────────────────────────────────────────────────────────
  const alerts: { level: "critical" | "warning"; msg: string }[] = [];
  for (const c of [...checks].reverse().slice(0, 30)) {
    if (c.passFail === "FAIL") {
      alerts.push({
        level: "critical",
        msg: `FAIL — ${c.testName} on ${c.batchId || "raw materials"} (${QC_STAGE_LABELS[c.stage] || c.stage}, ${day(c.testedAt)})${c.testerName ? ` by ${c.testerName}` : ""}`,
      });
    }
  }
  for (const b of batches) {
    if (b.status === "NO_QC" && b.recordedDate && b.recordedDate < new Date().toISOString().slice(0, 10)) {
      alerts.push({ level: "warning", msg: `Batch ${b.batchId} has no QC checks yet — test before release to sales` });
    }
    if (b.status === "FAILED") {
      alerts.push({ level: "critical", msg: `Batch ${b.batchId} FAILED QC — hold from sales & delivery` });
    }
    if (ok(b.avgStrengthMpa) && (b.avgStrengthMpa as number) < STRENGTH_STANDARD_MPA) {
      alerts.push({ level: "critical", msg: `Batch ${b.batchId} average strength ${b.avgStrengthMpa} MPa is below the ${STRENGTH_STANDARD_MPA} MPa standard` });
    }
  }
  if (weightVariationPct > 10 && weightVals.length >= 2) {
    alerts.push({ level: "warning", msg: `Block weight variation is ${weightVariationPct}% — check mix ratios and mould wear` });
  }
  if (rejectedBlocks > 0) {
    alerts.push({ level: "warning", msg: `${rejectedBlocks} blocks rejected at QC — segregate from finished stock` });
  }

  return {
    kpis: {
      checksTotal,
      passCount,
      failCount,
      passRatePct,
      passedBatches,
      failedBatches,
      batchesAwaitingQc,
      avgStrengthMpa,
      minStrengthMpa,
      avgWeightKg,
      weightVariationPct,
      avgDensityKgm3,
      defectsTotal,
      cracksTotal,
      rejectedBlocks,
      checkFailRatePct,
      rejectedRatePct,
    },
    batches,
    passFailByStage,
    qualityTrendDaily,
    strengthDaily,
    weightDaily,
    defectBreakdown,
    alerts,
  };
}
