"use client";

/**
 * Poultry Feed Mill — in-house feed formulation & production.
 *
 * Sub-module of the Poultry Farm module (tab "Feed Mill"), architected so the
 * same API + analytics libs can later serve a standalone Feed-Mill business
 * line. Everything here flows through /api/poultry/feed-mill:
 *
 *   FORMULATION (recipe + % BOM) → INTAKE (raw-material purchase: stockIn +
 *   one POULTRY_FEED_RAW_MATERIAL expense) → BATCH (stockOut ingredients,
 *   stockIn finished feed, one POULTRY_FEED_MILL_OPS txn, status QC_HOLD)
 *   → QC checks → RELEASE (hard gate: finished-feed PASS, or OWNER /
 *   canManageRecords override w/ note) | REJECT (owner-only, reverses stock)
 *   → CONSUMPTION (stockOut released batches into poultry_feed_logs OWN_MILL
 *   rows — never a money booking: single-booking principle).
 *
 * Quantities are KG-canonical; bags/tonnes are input conveniences converted
 * through feedUnits. Analytics come from computeFeedMillAnalytics (shared
 * pure lib, verified by dev-tooling/verify-feed-mill.mjs).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Factory, Wheat, Package, FlaskConical, Truck, Scale, ShieldCheck,
  AlertTriangle, CheckCircle2, XCircle, X, Plus, Loader2, TrendingUp,
  TrendingDown, ClipboardList, Lock, Unlock, Ban, Edit3, RefreshCw,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { FEED_UNITS, feedToKg, kgToFeedUnit, fmtKg } from "@/lib/feedUnits";
import { computeFeedMillAnalytics } from "@/lib/feedMillAnalytics";
import { Field, Stat, Alerts, statusPill, ModalShell, UnitPicker, SubmitBar, ErrBox, inputCls } from "@/lib/feedMill/parts";
import { FormulaModal, IntakeModal, BatchModal, QcModal } from "@/lib/feedMill/modals";
import { useFeedMill } from "@/lib/feedMill/useFeedMill";
import ConfirmActionModal from "./ConfirmActionModal";

interface Props {
  currentUser: any;
  businessInfo: any;
  currentCurrency: CurrencyCode;
  /** bubble a global data refresh after writes (stock + finance changed). */
  onChanged: () => void;
}

type View = "OVERVIEW" | "FORMULAS" | "BATCHES" | "STOCK" | "FEEDOUT";
type Modal = null | "FORMULA" | "EDIT_FORMULA" | "INTAKE" | "BATCH" | "QC" | "CONSUME";

const FEED_TYPES = ["STARTER", "GROWER", "FINISHER", "LAYER_MASH", "BROILER_PRESTARTER", "BREEDER", "CONCENTRATE", "CUSTOM"];
const QC_STAGES = ["RAW_MATERIAL", "GRINDING", "MIXING", "FINISHED_FEED", "STORAGE"];

/* ══════════════════════════════ main component ═════════════════════════ */

export default function PoultryFeedMill({ currentUser, businessInfo, currentCurrency, onChanged }: Props) {
  const bizId = businessInfo?.id;
  const branchCode = businessInfo?.code;
  const branchName = businessInfo?.name;
  const role = currentUser?.role;
  const canOverride = role === "OWNER" || currentUser?.canManageRecords === true;

  /* P1.2 — shared feed-mill engine (data flow, writes, stock math,
   * release/reject governance). Species-specific insights + the flock
   * consumption modal stay local to this module. */
  const {
    view, setView, modal, setModal, editForm, setEditForm, qcBatch, setQcBatch,
    consumeBatch, setConsumeBatch, loading, busy, err, setErr, confirm, setConfirm,
    mill, toast, refresh, post, finishOk, remainingOf, bomOf, stockLeft, askRelease, askReject,
  } = useFeedMill({
    apiBase: "/api/poultry/feed-mill",
    bizId, currentCurrency, canOverride, onChanged,
    feedNoun: "flock",
    extraMillKeys: ["flocks"],
  });

  const { formulations, formulationItems, batches, qcChecks, rawMaterials, finishedFeeds, consumption, flocks } = mill;
  const production: any[] = mill.production || [];

  const { kpis, alerts } = useMemo(() => computeFeedMillAnalytics({
    formulations, formulationItems, batches, batchInputs: mill.batchInputs, qcChecks,
    inventory: [...(mill.rawMaterials || []), ...(mill.finishedFeeds || [])],
    feedLogs: mill.feedLogs || [], currentCurrency,
  }), [mill, currentCurrency]);

  /* Feed-conversion insight (last 30 days): own-mill kg fed vs flock output.
   * Layers: feed per 100 eggs & FCR-egg (kg feed per kg egg mass @58 g).
   * Broilers: feed per kg live weight harvested. Derived, never re-books. */
  const flockInsights = useMemo(() => {
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return (flocks || []).map((fl: any) => {
      const fed = (consumption || []).filter((c: any) => Number(c.flockId) === fl.id && (c.recordedDate || "") >= since)
        .reduce((s: number, c: any) => s + (c.quantityKg || 0), 0);
      const prod = production.filter((p: any) => (p.flockId ? Number(p.flockId) === fl.id : p.batchNumber === fl.batchNumber) && (p.recordedDate || "") >= since);
      const eggs = prod.reduce((s: number, p: any) => s + (p.eggsCollected || 0), 0);
      const weightOut = prod.reduce((s: number, p: any) => s + (p.totalWeightKg || 0), 0);
      const fcrEgg = eggs > 0 && fed > 0 ? fed / (eggs * 0.058) : null;
      const feedPer100 = eggs > 0 && fed > 0 ? (fed / eggs) * 100 : null;
      const broiler = fl.birdType && String(fl.birdType).includes("BROILER");
      return { flock: fl, fed, eggs, weightOut, fcrEgg, feedPer100, broiler };
    }).filter((x: any) => x.fed > 0 || x.eggs > 0 || x.weightOut > 0);
  }, [flocks, consumption, production]);

  /* ══════════════════ render ══════════════════ */
  if (loading) {
    return <div className="flex items-center justify-center min-h-[40vh]"><Loader2 className="w-7 h-7 animate-spin text-emerald-400" /></div>;
  }

  const VIEWS: { key: View; label: string; icon: any }[] = [
    { key: "OVERVIEW", label: "Mill Overview", icon: Factory },
    { key: "FORMULAS", label: "Formulations", icon: FlaskConical },
    { key: "BATCHES", label: "Batches & QC", icon: Scale },
    { key: "STOCK", label: "Raw Stock & Intake", icon: Truck },
    { key: "FEEDOUT", label: "Feed Out", icon: Wheat },
  ];

  return (
    <div className="space-y-4" data-testid="feed-mill-root">
      {/* sub-tab bar */}
      <div className="flex items-center gap-1 flex-wrap bg-slate-900/60 border border-slate-700/70 rounded-xl p-1.5" data-testid="fm-subtabs">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v.key)} data-testid={`fm-subtab-${v.key}`}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-bold transition ${view === v.key ? "bg-emerald-500/20 text-emerald-300" : "text-slate-400 hover:text-white hover:bg-slate-700/60"}`}>
            <v.icon className="w-3.5 h-3.5" /> {v.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={refresh} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60" title="Refresh mill data"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {toast && <div className="bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 rounded-xl p-3 text-xs font-semibold" data-testid="fm-toast">✓ {toast}</div>}
      {err && <div className="bg-rose-500/10 border border-rose-500/40 text-rose-300 rounded-xl p-3 text-xs" data-testid="fm-error">{err}<button className="float-right" onClick={() => setErr("")}><X className="w-3.5 h-3.5" /></button></div>}

      {/* ════════════ OVERVIEW ════════════ */}
      {view === "OVERVIEW" && (<>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat testid="fm-kpi-finished" label="Finished Feed on Hand" value={fmtKg(kpis.finishedFeedKg, { bag: "BAG50" })}
            sub={kpis.daysOfFeed != null ? `≈ ${kpis.daysOfFeed} days at current burn` : "log consumption to estimate cover"}
            color={kpis.daysOfFeed != null && kpis.daysOfFeed < 3 ? "amber" : "emerald"} icon={Package} />
          <Stat testid="fm-kpi-rawcover" label="Raw Material Cover"
            value={kpis.rawMaterialCoverageDays != null ? `${kpis.rawMaterialCoverageDays} days` : "—"}
            sub={kpis.rawMaterialCoverageDays != null ? "most-binding BOM ingredient" : "create a formulation to measure"} color="amber" icon={Truck} />
          <Stat testid="fm-kpi-lastbatch" label="Last Batch Cost"
            value={kpis.lastBatch ? `${formatMoney(kpis.lastBatch.costPerKgGhs, currentCurrency)}/kg` : "—"}
            sub={kpis.lastBatch ? `${kpis.lastBatch.batchNumber} · yield ${kpis.lastBatch.yieldPct ?? "—"}% · ${kpis.lastBatch.status}` : "no batches yet"} color="cyan" icon={Scale} />
          <Stat testid="fm-kpi-saving" label="Saving vs Commercial"
            value={kpis.savingPerKgGhs != null ? `${formatMoney(kpis.savingPerKgGhs, currentCurrency)}/kg` : "—"}
            sub={kpis.savingPerKgGhs != null
              ? `${formatMoney(kpis.savingAllTimeGhs, currentCurrency, true)} all-time · ref ${formatMoney(kpis.commercialBaselineGhs, currentCurrency)}/kg (${kpis.baselineSource === "FORMULATION_REF" ? "formula ref" : "purchase avg"})`
              : "set a commercial reference price on a formulation"}
            color={kpis.savingPerKgGhs != null && kpis.savingPerKgGhs < 0 ? "rose" : "emerald"} icon={kpis.savingPerKgGhs != null && kpis.savingPerKgGhs < 0 ? TrendingDown : TrendingUp} />
        </div>

        <Alerts alerts={alerts} />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Batches Milled" value={kpis.batchCount} sub={`${kpis.releasedCount} released`} color="emerald" icon={Factory} />
          <Stat label="On QC Hold" value={kpis.holdCount} sub="awaiting finished-feed test" color={kpis.holdCount > 0 ? "amber" : "emerald"} icon={Lock} />
          <Stat label="Avg Yield" value={kpis.avgYieldPct != null ? `${kpis.avgYieldPct}%` : "—"} sub="output ÷ input (milling loss)" color="purple" icon={TrendingUp} />
          <Stat label="Rejected" value={kpis.rejectedCount} sub="discarded batches" color={kpis.rejectedCount > 0 ? "rose" : "emerald"} icon={Ban} />
        </div>

        {alerts.length === 0 && kpis.batchCount > 0 && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center" data-testid="fm-all-clear">
            <ShieldCheck className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
            <div className="text-sm font-bold text-emerald-300">Mill is healthy</div>
            <p className="text-[11px] text-slate-400 mt-1">Raw cover, finished feed, QC and costs are all within control.</p>
          </div>
        )}

        {kpis.batchCount === 0 && (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-8 text-center" data-testid="fm-empty">
            <Factory className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white">Set up your feed mill</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              1) Build a <b>formulation</b> (ingredient % mix) → 2) <b>intake</b> raw materials →
              3) <b>run a batch</b> → 4) pass <b>finished-feed QC</b> and release → 5) <b>feed your flocks</b>.
              Milling cost per kg is compared against commercial feed automatically.
            </p>
            <button onClick={() => { setEditForm(null); setModal("FORMULA"); }} data-testid="fm-btn-first-formula"
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
              <Plus className="w-4 h-4" /> Create first formulation
            </button>
          </div>
        )}
      </>)}

      {/* ════════════ FORMULAS ════════════ */}
      {view === "FORMULAS" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><FlaskConical className="w-4 h-4 text-purple-400" /> Feed Formulations</h3>
            <button onClick={() => { setEditForm(null); setModal("FORMULA"); }} data-testid="fm-btn-new-formula"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
              <Plus className="w-3.5 h-3.5" /> New Formulation
            </button>
          </div>
          {formulations.length === 0 && <div className="text-center text-slate-500 text-xs py-10">No formulations yet — recipes drive batches, raw-cover alerts and savings math.</div>}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {formulations.map((f: any) => {
              const bom = bomOf(f.id);
              const shareTotal = bom.reduce((s: number, i: any) => s + (i.sharePct || 0), 0);
              return (
                <div key={f.id} className={`bg-slate-800/90 border rounded-2xl p-4 ${f.active === false ? "border-slate-700/60 opacity-60" : "border-slate-700/80"}`} data-testid={`fm-formula-${f.formulationNo}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-[10px] text-purple-300">{f.formulationNo} · v{f.version || 1}</div>
                      <div className="text-sm font-bold text-white">{f.name}</div>
                      <div className="text-[10px] text-slate-400">{f.feedType?.replace(/_/g, " ")} · {f.birdType}{f.ageFromWks != null ? ` · wk ${f.ageFromWks}–${f.ageToWks ?? "?"}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {f.active === false && <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-700 text-slate-300">INACTIVE</span>}
                      <button onClick={() => { setEditForm(f); setModal("EDIT_FORMULA"); }} data-testid={`fm-edit-formula-${f.id}`}
                        className="p-1.5 rounded-lg bg-slate-700/70 text-slate-300 hover:text-white" title="Edit formulation"><Edit3 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {bom.map((i: any) => (
                      <span key={i.id} className="px-2 py-0.5 rounded-full bg-slate-900/80 text-[9px] text-slate-300">
                        {i.ingredientName} <b className="text-emerald-300">{i.sharePct}%</b>
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                    <div><div className="text-[9px] text-slate-500">Batch size</div><div className="text-xs font-bold text-white">{f.batchSizeKg} kg</div></div>
                    <div><div className="text-[9px] text-slate-500">CP target</div><div className="text-xs font-bold text-white">{f.cpPctTarget ?? "—"}%</div></div>
                    <div><div className="text-[9px] text-slate-500">Commercial ref</div><div className="text-xs font-bold text-amber-300">{f.commercialRefPriceGhs ? `${formatMoney(f.commercialRefPriceGhs, currentCurrency)}/kg` : "purchase avg"}</div></div>
                    <div><div className="text-[9px] text-slate-500">BOM shares</div><div className={`text-xs font-bold ${Math.abs(shareTotal - 100) < 0.01 ? "text-emerald-300" : "text-rose-300"}`}>{shareTotal}%</div></div>
                  </div>
                  {f.notes && <p className="text-[10px] text-slate-500 italic mt-2">{f.notes}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ════════════ BATCHES & QC ════════════ */}
      {view === "BATCHES" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><Scale className="w-4 h-4 text-cyan-400" /> Production Batches</h3>
            <button onClick={() => setModal("BATCH")} data-testid="fm-btn-run-batch"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
              <Plus className="w-3.5 h-3.5" /> Run Batch
            </button>
          </div>
          <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">Batch / Date</th><th className="px-4 py-3">Formulation</th>
                  <th className="px-4 py-3 text-right">In → Out</th><th className="px-4 py-3 text-right">Yield</th>
                  <th className="px-4 py-3 text-right">Cost/kg</th><th className="px-4 py-3 text-center">QC</th>
                  <th className="px-4 py-3 text-center">Status</th><th className="px-4 py-3 text-right">Remaining</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {batches.map((b: any) => {
                  const checks = qcChecks.filter((q: any) => q.batchId === b.id);
                  const fail = checks.some((q: any) => q.passFail === "FAIL");
                  const passF = checks.some((q: any) => q.passFail === "PASS" && q.stage === "FINISHED_FEED");
                  return (
                    <tr key={b.id} className="hover:bg-slate-700/40" data-testid={`fm-batch-${b.batchNumber}`}>
                      <td className="px-4 py-3">
                        <div className="font-mono font-bold text-emerald-400">{b.batchNumber}</div>
                        <div className="text-[10px] text-slate-500">{b.productionDate}{b.operatorName ? ` · ${b.operatorName}` : ""}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300 max-w-[140px]"><span className="font-semibold">{b.formulationName}</span><div className="text-[10px] text-slate-500">{b.feedType?.replace(/_/g, " ")}</div></td>
                      <td className="px-4 py-3 text-right text-slate-300 whitespace-nowrap">{b.actualInputKg?.toLocaleString()} → <b className="text-white">{b.actualOutputKg?.toLocaleString()} kg</b></td>
                      <td className="px-4 py-3 text-right">
                        <span className={b.yieldPct != null && b.yieldPct < 90 ? "text-amber-400 font-bold" : "text-slate-300"}>{b.yieldPct ?? "—"}%</span>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-400 whitespace-nowrap">{formatMoney(b.costPerKgGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-center">
                        {checks.length === 0 ? <span className="text-slate-500 text-[10px]">no tests</span>
                          : fail ? <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-rose-500/20 text-rose-300">{checks.filter((q: any) => q.passFail === "FAIL").length} FAIL</span>
                          : passF ? <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300">FINISHED ✓</span>
                          : <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300">{checks.length} partial</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${statusPill(b.status)}`}>{b.status}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{b.status !== "REJECTED" ? fmtKg(remainingOf(b), { bag: "BAG50" }) : "—"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          {b.status !== "REJECTED" && (
                            <button onClick={() => { setQcBatch(b); setModal("QC"); }} data-testid={`fm-qc-${b.id}`} title="Log QC check"
                              className="p-1.5 rounded-lg bg-purple-500/15 text-purple-300 hover:bg-purple-500/25"><FlaskConical className="w-3.5 h-3.5" /></button>
                          )}
                          {b.status === "QC_HOLD" && (
                            <button onClick={() => askRelease(b)} data-testid={`fm-release-${b.id}`} title="Release for feeding"
                              className="p-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"><Unlock className="w-3.5 h-3.5" /></button>
                          )}
                          {b.status === "QC_HOLD" && canOverride && (
                            <button onClick={() => askReject(b)} data-testid={`fm-reject-${b.id}`} title="Reject batch (owner)"
                              className="p-1.5 rounded-lg bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"><Ban className="w-3.5 h-3.5" /></button>
                          )}
                          {b.status === "RELEASED" && remainingOf(b) > 0 && (
                            <button onClick={() => { setConsumeBatch(b); setModal("CONSUME"); }} data-testid={`fm-consume-${b.id}`} title="Feed flock from this batch"
                              className="p-1.5 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"><Wheat className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {batches.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">No batches produced yet — run your first mix once formulations and raw stock exist.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* QC log */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><ClipboardList className="w-4 h-4 text-purple-400" /> QC Test Log</h3>
            <button onClick={() => { setQcBatch(null); setModal("QC"); }} data-testid="fm-btn-qc"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-500/20 text-purple-300 text-xs font-bold hover:bg-purple-500/30">
              <Plus className="w-3.5 h-3.5" /> Log QC Check
            </button>
          </div>
          <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">Date</th><th className="px-4 py-3">Stage</th><th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">Test</th><th className="px-4 py-3">Result</th>
                  <th className="px-4 py-3 text-center">Verdict</th><th className="px-4 py-3">Tested By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {qcChecks.map((q: any) => (
                  <tr key={q.id} className="hover:bg-slate-700/40">
                    <td className="px-4 py-3 text-slate-400">{q.testedAt ? String(q.testedAt).slice(0, 10) : "—"}</td>
                    <td className="px-4 py-3 text-slate-300">{q.stage?.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-emerald-400">{q.batchNumber || "raw material"}</td>
                    <td className="px-4 py-3 text-white font-semibold">{q.testName}<div className="text-[9px] text-slate-500">{q.sampleRef || ""}{q.requiredStandard ? ` · ${q.requiredStandard}` : ""}</div></td>
                    <td className="px-4 py-3 text-slate-300">{q.testResult || (q.resultValue != null ? `${q.resultValue}${q.resultUnit || ""}` : "—")}{q.moisturePct != null ? ` · ${q.moisturePct}% moisture` : ""}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${q.passFail === "PASS" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}>{q.passFail}</span>
                    </td>
                    <td className="px-4 py-3 text-[10px] text-slate-400">{q.testerName || q.recordedByName || "—"}</td>
                  </tr>
                ))}
                {qcChecks.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No QC checks logged. Raw-material and finished-feed tests protect flock health and gate batch release.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════ RAW STOCK & INTAKE ════════════ */}
      {view === "STOCK" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><Truck className="w-4 h-4 text-amber-400" /> Raw Materials (mill store)</h3>
            <button onClick={() => setModal("INTAKE")} data-testid="fm-btn-intake"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
              <Plus className="w-3.5 h-3.5" /> Raw Material Intake
            </button>
          </div>
          <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">SKU</th><th className="px-4 py-3">Ingredient</th>
                  <th className="px-4 py-3 text-right">In Stock</th><th className="px-4 py-3 text-right">Cost/kg</th>
                  <th className="px-4 py-3 text-right">Value</th><th className="px-4 py-3 text-right">Min</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {rawMaterials.map((r: any) => {
                  const low = (r.minStockThreshold || 0) > 0 && (r.quantity || 0) <= (r.minStockThreshold || 0);
                  return (
                    <tr key={r.id} className="hover:bg-slate-700/40" data-testid={`fm-raw-${r.id}`}>
                      <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{r.sku}</td>
                      <td className="px-4 py-3 font-semibold text-white">{r.name}</td>
                      <td className="px-4 py-3 text-right font-bold text-amber-300">{fmtKg(r.quantity || 0, { bag: "BAG50" })}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{formatMoney(r.costPriceGhs, currentCurrency)}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{formatMoney((r.quantity || 0) * (r.costPriceGhs || 0), currentCurrency, true)}</td>
                      <td className="px-4 py-3 text-right text-slate-500">{r.minStockThreshold || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${(r.quantity || 0) <= 0 ? "bg-rose-500/20 text-rose-300" : low ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                          {(r.quantity || 0) <= 0 ? "OUT" : low ? "LOW" : "OK"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {rawMaterials.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No raw materials yet — record an intake (maize, bran, soybean meal, concentrate, premix…).</td></tr>}
              </tbody>
            </table>
          </div>

          <h3 className="text-sm font-bold text-white flex items-center gap-2"><Package className="w-4 h-4 text-cyan-400" /> Finished Feed (milled, in stock)</h3>
          <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Feed</th><th className="px-4 py-3 text-right">In Stock</th><th className="px-4 py-3 text-right">Cost/kg</th><th className="px-4 py-3 text-right">Ref price</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {finishedFeeds.map((r: any) => (
                  <tr key={r.id} className="hover:bg-slate-700/40">
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{r.sku}</td>
                    <td className="px-4 py-3 font-semibold text-white">{r.name}</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-300">{fmtKg(r.quantity || 0, { bag: "BAG50" })}</td>
                    <td className="px-4 py-3 text-right text-slate-300">{formatMoney(r.costPriceGhs, currentCurrency)}</td>
                    <td className="px-4 py-3 text-right text-amber-300">{r.sellingPriceGhs ? formatMoney(r.sellingPriceGhs, currentCurrency) : "—"}</td>
                  </tr>
                ))}
                {finishedFeeds.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">Finished milled feed appears here when batches are produced.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════ FEED OUT ════════════ */}
      {view === "FEEDOUT" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2"><Wheat className="w-4 h-4 text-emerald-400" /> Feed Flocks from Milled Stock</h3>
            <button onClick={() => { setConsumeBatch(null); setModal("CONSUME"); }} data-testid="fm-btn-consume"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
              <Plus className="w-3.5 h-3.5" /> Log Feeding
            </button>
          </div>
          <p className="text-[11px] text-slate-400 -mt-1">Draws feed from a <b>released</b> batch into the flock's daily feed record. Cost was already booked at intake — feeding never re-books money (single-booking), but your cost-per-egg / FCR maths keep the derived value.</p>

          {/* derived feed-conversion insight (last 30 days, own-mill feed) */}
          {flockInsights.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="fm-flock-insights">
              {flockInsights.map((x: any) => (
                <div key={x.flock.id} className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white truncate">{x.flock.flockName || x.flock.batchNumber}</span>
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/20 text-emerald-300">30d</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                    <div><div className="text-[9px] text-slate-500">Own-mill fed</div><div className="text-xs font-bold text-amber-300">{x.fed.toFixed(1)} kg</div></div>
                    {x.broiler && x.weightOut > 0 ? (
                      <><div><div className="text-[9px] text-slate-500">Weight out</div><div className="text-xs font-bold text-white">{x.weightOut.toFixed(1)} kg</div></div>
                      <div><div className="text-[9px] text-slate-500">Feed/kg gain</div><div className="text-xs font-black text-emerald-400">{(x.fed / x.weightOut).toFixed(2)}</div></div></>
                    ) : x.eggs > 0 ? (
                      <><div><div className="text-[9px] text-slate-500">Eggs</div><div className="text-xs font-bold text-white">{x.eggs.toLocaleString()}</div></div>
                      <div><div className="text-[9px] text-slate-500">FCR-egg</div><div className="text-xs font-black text-emerald-400">{x.fcrEgg == null ? "—" : x.fcrEgg.toFixed(2)}</div></div></>
                    ) : (
                      <div className="col-span-2 text-left text-[10px] text-slate-500 self-center">Awaiting production logs for conversion maths — feed intake is tracked.</div>
                    )}
                  </div>
                  {x.broiler && x.weightOut === 0 && x.eggs === 0 && (
                    <p className="text-[9px] text-slate-500 mt-1">No output in 30d — insight fills once harvest logs land.</p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="px-4 py-3">Date</th><th className="px-4 py-3">Flock / Batch</th>
                  <th className="px-4 py-3">Feed</th><th className="px-4 py-3">From Batch</th>
                  <th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Derived value</th>
                  <th className="px-4 py-3">Recorded By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {consumption.map((c: any) => (
                  <tr key={c.id} className="hover:bg-slate-700/40" data-testid={`fm-consumption-${c.id}`}>
                    <td className="px-4 py-3 text-slate-400">{c.recordedDate}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-300">{c.batchNumber || "—"}</td>
                    <td className="px-4 py-3 font-bold text-amber-300">{c.feedType?.replace(/_/g, " ")}<div className="text-[9px] font-normal text-slate-500">{c.brandSupplier || ""}</div></td>
                    <td className="px-4 py-3 font-mono text-[10px] text-emerald-400">{(batches.find((b: any) => b.id === c.feedBatchId) || {}).batchNumber || c.feedBatchId}</td>
                    <td className="px-4 py-3 text-right font-bold text-white">{c.quantityKg?.toFixed(1)} kg</td>
                    <td className="px-4 py-3 text-right text-slate-300">{formatMoney((c.quantityKg || 0) * (c.costPerKgGhs || 0), currentCurrency, true)}</td>
                    <td className="px-4 py-3 text-[10px] text-slate-400">{c.recordedByName}</td>
                  </tr>
                ))}
                {consumption.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No own-mill feeding yet — release a batch, then feed a flock from here.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════ MODALS ════════════ */}
      {(modal === "FORMULA" || modal === "EDIT_FORMULA") && (
        <FormulaModal
          existing={modal === "EDIT_FORMULA" ? editForm : null}
          bom={editForm ? bomOf(editForm.id) : []}
          rawMaterials={rawMaterials} busy={busy} error={err} canDeactivate={canOverride}
          tidPrefix="fm"
          initial={editForm ? {
            name: editForm.name, feedType: editForm.feedType, birdType: editForm.birdType,
            ageFromWks: editForm.ageFromWks ?? "", ageToWks: editForm.ageToWks ?? "",
            batchSizeKg: editForm.batchSizeKg, cpPctTarget: editForm.cpPctTarget ?? "",
            meKcalKgTarget: editForm.meKcalKgTarget ?? "", commercialRefPriceGhs: editForm.commercialRefPriceGhs ?? "",
            notes: editForm.notes || "", active: editForm.active !== false,
          } : {
            name: "", feedType: "LAYER_MASH", birdType: "LAYERS", ageFromWks: "", ageToWks: "",
            batchSizeKg: 500, cpPctTarget: "", meKcalKgTarget: "", commercialRefPriceGhs: "", notes: "", active: true,
          }}
          speciesFields={(f: any, set: (k: string, v: any) => void) => (<>
            <Field label="Feed type">
              <select value={f.feedType} onChange={(e) => set("feedType", e.target.value)} className={inputCls}>
                {FEED_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
            <Field label="Bird type">
              <select value={f.birdType} onChange={(e) => set("birdType", e.target.value)} className={inputCls}>
                {["LAYERS", "BROILERS", "COCKERELS", "TURKEYS", "GUINEA_FOWL", "BOTH"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Age from (weeks)"><input type="number" step="0.5" value={f.ageFromWks} onChange={(e) => set("ageFromWks", e.target.value)} className={inputCls} /></Field>
            <Field label="Age to (weeks)"><input type="number" step="0.5" value={f.ageToWks} onChange={(e) => set("ageToWks", e.target.value)} className={inputCls} /></Field>
            <Field label="ME target (kcal/kg)"><input type="number" step="1" value={f.meKcalKgTarget} onChange={(e) => set("meKcalKgTarget", e.target.value)} className={inputCls} placeholder="e.g. 2750" /></Field>
          </>)}
          onClose={() => { setModal(null); setEditForm(null); setErr(""); }}
          onSubmit={async (payload: any) => {
            const base = { businessId: bizId, branchCode, branchName, ...payload };
            const ok = editForm
              ? await post("FORMULATION", { id: editForm.id, ...base }, "PATCH")
              : await post("FORMULATION", base);
            if (ok) await finishOk(editForm ? `Formulation ${editForm.formulationNo} updated.` : "Formulation created — intake raw materials, then run a batch.");
          }}
        />
      )}

      {modal === "INTAKE" && (
        <IntakeModal rawMaterials={rawMaterials} busy={busy} error={err} currency={currentCurrency}
          onClose={() => { setModal(null); setErr(""); }}
          onSubmit={async (payload: any) => {
            const ok = await post("INTAKE", { businessId: bizId, branchCode, branchName, ...payload });
            if (ok) await finishOk(`Intake recorded: ${fmtKg(ok.item?.quantity || 0, { bag: "BAG50" })} now in mill store${ok.expense ? ` · expense GH₵ ${Number(ok.expense.amountGhs).toLocaleString()}` : ""}.`);
          }}
        />
      )}

      {modal === "BATCH" && (
        <BatchModal formulations={formulations.filter((f: any) => f.active !== false)} bomOf={bomOf} stockLeft={stockLeft}
          rawMaterials={rawMaterials} busy={busy} error={err} currency={currentCurrency}
          onClose={() => { setModal(null); setErr(""); }}
          onSubmit={async (payload: any) => {
            const ok = await post("BATCH", { businessId: bizId, branchCode, branchName, ...payload });
            if (ok) await finishOk(`Batch ${ok.item.batchNumber} milled — ${ok.item.actualOutputKg} kg at ${formatMoney(ok.item.costPerKgGhs, currentCurrency)}/kg · QC HOLD until a finished-feed test passes.`);
          }}
        />
      )}

      {modal === "QC" && (
        <QcModal batches={batches.filter((b: any) => b.status !== "REJECTED")} preset={qcBatch} busy={busy} error={err}
          testerName={currentUser?.name} testerRole={currentUser?.role}
          tidPrefix="fm" qcStages={QC_STAGES}
          extraFields={(f: any, set: (k: string, v: any) => void) => (
            <Field label="Texture">
              <select value={f.textureGrade || ""} onChange={(e) => set("textureGrade", e.target.value)} className={inputCls}>
                <option value="">—</option><option>FINE</option><option>MEDIUM</option><option>COARSE</option>
              </select>
            </Field>
          )}
          extraPayload={(f: any) => ({ textureGrade: f.textureGrade || undefined })}
          onClose={() => { setModal(null); setQcBatch(null); setErr(""); }}
          onSubmit={async (payload: any) => {
            const ok = await post("QC", { businessId: bizId, branchCode, ...payload });
            if (ok) await finishOk(ok.item.passFail === "FAIL" ? "FAIL logged — critical alert fanned out to management." : "QC check logged.");
          }}
        />
      )}

      {modal === "CONSUME" && (
        <ConsumeModal
          batches={batches.filter((b: any) => b.status === "RELEASED" && remainingOf(b) > 0)} preset={consumeBatch}
          remainingOf={remainingOf} flocks={flocks} busy={busy} error={err} currency={currentCurrency}
          onClose={() => { setModal(null); setConsumeBatch(null); setErr(""); }}
          onSubmit={async (payload: any) => {
            const ok = await post("CONSUMPTION", { businessId: bizId, branchCode, branchName, ...payload });
            if (ok) await finishOk(`Fed ${ok.item.quantityKg} kg — ${fmtKg(ok.batchRemainingKg ?? 0, { bag: "BAG50" })} left on that batch.`);
          }}
        />
      )}

      <ConfirmActionModal
        open={!!confirm} title={confirm?.title || ""} message={confirm?.message || ""}
        details={confirm?.details || []} tone={confirm?.tone || "amber"} confirmLabel={confirm?.label}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null); c?.run(); }}
        testid="fm-confirm"
      />
    </div>
  );
}

/* ═════════════════════════ FEED OUT ════════════════════════════════════ */

function ConsumeModal({ batches, preset, remainingOf, flocks, busy, error, currency, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    batchId: preset?.id || (batches[0]?.id ?? ""), flockId: "", qty: "", unit: "KG",
    recordedDate: new Date().toISOString().split("T")[0], notes: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const batch = batches.find((b: any) => Number(b.id) === Number(f.batchId));
  const remaining = batch ? remainingOf(batch) : 0;
  const qtyKg = feedToKg(Number(f.qty) || 0, f.unit);
  const over = qtyKg > remaining + 1e-9;

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      batchId: Number(f.batchId), flockId: f.flockId === "" ? undefined : Number(f.flockId),
      qty: Number(f.qty), unit: f.unit, recordedDate: f.recordedDate, notes: f.notes || undefined,
    });
  };

  if (!batches.length) {
    return (
      <ModalShell title="Feed Flock from Mill" icon={Wheat} onClose={onClose}>
        <p className="text-xs text-slate-400">No released milled feed in stock — release a QC-passed batch first (Batches & QC tab).</p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Feed Flock from Milled Stock" icon={Wheat} onClose={onClose}>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <Field label="From batch *">
          <select value={f.batchId} onChange={(e) => set("batchId", e.target.value)} className={inputCls} data-testid="fm-consume-batch">
            <option value="">— choose batch —</option>
            {batches.map((b: any) => <option key={b.id} value={b.id}>{b.batchNumber} · {b.formulationName} · {remainingOf(b).toFixed(0)} kg left</option>)}
          </select>
        </Field>
        {batch && (
          <div className="text-[11px] text-slate-400 bg-slate-800/80 border border-slate-700 rounded-lg p-2.5">
            <b className="text-white">{batch.formulationName}</b> ({batch.feedType?.replace(/_/g, " ")}) ·
            cost {formatMoney(batch.costPerKgGhs, currency)}/kg · <b className="text-emerald-300">{fmtKg(remaining, { bag: "BAG50" })} remaining</b>
          </div>
        )}
        <Field label="Flock / batch fed *">
          <select required value={f.flockId} onChange={(e) => set("flockId", e.target.value)} className={inputCls} data-testid="fm-consume-flock">
            <option value="">— choose flock —</option>
            {flocks.map((fl: any) => <option key={fl.id} value={fl.id}>{fl.batchNumber} · {fl.flockName || fl.birdType} ({fl.currentCount} birds)</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity *"><input required type="number" min={0.1} step={0.1} value={f.qty} onChange={(e) => set("qty", e.target.value)} className={inputCls} data-testid="fm-consume-qty" /></Field>
          <UnitPicker f={f} set={set} />
          <Field label="Date"><input type="date" value={f.recordedDate} onChange={(e) => set("recordedDate", e.target.value)} className={inputCls} /></Field>
        </div>
        {qtyKg > 0 && <div className={`text-[11px] font-bold ${over ? "text-rose-400" : "text-emerald-400"}`}>= {fmtKg(qtyKg, { bag: "BAG50" })}{over ? ` — exceeds the ${remaining.toFixed(0)} kg remaining` : ""}</div>}
        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        <p className="text-[10px] text-slate-500">Deducts finished-feed stock and logs the flock's feeding. Money was booked at intake — this never creates another expense (single-booking).</p>
        <SubmitBar busy={busy || over || !f.batchId} label={over ? "Not enough on batch" : "Record Feeding"} testid="fm-consume-submit" />
      </form>
    </ModalShell>
  );
}
