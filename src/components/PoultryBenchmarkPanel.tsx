"use client";

import React, { useMemo, useState } from "react";
import {
  Gauge, Target, TrendingUp, TrendingDown, Minus, Settings2, History,
  Calculator, Download, Info, Sparkles,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import {
  computeBenchmarks,
  type BenchmarkKpi,
  type BenchmarkResult,
} from "@/lib/poultryBenchmarking";

interface Props {
  businessId: number;
  flocks: any[];
  feedLogs: any[];
  healthRecords: any[];
  production: any[];
  weightLogs: any[];
  profiles: any[];
  currentCurrency: CurrencyCode;
  /** Flock selected for benchmarking (module-level state). */
  benchFlockId: number | null;
  onBenchFlockChange: (id: number | null) => void;
  onManage: () => void;
  /** Benchmark alerts lifted into the parent's alert panel. */
  onBenchmarks?: (res: BenchmarkResult | null) => void;
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

/** Chip comparing a value against a benchmark: direction-aware arrow +
 *  percentage, colored by how far behind/ahead the flock is. */
function VarChip({ kpi, against }: { kpi: BenchmarkKpi; against: "target" | "hist" | "best" }) {
  const ref = against === "target" ? kpi.target : against === "hist" ? kpi.histMedian : kpi.histBest;
  const drift = against === "target" ? kpi.driftPct : against === "hist" ? kpi.histDriftPct : null;
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
      data-testid={`pob-chip-${kpi.key.toLowerCase()}-${against}`}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold whitespace-nowrap ${tone}`}
      title={`${against === "target" ? "vs benchmark target" : against === "hist" ? "vs farm-history median" : "vs farm best"}: ${kpi.actual} vs ${ref} (${favorable ? "+" : ""}${drift.toFixed(1)}% ${favorable ? "ahead" : "behind"})`}
    >
      <Icon className="w-2.5 h-2.5" />
      {favorable ? "+" : ""}{drift.toFixed(1)}%
    </span>
  );
}

function fmtVal(kpi: BenchmarkKpi, v: number | null): string {
  if (v == null) return "—";
  const money = ["FEED_COST_PER_KG_GAIN", "COST_PER_BIRD", "COST_PER_EGG"].includes(kpi.key);
  if (money) return formatMoney(v, "GHS" as any);
  return `${v}${kpi.unit ? ` ${kpi.unit}` : ""}`;
}

/**
 * Flock Performance Benchmarking panel for the Poultry Dashboard:
 * age-matched actual vs benchmark-profile target vs comparable historical
 * flocks, with variance chips, an A–D scorecard, close-out projection and
 * a CSV export of the scorecard. Pure display — all math lives in
 * src/lib/poultryBenchmarking.ts.
 */
export default function PoultryBenchmarkPanel({
  businessId, flocks, feedLogs, healthRecords, production, weightLogs, profiles,
  currentCurrency, benchFlockId, onBenchFlockChange, onManage, onBenchmarks, canManage,
}: Props) {
  const [livePrice, setLivePrice] = useState<string>("");

  const orderedFlocks = useMemo(
    () => [...(flocks || [])].sort((a, b) =>
      Number(String(b.status || "ACTIVE") === "ACTIVE") - Number(String(a.status || "ACTIVE") === "ACTIVE") ||
      (b.id || 0) - (a.id || 0)),
    [flocks],
  );

  const flock = useMemo(
    () => orderedFlocks.find((f) => f.id === benchFlockId) || orderedFlocks[0] || null,
    [orderedFlocks, benchFlockId],
  );

  const bench = useMemo(() => {
    if (!flock) return null;
    return computeBenchmarks({
      flock, profiles, flocks, feedLogs, healthRecords, production, weightLogs,
      livePricePerKgGhs: Number(livePrice) > 0 ? Number(livePrice) : null,
    });
  }, [flock, profiles, flocks, feedLogs, healthRecords, production, weightLogs, livePrice]);

  // Lift the result so the parent can merge benchmark alerts into the
  // existing PoultryAnalyticsAlerts panel (single alert surface).
  React.useEffect(() => { onBenchmarks?.(bench); }, [bench, onBenchmarks]);

  // ── Empty states ──
  if (!orderedFlocks.length) return null;

  if (!bench?.hasAnyBenchmark) {
    return (
      <div data-testid="pob-setup" className="bg-slate-900/60 border border-slate-700/70 rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5 text-cyan-300" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-bold text-white">Benchmark this farm's performance</div>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              Compare every flock — age-matched — against targets you set (or breed-standard
              templates) and against your own past flocks. Weight, ADG, FCR, mortality, lay %,
              feed cost per kg gained and more, with variance alerts on the dashboard.
            </p>
            {canManage ? (
              <button
                onClick={onManage}
                data-testid="pob-setup-btn"
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
  const scored = bench.kpis.filter((x) => !x.informational);
  const withActual = scored.filter((x) => x.actual != null);
  const ppefKpi = bench.actuals.ppef;

  const exportCsv = () => {
    const flockName = bench.flock?.batchNumber || "flock";
    const rows = [
      ["Flock", flockName, bench.flock?.birdType || "", bench.profile?.name || "no profile"],
      ["Age (days)", k.ageDays],
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
      ["PPEF (efficiency index)", ppefKpi ?? ""],
      ["Total feed (kg)", k.totalFeedKg],
      ["Feed cost", k.feedCostGhs ?? ""],
      ["Health cost", k.healthCostGhs],
      ["Cost per bird to date", k.costPerBirdGhs ?? ""],
      ...(bench.projection
        ? [
            [],
            ["Close-out projection"],
            ["Market age (days)", bench.projection.marketAgeDays],
            ["Projected weight (kg)", bench.projection.projectedWeightKg ?? ""],
            ["Projected FCR", bench.projection.projectedFcr ?? ""],
            ["Projected cost / bird", bench.projection.projectedCostPerBirdGhs ?? ""],
            ["Revenue / bird", bench.projection.revenuePerBirdGhs ?? ""],
            ["Margin / bird", bench.projection.marginPerBirdGhs ?? ""],
            ["Margin total", bench.projection.marginTotalGhs ?? ""],
          ]
        : []),
      [],
      ["Historical comparison", ...bench.history.map((h) => `${h.flock.batchNumber}${h.note ? ` (${h.note})` : ""}`)],
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `benchmark-${flockName}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      data-testid="pob-root"
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
            data-testid="pob-flock-select"
            value={flock?.id ?? ""}
            onChange={(e) => onBenchFlockChange(Number(e.target.value) || null)}
            className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-cyan-500"
          >
            {orderedFlocks.map((f) => (
              <option key={f.id} value={f.id}>
                {f.batchNumber}{String(f.status) !== "ACTIVE" ? ` (${String(f.status).toLowerCase()})` : ""}
              </option>
            ))}
          </select>
          {canManage && (
            <button
              onClick={onManage}
              data-testid="pob-manage-btn"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white"
            >
              <Settings2 className="w-3.5 h-3.5" /> Manage
            </button>
          )}
          <button
            onClick={exportCsv}
            data-testid="pob-export-btn"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold text-white"
            title="Download the flock scorecard as CSV"
          >
            <Download className="w-3.5 h-3.5" /> Scorecard CSV
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Scorecard + headline numbers */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="pob-headline">
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3 flex items-center gap-3">
            <div
              data-testid="pob-grade"
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
            <div className="text-[9px] uppercase font-bold text-slate-500">Cost / bird to date</div>
            <div className="text-sm font-extrabold text-rose-300">{k.costPerBirdGhs != null ? formatMoney(k.costPerBirdGhs, currentCurrency, true) : "—"}</div>
            <div className="text-[9px] text-slate-500">chick + feed + health ÷ live birds</div>
          </div>
          <div className="bg-slate-800/80 border border-slate-700/70 rounded-xl p-3">
            <div className="text-[9px] uppercase font-bold text-slate-500">
              {String(bench.flock?.birdType) === "LAYERS" ? "Feed+health / egg" : "PPEF index"}
            </div>
            <div className="text-sm font-extrabold text-cyan-300">
              {String(bench.flock?.birdType) === "LAYERS"
                ? k.costPerEggGhs != null ? formatMoney(k.costPerEggGhs, currentCurrency) : "—"
                : ppefKpi ?? "—"}
            </div>
            <div className="text-[9px] text-slate-500">
              {String(bench.flock?.birdType) === "LAYERS" ? `${k.eggsTotal.toLocaleString()} eggs logged` : "livability × weight ÷ FCR ÷ age"}
            </div>
          </div>
        </div>

        {/* KPI variance table */}
        <div className="overflow-x-auto" data-testid="pob-kpis">
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
                <tr key={x.key} data-testid={`pob-row-${x.key.toLowerCase()}`}>
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
                  No measurable actuals for this flock yet — log weight samples, feed and production records.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Historical comparison meta */}
        {bench.history.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400" data-testid="pob-history-meta">
            <History className="w-3.5 h-3.5 text-slate-500" />
            <span className="font-bold text-slate-300">Compared with {bench.history.length} past flock(s):</span>
            {bench.history.map((h) => (
              <span key={h.flock.id} className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-slate-300">
                {h.flock.batchNumber}{h.note ? ` · ${h.note}` : ""}
              </span>
            ))}
            <span className="text-slate-500">— bands show p25–p75 of these flocks at the same age.</span>
          </div>
        )}

        {/* Close-out projection */}
        {bench.projection && (
          <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/60 border border-slate-700/70 rounded-xl p-4" data-testid="pob-projection">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Calculator className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-white">Close-out projection</span>
                <span className="text-[10px] text-slate-400">
                  if sold at day {bench.projection.marketAgeDays} ({bench.projection.daysRemaining}d from now)
                </span>
              </div>
              <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
                Live price / kg
                <input
                  data-testid="pob-live-price"
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
                { l: "Cost / bird", v: bench.projection.projectedCostPerBirdGhs != null ? formatMoney(bench.projection.projectedCostPerBirdGhs, currentCurrency, true) : "—", sub: "projected, all-in" },
                { l: "Revenue / bird", v: bench.projection.revenuePerBirdGhs != null ? formatMoney(bench.projection.revenuePerBirdGhs, currentCurrency, true) : "—" },
                {
                  l: "Margin / bird",
                  v: bench.projection.marginPerBirdGhs != null ? formatMoney(bench.projection.marginPerBirdGhs, currentCurrency, true) : "—",
                  sub: bench.projection.marginTotalGhs != null ? `≈ ${formatMoney(bench.projection.marginTotalGhs, currentCurrency, true)} flock` : undefined,
                  tone: bench.projection.marginPerBirdGhs != null && bench.projection.marginPerBirdGhs < 0 ? "rose" : "emerald",
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500" data-testid="pob-economics">
          <Sparkles className="w-3.5 h-3.5 text-slate-600" />
          <span>Economics from flock-linked records only — chick cost {formatMoney(bench.flock?.costPerBirdGhs || 0, currentCurrency, true)}/bird, feed {k.totalFeedKg.toLocaleString()} kg, health {formatMoney(k.healthCostGhs, currentCurrency, true)}.</span>
          {k.fcr != null && <span className="text-slate-400">Calc. FCR {k.fcr} · feed {formatMoney(k.feedCostPerKg ?? 0, currentCurrency, true)}/kg.</span>}
        </div>
      </div>
    </div>
  );
}
