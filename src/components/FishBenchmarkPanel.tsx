"use client";

import React, { useMemo, useState } from "react";
import {
  Gauge, Target, TrendingUp, TrendingDown, History, Settings2,
  Calculator, Download, Info, Sparkles, Waves,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import {
  computeFishBenchmarks,
  FISH_BENCHMARK_METRIC_META,
  type FishBenchmarkKpi,
  type FishBenchmarkMetricKey,
  type FishBenchmarkResult,
} from "@/lib/fishBenchmarking";

interface Props {
  businessId: number;
  batches: any[];
  feedLogs: any[];
  harvests: any[];
  weightLogs: any[];
  ponds: any[];
  profiles: any[];
  currentCurrency: CurrencyCode;
  /** Batch selected for benchmarking (module-level state). */
  benchBatchId: number | null;
  onBenchBatchChange: (id: number | null) => void;
  onManage: () => void;
  /** Benchmark alerts lifted into the parent's alert panel. */
  onBenchmarks?: (res: FishBenchmarkResult | null) => void;
  canManage: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  ON_TRACK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  WATCH: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OFF_TRACK: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  NO_DATA: "bg-slate-700/40 text-slate-400 border-slate-600/50",
};

const GRADE_STYLE: Record<string, string> = {
  A: "bg-emerald-500/20 text-emerald-300 border-emerald-400/50",
  B: "bg-lime-500/15 text-lime-300 border-lime-400/40",
  C: "bg-amber-500/15 text-amber-300 border-amber-400/40",
  D: "bg-rose-500/15 text-rose-300 border-rose-400/40",
};

const TT = { backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: 11 };

/** Chip comparing a value against a benchmark: direction-aware arrow +
 *  percentage, colored by how far behind/ahead the batch is. */
function VarChip({ kpi, against }: { kpi: FishBenchmarkKpi; against: "target" | "hist" }) {
  const ref = against === "target" ? kpi.target : kpi.histMedian;
  const drift = against === "target" ? kpi.driftPct : kpi.histDriftPct;
  if (ref == null || drift == null) return null;
  const favorable = drift >= 0;
  const Icon = against === "target" ? (favorable ? TrendingUp : TrendingDown) : History;
  const tone =
    against !== "target"
      ? "bg-slate-700/40 text-slate-300 border-slate-600/50"
      : favorable
        ? STATUS_STYLE.ON_TRACK
        : kpi.status === "OFF_TRACK"
          ? STATUS_STYLE.OFF_TRACK
          : STATUS_STYLE.WATCH;
  return (
    <span
      data-testid={`fib-chip-${kpi.key.toLowerCase()}-${against}`}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold whitespace-nowrap ${tone}`}
      title={`${against === "target" ? "vs benchmark target" : "vs farm-history median"}: ${kpi.actual} vs ${ref} (${favorable ? "+" : ""}${drift.toFixed(1)}% ${favorable ? "ahead" : "behind"})`}
    >
      <Icon className="w-2.5 h-2.5" />
      {favorable ? "+" : ""}{drift.toFixed(1)}%
    </span>
  );
}

function fmtVal(kpi: FishBenchmarkKpi, v: number | null): string {
  if (v == null) return "—";
  const money = ["FEED_COST_PER_KG_GAIN", "COST_PER_KG_FISH"].includes(kpi.key);
  if (money) return formatMoney(v, "GHS" as any);
  return `${v}${kpi.unit ? ` ${kpi.unit}` : ""}`;
}

const TREND_METRICS: { key: FishBenchmarkMetricKey; label: string; unit: string }[] = [
  { key: "AVG_WEIGHT_G", label: "Weight (g)", unit: "g" },
  { key: "SGR_PCT", label: "SGR (%/day)", unit: "%/d" },
  { key: "FCR", label: "FCR", unit: "" },
  { key: "SURVIVAL_PCT", label: "Survival (%)", unit: "%" },
  { key: "FEED_RATE_PCT_BIOMASS", label: "Feeding rate (% biomass)", unit: "%" },
];

/**
 * Fish Batch Performance Benchmarking panel for the Aquaculture Dashboard:
 * age-matched actual vs benchmark-profile target vs comparable historical
 * batches, with variance chips, an A–D scorecard, weekly trend charts with
 * the farm-history band, a harvest close-out projection and a CSV export of
 * the scorecard. Pure display — all math lives in src/lib/fishBenchmarking.ts.
 */
export default function FishBenchmarkPanel({
  businessId, batches, feedLogs, harvests, weightLogs, ponds, profiles,
  currentCurrency, benchBatchId, onBenchBatchChange, onManage, onBenchmarks, canManage,
}: Props) {
  const [livePrice, setLivePrice] = useState<string>("");
  const [trendMetric, setTrendMetric] = useState<FishBenchmarkMetricKey>("AVG_WEIGHT_G");

  const orderedBatches = useMemo(
    () => [...(batches || [])].sort((a, b) =>
      Number(String(b.status || "GROWING") === "GROWING") - Number(String(a.status || "GROWING") === "GROWING") ||
      (b.id || 0) - (a.id || 0)),
    [batches],
  );

  const batch = useMemo(
    () => orderedBatches.find((b) => b.id === benchBatchId) || orderedBatches[0] || null,
    [orderedBatches, benchBatchId],
  );

  const bench = useMemo(() => {
    if (!batch) return null;
    return computeFishBenchmarks({
      batch, profiles, batches, feedLogs, harvests, weightLogs, ponds,
      livePricePerKgGhs: Number(livePrice) > 0 ? Number(livePrice) : null,
    });
  }, [batch, profiles, batches, feedLogs, harvests, weightLogs, ponds, livePrice]);

  // Lift the result so the parent can merge benchmark alerts into the
  // existing AI Smart Alerts grid (single alert surface).
  React.useEffect(() => { onBenchmarks?.(bench); }, [bench, onBenchmarks]);

  // ── Empty states ──
  if (!orderedBatches.length) return null;

  if (!bench?.hasAnyBenchmark) {
    return (
      <div data-testid="fib-setup" className="bg-slate-900/60 border border-slate-700/70 rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5 text-cyan-300" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Benchmark this farm's fish performance</div>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              Compare every batch — age-matched — against targets you set (or species-standard
              templates) and against your own past batches. Growth (SGR), FCR, feeding rate,
              survival, stocking density, feed &amp; production cost per kg fish, with variance
              alerts on the dashboard and a harvest close-out projection.
            </p>
            {canManage ? (
              <button
                onClick={onManage}
                data-testid="fib-setup-btn"
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold"
              >
                <Settings2 className="w-3.5 h-3.5" /> Set up Benchmarks
              </button>
            ) : (
              <p className="text-[10px] text-slate-500 mt-2">Ask the owner or a manager to configure benchmark profiles.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const k = bench.actuals;
  const scored = bench.kpis;
  const withActual = scored.filter((x) => x.actual != null);
  const trendRows = bench.series[trendMetric] || [];
  const trendMeta = TREND_METRICS.find((m) => m.key === trendMetric)!;
  const hasHistBand = trendRows.some((r) => r.histP25 != null || r.histP75 != null);

  const exportCsv = () => {
    const batchName = bench.batch?.batchNumber || "batch";
    const rows = [
      ["Batch", batchName, bench.batch?.species || "", bench.profile?.name || "no profile"],
      ["Age (days)", k.ageDays, `(${k.ageWeeks} weeks)`],
      ["Scorecard", bench.scorecard.grade ?? "—", `${bench.scorecard.compliancePct ?? 0}% compliance`, `${bench.scorecard.evaluated} metrics`],
      [],
      ["Metric", "Actual", "Target", "vs target %", "Farm median", "vs median %", "Status"],
      ...bench.kpis.map((x) => [
        x.label,
        x.actual ?? "",
        x.target ?? "",
        x.driftPct ?? "",
        x.histMedian ?? "",
        x.histDriftPct ?? "",
        x.status,
      ]),
      [],
      ["Total feed (kg)", k.totalFeedKg],
      ["Feed cost", k.feedCostGhs ?? ""],
      ["Fingerling cost", k.fingerlingCostGhs],
      ["Feed cost / kg gain", k.feedCostPerKgGain ?? ""],
      ["Production cost / kg fish", k.costPerKgFishGhs ?? ""],
      ["Survival %", k.survivalPct ?? ""],
      ["Harvested", `${k.harvestedCount} fish`, `${k.harvestedKg} kg`, k.harvestRevenueGhs ? `${k.harvestRevenueGhs} GHS` : ""],
      ...(bench.projection
        ? [
            [],
            ["Harvest close-out projection"],
            ["Harvest age (days)", bench.projection.harvestAgeDays],
            ["Days remaining", bench.projection.daysRemaining],
            ["Projected weight (kg)", bench.projection.projectedWeightKg ?? ""],
            ["Target weight (kg)", bench.projection.targetWeightKg ?? ""],
            ["Projected FCR", bench.projection.projectedFcr ?? ""],
            ["Feed to harvest (kg)", bench.projection.feedKgRemaining ?? ""],
            ["Feed cost to harvest", bench.projection.feedCostRemainingGhs ?? ""],
            ["Projected cost / kg fish", bench.projection.projectedCostPerKgGhs ?? ""],
            ["Revenue / fish", bench.projection.revenuePerFishGhs ?? ""],
            ["Margin / fish", bench.projection.marginPerFishGhs ?? ""],
            ["Margin total", bench.projection.marginTotalGhs ?? ""],
          ]
        : []),
      [],
      ["Historical comparison", ...bench.history.map((h) => `${h.batch.batchNumber}${h.note ? ` (${h.note})` : ""}`)],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `fish-benchmark-${batchName}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      data-testid="fib-root"
      className="bg-slate-900/60 border border-slate-700/70 rounded-2xl overflow-hidden shadow-xl"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-700/70 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-cyan-400" />
          <div>
            <h3 className="text-base font-bold text-white">Benchmark Performance</h3>
            <p className="text-[10px] text-slate-400">
              {bench.profile
                ? `Profile: ${bench.profile.name}${bench.profileResolvedBy === "auto" ? " (auto-matched)" : ""}`
                : "No profile — farm-history comparison only"}
              {" · "}age-matched at day {k.ageDays} ({k.ageWeeks}w)
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="fib-batch-select"
            value={batch?.id ?? ""}
            onChange={(e) => onBenchBatchChange(Number(e.target.value) || null)}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-cyan-500"
          >
            {orderedBatches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batchNumber}{String(b.status) !== "GROWING" ? ` (${String(b.status).toLowerCase()})` : ""}
              </option>
            ))}
          </select>
          {canManage && (
            <button
              onClick={onManage}
              data-testid="fib-manage-btn"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white"
            >
              <Settings2 className="w-3.5 h-3.5" /> Manage
            </button>
          )}
          <button
            onClick={exportCsv}
            data-testid="fib-export-btn"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white"
            title="Download the batch scorecard as CSV"
          >
            <Download className="w-3.5 h-3.5" /> Scorecard CSV
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Scorecard + headline numbers */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="fib-headline">
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3 flex items-center gap-3">
            <div
              data-testid="fib-grade"
              className={`w-12 h-12 rounded-xl border-2 flex items-center justify-center text-xl font-black ${GRADE_STYLE[bench.scorecard.grade || "D"]}`}
            >
              {bench.scorecard.grade || "—"}
            </div>
            <div>
              <div className="text-[9px] uppercase font-bold text-slate-500">Scorecard</div>
              <div className="text-sm font-extrabold text-white">{bench.scorecard.compliancePct ?? "—"}% on target</div>
              <div className="text-[9px] text-slate-500">{bench.scorecard.evaluated} metric(s) scored</div>
            </div>
          </div>
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
            <div className="text-[9px] uppercase font-bold text-slate-500">Total feed</div>
            <div className="text-sm font-extrabold text-amber-300">{k.totalFeedKg.toLocaleString()} kg</div>
            <div className="text-[9px] text-slate-500">
              {k.feedCostGhs != null ? `${formatMoney(k.feedCostGhs, currentCurrency, true)} · ${k.feedCostPerKg ?? "—"}/kg` : "cost basis unknown"}
            </div>
          </div>
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
            <div className="text-[9px] uppercase font-bold text-slate-500">Cost / kg fish to date</div>
            <div className="text-sm font-extrabold text-rose-300">{k.costPerKgFishGhs != null ? formatMoney(k.costPerKgFishGhs, currentCurrency, true) : "—"}</div>
            <div className="text-[9px] text-slate-500">fingerling + feed ÷ kg produced</div>
          </div>
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
            <div className="text-[9px] uppercase font-bold text-slate-500">Standing biomass</div>
            <div className="text-sm font-extrabold text-cyan-300">{k.biomassKg != null ? `${k.biomassKg.toLocaleString()} kg` : "—"}</div>
            <div className="text-[9px] text-slate-500">
              {k.stockingDensityKgM3 != null ? `${k.stockingDensityKgM3} kg/m³ in pond` : "density needs pond capacity"}
            </div>
          </div>
        </div>

        {/* KPI variance table */}
        <div className="overflow-x-auto" data-testid="fib-kpis">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 uppercase font-semibold text-[9px]">
              <tr className="border-b border-slate-700/70">
                <th className="py-2 pr-3">Metric</th>
                <th className="py-2 pr-3 text-right">Actual</th>
                <th className="py-2 pr-3 text-right">Target</th>
                <th className="py-2 pr-3">vs target</th>
                <th className="py-2 pr-3 text-right">Farm median</th>
                <th className="py-2">vs history</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {scored.map((x) => (
                <tr key={x.key} data-testid={`fib-row-${x.key.toLowerCase()}`}>
                  <td className="py-2 pr-3 font-semibold text-slate-200">{x.label}</td>
                  <td className="py-2 pr-3 text-right font-bold text-white">{fmtVal(x, x.actual)}</td>
                  <td className="py-2 pr-3 text-right text-slate-400">{x.target != null ? fmtVal(x, x.target) : "—"}</td>
                  <td className="py-2 pr-3">
                    {x.target != null && x.actual != null
                      ? <VarChip kpi={x} against="target" />
                      : <span className="text-slate-600 text-[10px]">no curve</span>}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-400">{x.histMedian != null ? fmtVal(x, x.histMedian) : "—"}</td>
                  <td className="py-2">
                    {x.histMedian != null && x.actual != null
                      ? <VarChip kpi={x} against="hist" />
                      : <span className="text-slate-600 text-[10px]">no history</span>}
                  </td>
                </tr>
              ))}
              {withActual.length === 0 && (
                <tr><td colSpan={6} className="py-4 text-center text-slate-500 text-[11px]">
                  No measurable actuals for this batch yet — log weight samples, feed and mortality records.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Weekly trend vs benchmark with farm-history band */}
        {trendRows.length > 0 && (
          <div className="bg-slate-900/50 border border-slate-700/70 rounded-xl p-3" data-testid="fib-trends">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <Waves className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold text-white">Weekly trend vs benchmark</span>
                <span className="text-[10px] text-slate-500">by batch age (weeks)</span>
              </div>
              <select
                data-testid="fib-trend-metric"
                value={trendMetric}
                onChange={(e) => setTrendMetric(e.target.value as FishBenchmarkMetricKey)}
                className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-[11px] focus:outline-none focus:border-cyan-500"
              >
                {TREND_METRICS.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={trendRows}>
                <XAxis dataKey="age" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} tickFormatter={(v: number) => (trendMeta.unit ? `${v}${trendMeta.unit === "g" ? "g" : trendMeta.unit === "%/d" ? "%" : trendMeta.unit === "%" ? "%" : ""}` : `${v}`)} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {hasHistBand && <Line type="monotone" dataKey="histP25" name="Farm history p25" stroke="#64748b" strokeWidth={1} strokeDasharray="1 3" dot={false} connectNulls />}
                {hasHistBand && <Line type="monotone" dataKey="histP75" name="Farm history p75" stroke="#64748b" strokeWidth={1} strokeDasharray="1 3" dot={false} connectNulls />}
                {hasHistBand && <Line type="monotone" dataKey="histMedian" name="Farm median" stroke="#94a3b8" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />}
                <Line type="monotone" dataKey="target" name="Benchmark target" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                <Line type="monotone" dataKey="actual" name="This batch" stroke="#22d3ee" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Historical comparison meta */}
        {bench.history.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400" data-testid="fib-history-meta">
            <History className="w-3.5 h-3.5 text-slate-500" />
            <span className="font-bold text-slate-300">Compared with {bench.history.length} past batch(es):</span>
            {bench.history.map((h) => (
              <span key={h.batch.id} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-slate-300">
                {h.batch.batchNumber}{h.note ? ` · ${h.note}` : ""}
              </span>
            ))}
            <span className="text-slate-500">— bands show p25–p75 of these batches at the same age.</span>
          </div>
        )}

        {/* Harvest close-out projection */}
        {bench.projection && (
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/60 border border-slate-700/70 rounded-xl p-4" data-testid="fib-projection">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Calculator className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-white">Harvest close-out projection</span>
                <span className="text-[10px] text-slate-400">
                  if harvested at day {bench.projection.harvestAgeDays} ({bench.projection.daysRemaining}d from now)
                </span>
              </div>
              <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
                Live price / kg
                <input
                  data-testid="fib-live-price"
                  type="number" min="0" step="0.5"
                  value={livePrice}
                  onChange={(e) => setLivePrice(e.target.value)}
                  placeholder={String(bench.projection!.livePricePerKgGhs)}
                  className="w-16 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-white text-[10px] text-right"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              {[
                { l: "Weight now", v: bench.projection.currentWeightKg != null ? `${bench.projection.currentWeightKg} kg` : "—" },
                { l: "Projected weight", v: bench.projection.projectedWeightKg != null ? `${bench.projection.projectedWeightKg} kg` : "—", sub: bench.projection.targetWeightKg ? `target ${bench.projection.targetWeightKg} kg` : undefined },
                { l: "Projected FCR", v: bench.projection.projectedFcr != null ? `${bench.projection.projectedFcr}` : "—" },
                { l: "Cost / kg fish", v: bench.projection.projectedCostPerKgGhs != null ? formatMoney(bench.projection.projectedCostPerKgGhs, currentCurrency, true) : "—", sub: "projected, all-in" },
                { l: "Revenue / fish", v: bench.projection.revenuePerFishGhs != null ? formatMoney(bench.projection.revenuePerFishGhs, currentCurrency, true) : "—" },
                {
                  l: "Margin / fish",
                  v: bench.projection.marginPerFishGhs != null ? formatMoney(bench.projection.marginPerFishGhs, currentCurrency, true) : "—",
                  sub: bench.projection.marginTotalGhs != null ? `≈ ${formatMoney(bench.projection.marginTotalGhs, currentCurrency, true)} batch` : undefined,
                  tone: bench.projection.marginPerFishGhs != null && bench.projection.marginPerFishGhs < 0 ? "rose" : "emerald",
                },
              ].map((c, i) => (
                <div key={i} className="bg-slate-900/70 border border-slate-700/60 rounded-lg px-2.5 py-2">
                  <div className="text-[9px] uppercase font-bold text-slate-500">{c.l}</div>
                  <div className={`text-xs font-extrabold ${c.tone === "rose" ? "text-rose-300" : c.tone === "emerald" ? "text-emerald-300" : "text-white"}`}>{c.v}</div>
                  {c.sub && <div className="text-[9px] text-slate-500">{c.sub}</div>}
                </div>
              ))}
            </div>
            <details className="mt-2">
              <summary className="text-[10px] text-slate-500 cursor-pointer flex items-center gap-1 hover:text-slate-400">
                <Info className="w-3 h-3" /> assumptions
              </summary>
              <ul className="mt-1 space-y-0.5">
                {bench.projection.assumptions.map((a, i) => (
                  <li key={i} className="text-[10px] text-slate-500">• {a}</li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {/* Economics footer strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500" data-testid="fib-economics">
          <Sparkles className="w-3.5 h-3.5 text-slate-600" />
          <span>
            Economics from batch-linked records only — fingerlings {formatMoney(k.fingerlingCostGhs, currentCurrency, true)} ({(bench.batch?.initialCount || 0).toLocaleString()} × GH₵{bench.batch?.costPerFingerlingGhs || 0}), feed {k.totalFeedKg.toLocaleString()} kg.
          </span>
          {k.fcr != null && <span className="text-slate-400">Calc. FCR {k.fcr} · survival {k.survivalPct ?? "—"}% · harvested {k.harvestedKg} kg.</span>}
        </div>
      </div>
    </div>
  );
}
