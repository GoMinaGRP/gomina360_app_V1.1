"use client";

import React, { useEffect, useState } from "react";
import {
  Sliders,
  TrendingUp,
  TrendingDown,
  Plus,
  Play,
  ArrowUpRight,
  ArrowDownRight,
  DollarSign,
  Zap,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";

interface ScenarioPlannerViewProps {
  scenarios: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  onRefreshScenarios: () => void;
}

export default function ScenarioPlannerView({
  scenarios,
  businesses,
  currentCurrency,
  onRefreshScenarios,
}: ScenarioPlannerViewProps) {
  const [showModal, setShowModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New simulation form state
  const [name, setName] = useState("2026 Q3 Solar Import Bulk Expansion");
  const [description, setDescription] = useState(
    "Simulates importing 40 additional 10kVA Felicity Solar sets for Accra & Kumasi clients."
  );
  const [targetBusinessId, setTargetBusinessId] = useState("6"); // TECH-01
  const [variableChanged, setVariableChanged] = useState("Solar Demand");
  const [percentChange, setPercentChange] = useState("25");

  // Interactive slider state for real-time sandbox
  const [liveVariable, setLiveVariable] = useState("Feed Price");
  const [livePercent, setLivePercent] = useState<number>(15);

  const handleCreateScenario = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          targetBusinessId: targetBusinessId ? Number(targetBusinessId) : null,
          variableChanged,
          percentChange: Number(percentChange),
          createdBy: "Kwame Mina",
        }),
      });
      if (res.ok) {
        onRefreshScenarios();
        setShowModal(false);
      }
    } catch (err) {
      console.error("Error creating scenario:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getBusinessName = (id: number | null) => {
    if (!id) return "All Businesses (Enterprise)";
    const b = businesses.find((x) => x.id === id);
    return b ? b.name : "Operating Unit";
  };

  const [liveScope, setLiveScope] = useState<string>("ALL");

  // Live sandbox numbers — COMPUTED server-side from the real baseline
  // (seeded 2026-Q1 close + every live transaction since + the asset
  // register), debounced while the slider moves. The previous, hardcoded
  // GH₵850×%/GH₵1450×%/GH₵3200×% math was disconnected dummy data.
  const [liveImpact, setLiveImpact] = useState<{ revenueImpact: number; profitImpact: number; roiDelta: number; basis: string }>({
    revenueImpact: 0, profitImpact: 0, roiDelta: 0, basis: "",
  });
  const [baselineInfo, setBaselineInfo] = useState<any>(null);
  const [liveLoading, setLiveLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLiveLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          variable: liveVariable,
          pct: String(livePercent),
          ...(liveScope !== "ALL" ? { businessId: liveScope } : {}),
        });
        const res = await fetch(`/api/scenarios/simulate?${params.toString()}`);
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && body?.success) {
          setLiveImpact({
            revenueImpact: body.impacts.revenueImpact,
            profitImpact: body.impacts.profitImpact,
            roiDelta: body.impacts.roiDelta,
            basis: body.impacts.basis,
          });
          setBaselineInfo(body.baseline);
        }
      } catch { /* keep last good values */ }
      if (!cancelled) setLiveLoading(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [liveVariable, livePercent, liveScope]);

  const liveProf = liveImpact.profitImpact;
  const liveRev = liveImpact.revenueImpact;
  const liveRoi = liveImpact.roiDelta;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100" data-testid="scen-root">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-700 flex items-center justify-center text-white font-black shadow-lg shrink-0">
            <Sliders className="w-7 h-7" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-teal-500/20 text-teal-300 text-xs font-bold border border-teal-500/30">
              FORECASTING & SCENARIO PLANNING
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              What-If Simulation Sandbox
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Simulate market shocks, price hikes, branch expansions, and capital investments before deploying capital.
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            data-testid="scen-new"
          >
            <Plus className="w-4 h-4" />
            <span>New What-If Simulation</span>
          </button>
        </div>
      </div>

      {/* Real-Time Interactive Simulation Sandbox Card */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6 shadow-2xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-700 pb-3">
          <div>
            <h3 className="text-lg font-bold text-white">
              Live What-If Sandbox Slider
            </h3>
            <p className="text-xs text-slate-400">
              Drag the slider to test instant projected impacts on net profit, ROI %, and enterprise cash flow.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={liveScope}
              onChange={(e) => setLiveScope(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200"
              data-testid="scen-scope"
              title="Scope of the simulation baseline"
            >
              <option value="ALL">All Businesses (Enterprise)</option>
              {businesses.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.name}
                </option>
              ))}
            </select>
            <select
              value={liveVariable}
              onChange={(e) => setLiveVariable(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200"
              data-testid="scen-variable"
            >
              <option value="Feed Price">Poultry Feed Price Inflation</option>
              <option value="Cement Price">Cement / Raw Material Cost</option>
              <option value="Solar Demand">Solar Inverter Market Demand</option>
              <option value="Branch Expansion">New Branch Production Output</option>
            </select>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span>
              Simulating adjustment on{" "}
              <strong className="text-emerald-400">{liveVariable}</strong>
            </span>
            <span className="text-lg font-extrabold text-amber-300">
              {livePercent > 0 ? `+${livePercent}%` : `${livePercent}%`}
            </span>
          </div>

          <input
            type="range"
            min="-30"
            max="60"
            step="5"
            value={livePercent}
            onChange={(e) => setLivePercent(Number(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            data-testid="scen-slider"
          />

          <div className="flex justify-between text-[11px] text-slate-400">
            <span>-30% Decrease</span>
            <span>0% Baseline</span>
            <span>+30% Increase</span>
            <span>+60% Extreme Surge</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          <div className="bg-slate-900/90 border border-slate-700/80 p-4 rounded-xl">
            <div className="text-xs text-slate-400 font-semibold">
              Projected Revenue Impact
            </div>
            <div
              className={`text-xl font-extrabold mt-1 ${
                liveRev >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
              data-testid="scen-live-revenue"
              data-value={liveRev}
            >
              {liveRev >= 0 ? "+" : ""}
              {formatMoney(liveRev, currentCurrency)}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              Estimated quarterly revenue shift
            </div>
          </div>

          <div className="bg-slate-900/90 border border-slate-700/80 p-4 rounded-xl">
            <div className="text-xs text-slate-400 font-semibold">
              Projected Net Profit Delta
            </div>
            <div
              className={`text-xl font-extrabold mt-1 ${
                liveProf >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
              data-testid="scen-live-profit"
              data-value={liveProf}
            >
              {liveProf >= 0 ? "+" : ""}
              {formatMoney(liveProf, currentCurrency)}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              Net operating profit adjustment
            </div>
          </div>

          <div className="bg-slate-900/90 border border-slate-700/80 p-4 rounded-xl">
            <div className="text-xs text-slate-400 font-semibold">
              Projected ROI Change
            </div>
            <div
              className={`text-xl font-extrabold mt-1 ${
                liveRoi >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
              data-testid="scen-live-roi"
              data-value={liveRoi}
            >
              {liveRoi >= 0 ? `+${liveRoi}%` : `${liveRoi}%`}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              Return on investment shift
            </div>
          </div>
        </div>

        {/* Baseline transparency — proves the projection is computed from
            the unit's real books, not dummy constants. */}
        <div
          className="rounded-xl border border-teal-500/30 bg-teal-500/5 px-4 py-3 text-[11px] text-teal-200/90 flex flex-wrap items-center gap-x-4 gap-y-1"
          data-testid="scen-baseline"
        >
          {baselineInfo ? (
            <>
              <span className="font-bold text-teal-300">
                Computed from {baselineInfo.scope === "business" ? "this unit's" : "the enterprise"} real baseline
                {liveLoading ? " · recalculating…" : ""}:
              </span>
              <span>Revenue {formatMoney(baselineInfo.revenueQ || 0, currentCurrency)}/qtr</span>
              <span>Expenses {formatMoney(baselineInfo.expensesQ || 0, currentCurrency)}/qtr</span>
              <span>Margin {((baselineInfo.margin || 0) * 100).toFixed(1)}%</span>
              <span>Assets {formatMoney(baselineInfo.assetsValueQ || 0, currentCurrency)}</span>
              <span>
                + {baselineInfo.liveCount || 0} live entries since Q1 close ({formatMoney(baselineInfo.liveIncomeQ || 0, currentCurrency)} in / {formatMoney(baselineInfo.liveExpenseQ || 0, currentCurrency)} out)
              </span>
              {liveImpact.basis && (
                <span className="w-full text-teal-300/80" data-testid="scen-basis-note">Model: {liveImpact.basis}</span>
              )}
            </>
          ) : (
            <span className="text-teal-300/80">Loading the real financial baseline…</span>
          )}
        </div>
      </div>

      {/* Pre-Computed Executive Scenarios Grid */}
      <div className="space-y-4">
        <h3 className="text-lg font-bold text-white">
          Saved Enterprise What-If Simulations
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {scenarios.map((sc) => {
            const isPositive = sc.expectedProfitImpactGhs >= 0;

            return (
              <div
                key={sc.id}
                className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl flex flex-col justify-between space-y-4"
                data-testid={`scen-card-${sc.id}`}
                data-profit-impact={sc.expectedProfitImpactGhs}
                data-revenue-impact={sc.expectedRevenueImpactGhs}
              >
                <div>
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{getBusinessName(sc.targetBusinessId)}</span>
                    <span
                      className={`px-2 py-0.5 rounded font-bold ${
                        sc.percentChange >= 0
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      {sc.variableChanged} ({sc.percentChange > 0 ? `+${sc.percentChange}%` : `${sc.percentChange}%`})
                    </span>
                  </div>

                  <h4 className="text-base font-bold text-white mt-2">
                    {sc.name}
                  </h4>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                    {sc.description}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-700/60 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Revenue Impact:</span>
                    <span className="font-bold text-slate-200">
                      {sc.expectedRevenueImpactGhs >= 0 ? "+" : ""}
                      {formatMoney(
                        sc.expectedRevenueImpactGhs,
                        currentCurrency
                      )}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Net Profit Impact:</span>
                    <span
                      className={`font-extrabold ${
                        isPositive ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {isPositive ? "+" : ""}
                      {formatMoney(
                        sc.expectedProfitImpactGhs,
                        currentCurrency
                      )}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">ROI Delta:</span>
                    <span
                      className={`font-bold ${
                        sc.expectedRoiDelta >= 0
                          ? "text-emerald-400"
                          : "text-rose-400"
                      }`}
                    >
                      {sc.expectedRoiDelta >= 0
                        ? `+${sc.expectedRoiDelta}%`
                        : `${sc.expectedRoiDelta}%`}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal for adding scenario */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">
              Create What-If Simulation
            </h3>

            <form onSubmit={handleCreateScenario} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Simulation Title
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Target Business Unit
                </label>
                <select
                  value={targetBusinessId}
                  onChange={(e) => setTargetBusinessId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                >
                  <option value="">All Businesses (Enterprise-Wide)</option>
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.branchLocation})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Variable Changed
                  </label>
                  <select
                    value={variableChanged}
                    onChange={(e) => setVariableChanged(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  >
                    <option value="Feed Price">Feed Price</option>
                    <option value="Cement Price">Cement Price</option>
                    <option value="Solar Demand">Solar Demand</option>
                    <option value="New Branch Production">New Branch Production</option>
                    <option value="Price Increase">Price Increase</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    % Adjustment
                  </label>
                  <input
                    type="number"
                    value={percentChange}
                    onChange={(e) => setPercentChange(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Simulation Notes / Rationale
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isSubmitting ? "Running..." : "Run Simulation"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
