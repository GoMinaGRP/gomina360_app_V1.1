"use client";

import React, { useMemo, useState } from "react";
import {
  Fish, Wheat, TrendingUp, HeartPulse, Target, Scale, Waves,
  RotateCcw, X, Save,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, ComposedChart,
} from "recharts";
import {
  computeFishPerformance,
  type FishPerfFilters,
} from "@/lib/fishPerformance";

interface Props {
  businessId: number;
  ponds: any[];
  batches: any[];
  feedLogs: any[];
  harvests: any[];
  weightLogs: any[];
  currentUserName?: string;
  currentUserRole?: string;
  onRefresh?: () => void;
}

const TT = { backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: 11 };

function Empty({ tid, children }: { tid: string; children: React.ReactNode }) {
  return (
    <p data-testid={tid} className="text-xs text-slate-500 text-center py-10">
      {children}
    </p>
  );
}

function ChartCard({
  title, icon: Icon, tid, children,
}: { title: string; icon: any; tid: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl overflow-hidden min-w-0" data-testid={tid}>
      <div className="px-4 py-2.5 border-b border-slate-700/60 flex items-center gap-2">
        <Icon className="w-4 h-4 text-cyan-400" />
        <h4 className="text-xs font-bold text-white">{title}</h4>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

const speciesLabel = (s: string) => (s || "").replace(/_/g, " ");

/**
 * Production & Growth Analytics for the Fish Farm: daily sampled fish weight
 * vs species standard, average weight by age, feed consumption, FCR,
 * survival/mortality per batch, harvest production and estimated biomass —
 * scoped by Pond / Batch / Species / Branch + a date-range filter, with a
 * built-in Record Daily Fish Weight dialog (batch, pond, species and age are
 * auto-linked from the selected batch).
 */
export default function FishGrowthAnalytics({
  businessId, ponds, batches, feedLogs, harvests, weightLogs = [],
  currentUserName, onRefresh,
}: Props) {
  const [batch, setBatch] = useState("ALL");
  const [pond, setPond] = useState<number | null>(null);
  const [species, setSpecies] = useState("ALL");
  const [branch, setBranch] = useState("ALL");
  const [dateFilter, setDateFilter] = useState("ALL");

  const filters: FishPerfFilters = useMemo(
    () => ({ dateFilter, batchNumber: batch, pondId: pond, species, branchCode: branch }),
    [dateFilter, batch, pond, species, branch],
  );

  const perf = useMemo(
    () => computeFishPerformance({ batches, feedLogs, harvests, weightLogs }, filters),
    [batches, feedLogs, harvests, weightLogs, filters],
  );

  const batchOptions = useMemo(
    () => [...new Set(batches.map((b) => b.batchNumber).filter(Boolean))].sort(),
    [batches],
  );
  const speciesOptions = useMemo(
    () => [...new Set(batches.map((b) => b.species).filter(Boolean))].sort(),
    [batches],
  );
  const branchOptions = useMemo(
    () => [...new Set(batches.map((b) => b.branchCode).filter(Boolean))].sort(),
    [batches],
  );

  const sel =
    "w-full sm:w-auto min-w-0 max-w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-cyan-500";
  const Lab = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-[10px] text-slate-500 mb-1">{children}</label>
  );
  const hasCustom = batch !== "ALL" || pond != null || species !== "ALL" || branch !== "ALL" || dateFilter !== "ALL";

  const Chip = ({ label, value, sub, tone = "cyan", tid }: any) => (
    <div className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2" data-testid={tid}>
      <div className="text-[9px] uppercase font-bold text-slate-500">{label}</div>
      <div className={`text-sm font-extrabold text-${tone}-400`}>{value}</div>
      {sub && <div className="text-[9px] text-slate-500">{sub}</div>}
    </div>
  );
  const k = perf.kpis;

  // ── Record Daily Fish Weight ────────────────────────────────────────────
  const [weighOpen, setWeighOpen] = useState(false);
  const [weighPondId, setWeighPondId] = useState<number | "">("");
  const [weighBatchId, setWeighBatchId] = useState<number | "">("");
  const [weighSample, setWeighSample] = useState("30");
  const [weighAvgG, setWeighAvgG] = useState("");
  const [weighDate, setWeighDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [weighNotes, setWeighNotes] = useState("");
  const [weighBusy, setWeighBusy] = useState(false);
  const [weighMsg, setWeighMsg] = useState("");

  const growingBatches = batches.filter((b) => b.status === "GROWING" || b.status === "ACTIVE" || !b.status);
  const weighBatches = growingBatches.filter((b) => !weighPondId || b.pondId === Number(weighPondId));
  const weighBatch = batches.find((b) => b.id === weighBatchId) || null;
  const weighAgeDays = weighBatch?.hatchDate
    ? Math.max(0, Math.round((Date.parse(weighDate) - Date.parse(weighBatch.hatchDate)) / 86400000))
    : null;

  const openWeigh = () => {
    setWeighPondId("");
    setWeighBatchId(growingBatches[0]?.id ?? "");
    setWeighAvgG("");
    setWeighNotes("");
    setWeighMsg("");
    setWeighOpen(true);
  };

  const saveWeight = async () => {
    if (!weighBatchId || !(Number(weighAvgG) > 0) || weighBusy) return;
    setWeighBusy(true);
    setWeighMsg("");
    try {
      const res = await fetch("/api/aquaculture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "WEIGHT",
          data: {
            businessId,
            batchId: Number(weighBatchId),
            sampleSize: Math.max(1, Number(weighSample) || 1),
            avgWeightG: Number(weighAvgG),
            recordedDate: weighDate,
            notes: weighNotes || undefined,
            recordedByName: currentUserName,
          },
        }),
      });
      const d = await res.json();
      if (d.success) {
        setWeighMsg("Saved — charts updated with this weighing.");
        onRefresh?.();
        setWeighAvgG("");
        setTimeout(() => setWeighOpen(false), 650);
      } else {
        setWeighMsg(d.error || "Could not save the weighing.");
      }
    } catch {
      setWeighMsg("Network error — weighing not saved.");
    } finally {
      setWeighBusy(false);
    }
  };

  return (
    <div
      data-testid="fga-root"
      className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl"
    >
      <div className="px-5 py-4 border-b border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Waves className="w-5 h-5 text-cyan-400" />
          <div>
            <h3 className="text-base font-bold text-white">Fish Growth &amp; Production Analytics</h3>
            <p className="text-[10px] text-slate-400">
              Weight &amp; growth vs species standard, feed, FCR, survival, harvests and biomass — scoped by pond, batch, species and branch.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">
            {perf.growthTrend.length + perf.feedDaily.length + perf.survivalByBatch.length + perf.harvestDaily.length + perf.biomassDaily.length} series points
          </div>
          <button
            onClick={openWeigh}
            data-testid="fga-record-weight"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-xs font-bold text-white shadow"
          >
            <Scale className="w-3.5 h-3.5" /> Record Fish Weight
          </button>
        </div>
      </div>

      {/* Scope filters: Pond / Batch / Species / Branch / Date */}
      <div className="px-4 pt-4 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
        <div>
          <Lab>Pond / Tank</Lab>
          <select data-testid="fga-filter-pond" value={pond ?? "ALL"} onChange={(e) => setPond(e.target.value === "ALL" ? null : Number(e.target.value))} className={sel}>
            <option value="ALL">All Ponds</option>
            {ponds.map((p) => <option key={p.id} value={p.id}>{p.name || p.pondId}</option>)}
          </select>
        </div>
        <div>
          <Lab>Batch</Lab>
          <select data-testid="fga-filter-batch" value={batch} onChange={(e) => setBatch(e.target.value)} className={sel}>
            <option value="ALL">All Batches</option>
            {batchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <Lab>Species</Lab>
          <select data-testid="fga-filter-species" value={species} onChange={(e) => setSpecies(e.target.value)} className={sel}>
            <option value="ALL">All Species</option>
            {speciesOptions.map((s) => <option key={s} value={s}>{speciesLabel(s)}</option>)}
          </select>
        </div>
        <div>
          <Lab>Branch</Lab>
          <select data-testid="fga-filter-branch" value={branch} onChange={(e) => setBranch(e.target.value)} className={sel}>
            <option value="ALL">All Branches</option>
            {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <Lab>Date Range</Lab>
          <select data-testid="fga-filter-date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className={sel}>
            <option value="ALL">All Time</option>
            <option value="TODAY">Today</option>
            <option value="LAST_7">Last 7 Days</option>
            <option value="LAST_30">Last 30 Days</option>
          </select>
        </div>
        {hasCustom && (
          <button
            onClick={() => { setBatch("ALL"); setPond(null); setSpecies("ALL"); setBranch("ALL"); setDateFilter("ALL"); }}
            data-testid="fga-filter-reset"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
        )}
      </div>

      {/* KPI chips */}
      <div className="px-4 pt-4 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2" data-testid="fga-kpis">
        <Chip tid="fga-kpi-gain" label="Avg Daily Gain" value={k.avgDailyGainG != null ? `${k.avgDailyGainG} g` : "—"} sub="from weight samples" tone="emerald" />
        <Chip tid="fga-kpi-feed" label="Total Feed" value={`${k.totalFeedKg} kg`} sub="in range" tone="amber" />
        <Chip tid="fga-kpi-calcfcr" label="Calc. FCR" value={k.calcFcr ?? "—"} sub="feed ÷ biomass gain" tone="cyan" />
        <Chip tid="fga-kpi-survival" label="Survival" value={k.survivalPct != null ? `${k.survivalPct.toFixed(1)}%` : "—"} sub={`${k.totalDeaths} deaths`} tone={k.survivalPct != null && k.survivalPct < 90 ? "rose" : "emerald"} />
        <Chip tid="fga-kpi-stocked" label="Fish Stocked" value={k.stocked.toLocaleString()} sub="in selected scope" tone="cyan" />
        <Chip tid="fga-kpi-avgwt" label="Avg Weight" value={k.avgWeightG != null ? `${k.avgWeightG.toFixed(1)} g` : "—"} sub="latest sample" tone="emerald" />
        <Chip tid="fga-kpi-harvest" label="Harvested" value={k.harvested.toLocaleString()} sub={`${k.harvestKg} kg`} tone="cyan" />
        <Chip tid="fga-kpi-biomass" label="Est. Biomass" value={k.biomassKg != null ? `${k.biomassKg.toLocaleString()} kg` : "—"} sub="fish × avg weight" tone="cyan" />
      </div>

      {/* Charts */}
      <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 1 — Daily growth vs species standard */}
        <ChartCard title="Daily Fish Weight & Growth Trend" icon={TrendingUp} tid="fga-chart-growth">
          {perf.growthTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={perf.growthTrend}>
                <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}g`} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="avgWeightG" name="Sampled weight (g)" stroke="#22d3ee" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="targetG" name="Species standard (g)" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-growth">No weight samples in this scope — use Record Fish Weight to start tracking growth.</Empty>}
        </ChartCard>

        {/* 2 — Average weight by batch age */}
        <ChartCard title="Average Weight by Age (weekly)" icon={Fish} tid="fga-chart-weight-age">
          {perf.weightByAge.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={perf.weightByAge}>
                <XAxis dataKey="age" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}g`} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="avgWeightG" name="Sampled (g)" fill="#22d3ee" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="targetG" name="Standard (g)" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 4" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-weight-age">No age-bucketed samples yet.</Empty>}
        </ChartCard>

        {/* 3 — Daily feed consumption */}
        <ChartCard title="Daily Feed Consumption (kg)" icon={Wheat} tid="fga-chart-feed">
          {perf.feedDaily.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={perf.feedDaily}>
                <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} />
                <Tooltip contentStyle={TT} />
                <Bar dataKey="kg" name="Feed (kg)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-feed">No feed consumption entries in this scope.</Empty>}
        </ChartCard>

        {/* 4 — Survival / mortality per batch */}
        <ChartCard title="Survival & Mortality by Batch" icon={HeartPulse} tid="fga-chart-survival">
          {perf.survivalByBatch.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={perf.survivalByBatch}>
                <XAxis dataKey="batch" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis yAxisId="l" stroke="#94a3b8" style={{ fontSize: 9 }} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                <YAxis yAxisId="r" orientation="right" stroke="#fda4af" style={{ fontSize: 9 }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar yAxisId="l" dataKey="survivalPct" name="Survival %" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Line yAxisId="r" type="monotone" dataKey="deaths" name="Deaths" stroke="#fb7185" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-survival">No stocked batches in this scope.</Empty>}
        </ChartCard>

        {/* 5 — Harvest production trend */}
        <ChartCard title="Harvest Production Trend" icon={Target} tid="fga-chart-harvest">
          {perf.harvestDaily.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={perf.harvestDaily}>
                <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="count" name="Fish harvested" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="weightKg" name="Total weight (kg)" stroke="#a855f7" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-harvest">No harvests recorded in this scope.</Empty>}
        </ChartCard>

        {/* 6 — Estimated standing biomass */}
        <ChartCard title="Estimated Standing Biomass (kg)" icon={Scale} tid="fga-chart-biomass">
          {perf.biomassDaily.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={perf.biomassDaily}>
                <XAxis dataKey="date" stroke="#94a3b8" style={{ fontSize: 9 }} />
                <YAxis stroke="#94a3b8" style={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}kg`} />
                <Tooltip contentStyle={TT} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="biomassKg" name="Biomass (kg)" stroke="#22d3ee" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty tid="fga-empty-biomass">No weight samples yet — biomass needs daily fish weighing.</Empty>}
        </ChartCard>
      </div>

      {/* ── Record Daily Fish Weight modal ───────────────────────────────── */}
      {weighOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm" data-testid="fgaw-modal">
          <div className="w-full max-w-md bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Scale className="w-4 h-4 text-cyan-400" /> Record Daily Fish Weight
              </h3>
              <button onClick={() => setWeighOpen(false)} data-testid="fgaw-close" className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <Lab>Pond / Tank (optional — narrows batches)</Lab>
                <select
                  value={weighPondId}
                  onChange={(e) => {
                    const v = e.target.value ? Number(e.target.value) : "";
                    setWeighPondId(v);
                    const inPond = growingBatches.filter((b) => !v || b.pondId === Number(v));
                    if (!inPond.some((b) => b.id === weighBatchId)) setWeighBatchId(inPond[0]?.id ?? "");
                  }}
                  className={sel + " w-full"}
                  data-testid="fgaw-pond"
                >
                  <option value="">All ponds / tanks</option>
                  {ponds.map((p) => <option key={p.id} value={p.id}>{p.name || p.pondId} ({p.type})</option>)}
                </select>
              </div>

              <div>
                <Lab>Batch</Lab>
                <select
                  value={weighBatchId}
                  onChange={(e) => setWeighBatchId(e.target.value ? Number(e.target.value) : "")}
                  className={sel + " w-full"}
                  data-testid="fgaw-batch"
                >
                  <option value="">Select batch…</option>
                  {weighBatches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.batchNumber} — {speciesLabel(b.species)}
                    </option>
                  ))}
                </select>
              </div>

              {weighBatch && (
                <div className="text-[10px] text-slate-400 bg-slate-900/70 border border-slate-700/60 rounded-lg px-3 py-2" data-testid="fgaw-info">
                  Linked automatically → Species <span className="text-cyan-300 font-bold">{speciesLabel(weighBatch.species)}</span>
                  {" · "}Pond <span className="text-cyan-300 font-bold">{ponds.find((p) => p.id === weighBatch.pondId)?.name || "—"}</span>
                  {" · "}Branch <span className="text-cyan-300 font-bold">{weighBatch.branchCode || "—"}</span>
                  {weighAgeDays != null && (
                    <>
                      {" · "}Age <span className="text-cyan-300 font-bold">{weighAgeDays} days (W{Math.floor(weighAgeDays / 7)})</span>
                    </>
                  )}
                  {" · "}Fish alive <span className="text-cyan-300 font-bold">{(weighBatch.currentCount || 0).toLocaleString()}</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Lab>Fish weighed (sample)</Lab>
                  <input type="number" min={1} value={weighSample} onChange={(e) => setWeighSample(e.target.value)} className={sel + " w-full"} data-testid="fgaw-sample" />
                </div>
                <div>
                  <Lab>Avg fish weight (g)</Lab>
                  <input type="number" min={0} step="0.1" value={weighAvgG} onChange={(e) => setWeighAvgG(e.target.value)} placeholder="e.g. 320" className={sel + " w-full"} data-testid="fgaw-avg" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Lab>Date</Lab>
                  <input type="date" value={weighDate} onChange={(e) => setWeighDate(e.target.value)} className={sel + " w-full"} data-testid="fgaw-date" />
                </div>
                <div>
                  <Lab>Notes (optional)</Lab>
                  <input value={weighNotes} onChange={(e) => setWeighNotes(e.target.value)} placeholder="e.g. dip-net sample" className={sel + " w-full"} data-testid="fgaw-notes" />
                </div>
              </div>

              {weighMsg && <p className={`text-[11px] font-semibold ${weighMsg.startsWith("Saved") ? "text-emerald-300" : "text-rose-300"}`} data-testid="fgaw-status">{weighMsg}</p>}

              <button
                onClick={saveWeight}
                disabled={weighBusy || !weighBatchId || !(Number(weighAvgG) > 0)}
                data-testid="fgaw-save"
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold text-white shadow"
              >
                <Save className="w-4 h-4" /> {weighBusy ? "Saving…" : "Save Weighing"}
              </button>

              <div className="pt-1">
                <p className="text-[10px] uppercase font-bold text-slate-500 mb-1.5">Recent weighings</p>
                <div className="space-y-1 max-h-28 overflow-y-auto" data-testid="fgaw-recent">
                  {weightLogs.length === 0 && <p className="text-[11px] text-slate-500">No weighings recorded yet.</p>}
                  {[...weightLogs].slice(0, 6).map((w) => (
                    <div key={w.id} className="flex items-center justify-between text-[11px] bg-slate-900/60 border border-slate-700/40 rounded-lg px-2.5 py-1.5">
                      <span className="text-slate-300">{w.recordedDate} · {w.batchNumber}</span>
                      <span className="font-bold text-cyan-300">{Number(w.avgWeightG).toLocaleString()} g <span className="text-slate-500 font-normal">×{w.sampleSize}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
