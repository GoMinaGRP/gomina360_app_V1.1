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
import { computeFeedMillAnalytics, FmAlert } from "@/lib/feedMillAnalytics";
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

/* ══════════════════════════════ tiny primitives ═══════════════════════ */

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[9px] text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}
const inputCls = "w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:border-emerald-500/60 focus:outline-none";

function Stat({ label, value, sub, color = "emerald", icon: Icon, testid }: any) {
  return (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid={testid}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase font-bold text-slate-400">{label}</span>
        {Icon && <Icon className={`w-4 h-4 text-${color}-400`} />}
      </div>
      <div className={`text-lg font-black text-${color}-400 mt-1`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Alerts({ alerts }: { alerts: FmAlert[] }) {
  if (!alerts.length) return null;
  const styles: Record<string, string> = {
    critical: "border-rose-500/40 bg-rose-500/10",
    warning: "border-amber-500/40 bg-amber-500/10",
    normal: "border-emerald-500/40 bg-emerald-500/10",
  };
  const iconOf = (l: string) =>
    l === "critical" ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
    : l === "warning" ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
    : <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
  return (
    <div className="space-y-2" data-testid="fm-alerts">
      {alerts.map((a) => (
        <div key={a.id} className={`rounded-xl border p-3 flex items-start gap-3 ${styles[a.level] || styles.normal}`}>
          {iconOf(a.level)}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] uppercase font-black tracking-wider text-slate-400">{a.category}</span>
              <span className="text-xs font-bold text-white">{a.title}</span>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">{a.message}</p>
            {a.recommendation && <p className="text-[10px] text-slate-400 mt-1 italic">→ {a.recommendation}</p>}
          </div>
          {a.value && (
            <div className="text-right shrink-0">
              <div className="text-sm font-black text-white">{a.value}</div>
              {a.threshold && <div className="text-[9px] text-slate-500">{a.threshold}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const statusPill = (s: string) =>
  s === "RELEASED" ? "bg-emerald-500/20 text-emerald-300" :
  s === "QC_HOLD" ? "bg-amber-500/20 text-amber-300" :
  s === "REJECTED" ? "bg-rose-500/20 text-rose-300" : "bg-slate-700 text-slate-300";

/* ══════════════════════════════ main component ═════════════════════════ */

export default function PoultryFeedMill({ currentUser, businessInfo, currentCurrency, onChanged }: Props) {
  const bizId = businessInfo?.id;
  const branchCode = businessInfo?.code;
  const branchName = businessInfo?.name;
  const role = currentUser?.role;
  const canOverride = role === "OWNER" || currentUser?.canManageRecords === true;

  const [view, setView] = useState<View>("OVERVIEW");
  const [modal, setModal] = useState<Modal>(null);
  const [editForm, setEditForm] = useState<any>(null); // formulation being edited
  const [qcBatch, setQcBatch] = useState<any>(null);   // batch context for QC modal
  const [consumeBatch, setConsumeBatch] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<null | { title: string; message: string; details: any[]; tone: any; label: string; run: () => Promise<void> }>(null);

  const [mill, setMill] = useState<any>({
    formulations: [], formulationItems: [], batches: [], batchInputs: [], qcChecks: [],
    rawMaterials: [], finishedFeeds: [], consumption: [], feedLogs: [], flocks: [],
  });

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/poultry/feed-mill?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) setMill(d);
      else setErr(d.error || "Failed to load feed mill data.");
    } catch (e: any) { setErr(e.message || "Network error"); }
    finally { setLoading(false); }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);

  const { formulations, formulationItems, batches, qcChecks, rawMaterials, finishedFeeds, consumption, flocks } = mill;
  const production: any[] = mill.production || [];

  const { kpis, alerts } = useMemo(() => computeFeedMillAnalytics({
    formulations, formulationItems, batches, batchInputs: mill.batchInputs, qcChecks,
    inventory: [...(mill.rawMaterials || []), ...(mill.finishedFeeds || [])],
    feedLogs: mill.feedLogs || [], currentCurrency,
  }), [mill, currentCurrency]);

  /** kg remaining per released/hold batch = stocked − own-mill consumption so far. */
  const remainingOf = useCallback((batch: any) => {
    const used = (mill.consumption || [])
      .filter((c: any) => c.feedBatchId === batch.id)
      .reduce((s: number, c: any) => s + (c.quantityKg || 0), 0);
    return Math.max(0, (batch.stockedQtyKg || 0) - used);
  }, [mill.consumption]);

  const bomOf = useCallback((formId: number) =>
    formulationItems.filter((i: any) => i.formulationId === formId), [formulationItems]);

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

  const stockLeft = useCallback((inventoryId: number | null) => {
    const hit = rawMaterials.find((r: any) => r.id === inventoryId);
    return hit ? (hit.quantity || 0) : 0;
  }, [rawMaterials]);

  /* ── submit ── */
  const post = async (entity: string, data: any, method = "POST") => {
    setBusy(true); setErr("");
    try {
      // PATCH on this endpoint follows the app's shared convention:
      // { entity, id (top-level), data } — POST uses { entity, data }.
      const payload = method === "PATCH" ? { entity, id: data.id, data } : { entity, data };
      const res = await fetch("/api/poultry/feed-mill", {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!d.success) { setErr(d.error || "Operation failed."); return false; }
      return d;
    } catch (e: any) { setErr(e.message || "Network error"); return false; }
    finally { setBusy(false); }
  };

  const finishOk = async (msg: string) => {
    setModal(null); setEditForm(null); setQcBatch(null); setConsumeBatch(null);
    setErr("");
    flash(msg);
    await refresh();
    onChanged();
  };

  const [toast, setToast] = useState("");
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 5000); };

  /* ── release / reject ── */
  const hasFinishedPass = (batchId: number) =>
    qcChecks.some((q: any) => q.batchId === batchId && q.stage === "FINISHED_FEED" && q.passFail === "PASS");

  const askRelease = (batch: any) => {
    const passed = hasFinishedPass(batch.id);
    if (!passed && !canOverride) {
      setErr(`Batch ${batch.batchNumber} has no PASSING finished-feed QC check. Run a finished-feed test first (QC tab), or ask the Owner to override.`);
      return;
    }
    setConfirm({
      title: `Release ${batch.batchNumber}`,
      message: passed
        ? "This batch passed finished-feed QC. Releasing makes it available for flock feeding."
        : "⚠ OVERRIDE: this batch has NO passing finished-feed QC check. As Owner/records manager you may release it with a justification that stays in the audit trail.",
      details: [
        { label: "Batch", value: batch.batchNumber },
        { label: "Output", value: fmtKg(batch.actualOutputKg || 0, { bag: "BAG50" }) },
        { label: "Cost", value: `${formatMoney(batch.costPerKgGhs, currentCurrency)}/kg` },
        { label: "QC basis", value: passed ? "Finished-feed PASS" : "OWNER OVERRIDE (note required)" },
      ],
      tone: passed ? "emerald" : "amber",
      label: passed ? "Release Batch" : "Override & Release",
      run: async () => {
        let note = "";
        if (!passed) {
          note = window.prompt("Override justification (audited):")?.trim() || "";
          if (!note) { setErr("Override release needs a justification note."); return; }
        }
        const ok = await post("RELEASE", { businessId: bizId, batchId: batch.id, note });
        if (ok) await finishOk(`Batch ${batch.batchNumber} released — ${batch.actualOutputKg} kg available for feeding.`);
      },
    });
  };

  const askReject = (batch: any) => {
    if (!canOverride) { setErr("Only the Owner (or a records-authorized manager) may reject a batch."); return; }
    setConfirm({
      title: `Reject ${batch.batchNumber}?`,
      message: "Rejecting discards the batch: its finished-feed stock-in is reversed and it can never be fed. This is permanent and audit-logged.",
      details: [
        { label: "Batch", value: batch.batchNumber },
        { label: "Reverses", value: fmtKg(remainingOf(batch), { bag: "BAG50" }) },
        { label: "Write-off", value: formatMoney(batch.totalCostGhs, currentCurrency) },
      ],
      tone: "rose",
      label: "Reject Batch",
      run: async () => {
        const reason = window.prompt("Reason for rejection (audited):")?.trim() || "";
        if (!reason) { setErr("Rejection needs a reason."); return; }
        const ok = await post("REJECT", { businessId: bizId, batchId: batch.id, reason });
        if (ok) await finishOk(`Batch ${batch.batchNumber} rejected; ${ok.stockReversedKg ?? remainingOf(batch)} kg reversed from stock.`);
      },
    });
  };

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

/* ══════════════════════════════ modal shell ════════════════════════════ */

function ModalShell({ title, icon: Icon, onClose, children, wide }: any) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className={`bg-slate-900 border border-slate-700 rounded-2xl w-full ${wide ? "max-w-2xl" : "max-w-lg"} shadow-2xl max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <h3 className="text-base font-bold text-white flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-emerald-400" />} {title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function UnitPicker({ f, set, k = "unit" }: any) {
  return (
    <Field label="Unit">
      <select value={f[k]} onChange={(e) => set(k, e.target.value)} className={inputCls}>
        {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
      </select>
    </Field>
  );
}

function SubmitBar({ busy, label, testid }: any) {
  return (
    <button type="submit" disabled={busy} data-testid={testid}
      className="w-full mt-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold transition">
      {busy ? "Saving…" : label}
    </button>
  );
}

const ErrBox = ({ error }: any) => error ? <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs mb-3">{error}</div> : null;

/* ═════════════════════════ FORMULA builder ═════════════════════════════ */

function FormulaModal({ existing, bom, rawMaterials, busy, error, canDeactivate, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>(existing ? {
    name: existing.name, feedType: existing.feedType, birdType: existing.birdType,
    ageFromWks: existing.ageFromWks ?? "", ageToWks: existing.ageToWks ?? "",
    batchSizeKg: existing.batchSizeKg, cpPctTarget: existing.cpPctTarget ?? "",
    meKcalKgTarget: existing.meKcalKgTarget ?? "", commercialRefPriceGhs: existing.commercialRefPriceGhs ?? "",
    notes: existing.notes || "", active: existing.active !== false,
  } : {
    name: "", feedType: "LAYER_MASH", birdType: "LAYERS", ageFromWks: "", ageToWks: "",
    batchSizeKg: 500, cpPctTarget: "", meKcalKgTarget: "", commercialRefPriceGhs: "", notes: "", active: true,
  });
  const [items, setItems] = useState<any[]>(bom?.length
    ? bom.map((b: any) => ({ inventoryId: b.inventoryId, ingredientName: b.ingredientName, sharePct: b.sharePct }))
    : [{ inventoryId: null, ingredientName: "", sharePct: "" }]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const shareTotal = items.reduce((s, i) => s + (Number(i.sharePct) || 0), 0);

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = items.filter((i) => i.ingredientName && Number(i.sharePct) > 0);
    onSubmit({ ...f, items: clean });
  };

  return (
    <ModalShell title={existing ? `Edit ${existing.formulationNo}` : "New Feed Formulation"} icon={FlaskConical} onClose={onClose} wide>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Formula name *">
            <input required value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="e.g. Koforidua Layer Mash 18%" data-testid="fm-form-name" />
          </Field>
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
          <Field label="Standard batch size (kg)" hint="Default mix quantity; adjustable per run">
            <input type="number" min={1} step={1} value={f.batchSizeKg} onChange={(e) => set("batchSizeKg", Number(e.target.value))} className={inputCls} data-testid="fm-form-batchsize" />
          </Field>
          <Field label="Age from (weeks)"><input type="number" step={0.5} value={f.ageFromWks} onChange={(e) => set("ageFromWks", e.target.value)} className={inputCls} /></Field>
          <Field label="Age to (weeks)"><input type="number" step={0.5} value={f.ageToWks} onChange={(e) => set("ageToWks", e.target.value)} className={inputCls} /></Field>
          <Field label="CP target %"><input type="number" step={0.1} value={f.cpPctTarget} onChange={(e) => set("cpPctTarget", e.target.value)} className={inputCls} placeholder="e.g. 18" /></Field>
          <Field label="ME target (kcal/kg)"><input type="number" step={1} value={f.meKcalKgTarget} onChange={(e) => set("meKcalKgTarget", e.target.value)} className={inputCls} placeholder="e.g. 2750" /></Field>
        </div>
        <Field label="Commercial reference price (GH₵/kg)" hint="What equivalent commercial feed sells for. Savings vs your milling cost use this; left blank we fall back to your 90-day commercial purchase average.">
          <input type="number" step="0.01" value={f.commercialRefPriceGhs} onChange={(e) => set("commercialRefPriceGhs", e.target.value)} className={inputCls} placeholder="e.g. 9.80" data-testid="fm-form-refprice" />
        </Field>

        <div className="border border-slate-700 rounded-xl p-3 space-y-2" data-testid="fm-form-items">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Ingredients (% of mix)</span>
            <span className={`text-[10px] font-bold ${Math.abs(shareTotal - 100) < 0.01 ? "text-emerald-400" : "text-rose-400"}`}>Total: {shareTotal.toFixed(1)}%</span>
          </div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_90px_28px] gap-2 items-center">
              <div>
                <input list="fm-raw-list" value={it.ingredientName}
                  onChange={(e) => {
                    const name = e.target.value;
                    const hit = rawMaterials.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
                    setItems(items.map((x, i) => i === idx ? { ...x, ingredientName: name, inventoryId: hit ? hit.id : null } : x));
                  }}
                  className={inputCls} placeholder="Ingredient (e.g. Maize)" data-testid={`fm-form-item-name-${idx}`} />
              </div>
              <input type="number" step="0.1" min={0} max={100} value={it.sharePct}
                onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, sharePct: e.target.value } : x))}
                className={inputCls} placeholder="%" data-testid={`fm-form-item-share-${idx}`} />
              <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))}
                className="p-1.5 rounded text-slate-500 hover:text-rose-400"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <datalist id="fm-raw-list">{rawMaterials.map((r: any) => <option key={r.id} value={r.name} />)}</datalist>
          <button type="button" onClick={() => setItems([...items, { inventoryId: null, ingredientName: "", sharePct: "" }])}
            className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300" data-testid="fm-form-add-item">+ add ingredient</button>
        </div>

        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional — formulation rationale, vet advice…" /></Field>
        {existing && canDeactivate && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (uncheck to retire this formulation — owner authority)
          </label>
        )}
        <SubmitBar busy={busy} label={existing ? "Save Formulation" : "Create Formulation"} testid="fm-form-submit" />
      </form>
    </ModalShell>
  );
}

/* ═════════════════════════ INTAKE ══════════════════════════════════════ */

function IntakeModal({ rawMaterials, busy, error, currency, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    inventoryId: "", itemName: "", qty: "", unit: "BAG50", unitCostGhsPerUnit: "", totalCostGhs: "",
    supplierName: "", paymentMethod: "CASH", date: new Date().toISOString().split("T")[0], recordExpense: true, minStockThreshold: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const qtyKg = feedToKg(Number(f.qty) || 0, f.unit);
  // Cost expressed per displayed unit for the buyer's convenience; converted
  // to GH₵/kg for the server (single canonical cost basis).
  const unitKg = FEED_UNITS.find((u) => u.key === f.unit)?.kg || 1;
  const costPerKg = Number(f.unitCostGhsPerUnit) > 0 ? Number(f.unitCostGhsPerUnit) / unitKg : 0;
  const total = Number(f.totalCostGhs) > 0 ? Number(f.totalCostGhs) : (qtyKg > 0 && costPerKg > 0 ? qtyKg * costPerKg : 0);

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      inventoryId: f.inventoryId === "" ? null : Number(f.inventoryId),
      itemName: f.inventoryId === "" ? f.itemName : undefined,
      qty: Number(f.qty), unit: f.unit,
      unitCostGhs: +costPerKg.toFixed(4),
      totalCostGhs: total > 0 ? +total.toFixed(2) : undefined,
      supplierName: f.supplierName || undefined,
      date: f.date, paymentMethod: f.paymentMethod,
      recordExpense: f.recordExpense,
      minStockThreshold: f.minStockThreshold === "" ? undefined : Number(f.minStockThreshold),
      description: undefined,
    });
  };

  return (
    <ModalShell title="Raw Material Intake" icon={Truck} onClose={onClose}>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <Field label="Ingredient *" hint="Pick an existing mill ingredient or type a new one (maize, wheat bran, soybean meal, fish meal, concentrate, premix…)">
          <select value={f.inventoryId} onChange={(e) => set("inventoryId", e.target.value)} className={inputCls} data-testid="fm-intake-item">
            <option value="">— New ingredient —</option>
            {rawMaterials.map((r: any) => <option key={r.id} value={r.id}>{r.name} ({(r.quantity || 0).toFixed(0)} kg on hand)</option>)}
          </select>
        </Field>
        {f.inventoryId === "" && (
          <Field label="New ingredient name *"><input required value={f.itemName} onChange={(e) => set("itemName", e.target.value)} className={inputCls} placeholder="e.g. Maize" data-testid="fm-intake-newname" /></Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity *"><input required type="number" min={0.1} step={0.1} value={f.qty} onChange={(e) => set("qty", e.target.value)} className={inputCls} data-testid="fm-intake-qty" /></Field>
          <UnitPicker f={f} set={set} />
        </div>
        {qtyKg > 0 && <div className="text-[11px] text-emerald-300 font-semibold">= {fmtKg(qtyKg, { bag: f.unit === "BAG25" ? "BAG25" : "BAG50" })} into mill store</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Cost per ${f.unit === "KG" ? "kg" : f.unit === "BAG25" ? "25-kg bag" : f.unit === "BAG50" ? "50-kg bag" : "tonne"} (GH₵)`}>
            <input type="number" min={0} step={0.01} value={f.unitCostGhsPerUnit} onChange={(e) => set("unitCostGhsPerUnit", e.target.value)} className={inputCls} placeholder="e.g. 420 per bag" data-testid="fm-intake-cost" />
          </Field>
          <Field label="Total paid (GH₵)" hint={total > 0 ? `auto ${formatMoney(total, currency)} — override if negotiated` : "quantity × cost"}>
            <input type="number" min={0} step="0.01" value={f.totalCostGhs} onChange={(e) => set("totalCostGhs", e.target.value)} className={inputCls} placeholder="auto" data-testid="fm-intake-total" />
          </Field>
          <Field label="Supplier"><input value={f.supplierName} onChange={(e) => set("supplierName", e.target.value)} className={inputCls} placeholder="e.g. Olam Grains, Koforidua" data-testid="fm-intake-supplier" /></Field>
          <Field label="Payment">
            <select value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} className={inputCls}>
              {["CASH", "MOMO", "BANK", "CREDIT"].map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={inputCls} /></Field>
          <Field label="Low-stock threshold (kg)" hint="optional, new ingredients">
            <input type="number" min={0} step={1} value={f.minStockThreshold} onChange={(e) => set("minStockThreshold", e.target.value)} className={inputCls} placeholder="e.g. 100" />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-xs text-slate-300" data-testid="fm-intake-expense-row">
          <input type="checkbox" className="mt-0.5" checked={f.recordExpense} onChange={(e) => set("recordExpense", e.target.checked)} />
          <span>Book the purchase to Finance once (category <b>Poultry · Feed Raw Material</b>). Milling will draw cost from this stock — never re-expensed.</span>
        </label>
        <SubmitBar busy={busy} label="Record Intake" testid="fm-intake-submit" />
      </form>
    </ModalShell>
  );
}

/* ═════════════════════════ BATCH run ═══════════════════════════════════ */

function BatchModal({ formulations, bomOf, stockLeft, rawMaterials, busy, error, currency, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    formulationId: formulations[0]?.id || "", plannedInput: "", inputUnit: "KG",
    actualOutput: "", outputUnit: "KG", labourCostGhs: "", overheadCostGhs: "",
    operatorName: "", productionDate: new Date().toISOString().split("T")[0], paymentMethod: "CASH", notes: "",
  });
  const [draws, setDraws] = useState<any[]>([]); // editable per-line kg draws
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  const form = formulations.find((x: any) => Number(x.id) === Number(f.formulationId));
  const bom = form ? bomOf(form.id) : [];
  const plannedKg = feedToKg(Number(f.plannedInput || form?.batchSizeKg || 0) || 0, f.inputUnit);

  useEffect(() => {
    // reset draw lines whenever recipe / planned size changes
    setDraws(bom.map((line: any) => ({
      formulationItemId: line.id, ingredientName: line.ingredientName, inventoryId: line.inventoryId,
      sharePct: line.sharePct, actualKg: +(((line.sharePct || 0) / 100) * plannedKg).toFixed(3),
    })));
  }, [form?.id, plannedKg, formulationItemsKey(bom)]);

  const anyShort = draws.some((d) => stockLeft(d.inventoryId) + 1e-9 < d.actualKg);
  const outputKg = feedToKg(Number(f.actualOutput) || 0, f.outputUnit);
  const yieldPreview = plannedKg > 0 && outputKg > 0 ? +((outputKg / plannedKg) * 100).toFixed(1) : null;

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      formulationId: Number(f.formulationId),
      plannedInputKg: plannedKg,
      actualOutputKg: Number(f.actualOutput), outputUnit: f.outputUnit,
      inputOverrides: draws.map((d) => ({ formulationItemId: d.formulationItemId, actualKg: d.actualKg })),
      labourCostGhs: Number(f.labourCostGhs) || 0, overheadCostGhs: Number(f.overheadCostGhs) || 0,
      operatorName: f.operatorName || undefined, productionDate: f.productionDate,
      paymentMethod: f.paymentMethod, notes: f.notes || undefined,
    });
  };

  if (!formulations.length) {
    return (
      <ModalShell title="Run Feed Batch" icon={Scale} onClose={onClose}>
        <p className="text-xs text-slate-400">No active formulations — create a recipe first.</p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Run Feed Batch" icon={Scale} onClose={onClose} wide>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Formulation *">
            <select value={f.formulationId} onChange={(e) => set("formulationId", e.target.value)} className={inputCls} data-testid="fm-batch-formula">
              {formulations.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({x.feedType.replace(/_/g, " ")})</option>)}
            </select>
          </Field>
          <Field label="Production date"><input type="date" value={f.productionDate} onChange={(e) => set("productionDate", e.target.value)} className={inputCls} /></Field>
          <Field label="Planned input" hint={`recipe standard: ${form?.batchSizeKg} kg`}>
            <input type="number" min={1} step={1} value={f.plannedInput || (form?.batchSizeKg ?? "")} onChange={(e) => set("plannedInput", e.target.value)} className={inputCls} data-testid="fm-batch-input" />
          </Field>
          <Field label="Input unit">
            <select value={f.inputUnit} onChange={(e) => set("inputUnit", e.target.value)} className={inputCls}>
              {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="border border-slate-700 rounded-xl p-3" data-testid="fm-batch-draws">
          <div className="text-[10px] font-bold text-slate-400 uppercase mb-2">Ingredient draw (kg) — stock is deducted when the batch is saved</div>
          {draws.map((d, idx) => {
            const left = stockLeft(d.inventoryId);
            const short = left + 1e-9 < d.actualKg;
            return (
              <div key={d.formulationItemId} className="grid grid-cols-[1fr_80px_90px] gap-2 items-center py-1.5 border-b border-slate-800 last:border-0">
                <div className="text-xs text-slate-200">{d.ingredientName} <span className="text-[9px] text-slate-500">({d.sharePct}%)</span></div>
                <div className={`text-[10px] text-right ${short ? "text-rose-400 font-bold" : "text-slate-500"}`}>{left.toFixed(0)} kg left{short ? " ⚠" : ""}</div>
                <input type="number" min={0} step={0.1} value={d.actualKg}
                  onChange={(e) => setDraws(draws.map((x, i) => i === idx ? { ...x, actualKg: Number(e.target.value) } : x))}
                  className={inputCls} data-testid={`fm-batch-draw-${idx}`} />
              </div>
            );
          })}
          {anyShort && <div className="mt-2 text-[10px] font-bold text-rose-400">Some ingredients run short — intake them first or reduce the draws.</div>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Actual output (weighed) *">
            <input required type="number" min={0.1} step={0.1} value={f.actualOutput} onChange={(e) => set("actualOutput", e.target.value)} className={inputCls} data-testid="fm-batch-output" />
          </Field>
          <Field label="Output unit">
            <select value={f.outputUnit} onChange={(e) => set("outputUnit", e.target.value)} className={inputCls}>
              {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </Field>
          <Field label="Labour cost (GH₵)" hint="milling-day crew cost — booked once as Mill Operations expense">
            <input type="number" min={0} step="0.01" value={f.labourCostGhs} onChange={(e) => set("labourCostGhs", e.target.value)} className={inputCls} data-testid="fm-batch-labour" />
          </Field>
          <Field label="Overheads (GH₵)" hint="power, fuel, bags — same single Mill Operations booking">
            <input type="number" min={0} step="0.01" value={f.overheadCostGhs} onChange={(e) => set("overheadCostGhs", e.target.value)} className={inputCls} data-testid="fm-batch-overhead" />
          </Field>
          <Field label="Operator"><input value={f.operatorName} onChange={(e) => set("operatorName", e.target.value)} className={inputCls} placeholder="e.g. Kofi Mensah" /></Field>
          <Field label="Ops payment">
            <select value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} className={inputCls}>
              {["CASH", "MOMO", "BANK"].map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
        </div>
        {yieldPreview != null && (
          <div className={`text-[11px] font-bold ${yieldPreview < 90 ? "text-amber-400" : "text-emerald-400"}`}>
            Yield preview: {yieldPreview}% {yieldPreview > 102 ? "(output > input — check your weighing)" : yieldPreview < 90 ? "(high milling loss)" : ""}
          </div>
        )}
        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        <SubmitBar busy={busy || anyShort} label={anyShort ? "Insufficient raw stock" : "Run Batch (QC hold)"} testid="fm-batch-submit" />
      </form>
    </ModalShell>
  );
}
function formulationItemsKey(bom: any[]) { return bom.map((b: any) => b.id).join(","); }

/* ═════════════════════════ QC check ════════════════════════════════════ */

function QcModal({ batches, preset, busy, error, testerName, testerRole, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    batchId: preset?.id || "", stage: preset ? "FINISHED_FEED" : "RAW_MATERIAL",
    sampleRef: "", testName: "", requiredStandard: "", testResult: "", resultValue: "", resultUnit: "",
    passFail: "PASS", moisturePct: "", textureGrade: "", contaminantsNote: "", notes: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      batchId: f.batchId === "" ? null : Number(f.batchId),
      stage: f.stage, sampleRef: f.sampleRef || undefined, testName: f.testName,
      requiredStandard: f.requiredStandard || undefined, testResult: f.testResult || undefined,
      resultValue: f.resultValue === "" ? undefined : Number(f.resultValue), resultUnit: f.resultUnit || undefined,
      passFail: f.passFail, moisturePct: f.moisturePct === "" ? undefined : Number(f.moisturePct),
      textureGrade: f.textureGrade || undefined, contaminantsNote: f.contaminantsNote || undefined,
      notes: f.notes || undefined, testerName, testerRole,
    });
  };
  return (
    <ModalShell title={preset ? `QC Check — ${preset.batchNumber}` : "Log QC Check"} icon={FlaskConical} onClose={onClose}>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Batch (optional)" hint="finished-feed tests gate release">
            <select value={f.batchId} onChange={(e) => set("batchId", e.target.value)} className={inputCls} data-testid="fm-qc-batch">
              <option value="">— Raw material / general —</option>
              {batches.map((b: any) => <option key={b.id} value={b.id}>{b.batchNumber} ({b.status})</option>)}
            </select>
          </Field>
          <Field label="Stage">
            <select value={f.stage} onChange={(e) => set("stage", e.target.value)} className={inputCls} data-testid="fm-qc-stage">
              {QC_STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Test name *"><input required value={f.testName} onChange={(e) => set("testName", e.target.value)} className={inputCls} placeholder="e.g. Moisture content" data-testid="fm-qc-test" /></Field>
          <Field label="Verdict">
            <select value={f.passFail} onChange={(e) => set("passFail", e.target.value)} className={inputCls} data-testid="fm-qc-verdict">
              <option value="PASS">PASS</option><option value="FAIL">FAIL</option>
            </select>
          </Field>
          <Field label="Sample ref"><input value={f.sampleRef} onChange={(e) => set("sampleRef", e.target.value)} className={inputCls} placeholder="e.g. Top of bin 3" /></Field>
          <Field label="Required standard"><input value={f.requiredStandard} onChange={(e) => set("requiredStandard", e.target.value)} className={inputCls} placeholder="e.g. ≤ 13% moisture" /></Field>
          <Field label="Result (text)"><input value={f.testResult} onChange={(e) => set("testResult", e.target.value)} className={inputCls} placeholder="e.g. 11.5% — within spec" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Result value"><input type="number" step={0.01} value={f.resultValue} onChange={(e) => set("resultValue", e.target.value)} className={inputCls} /></Field>
            <Field label="Unit"><input value={f.resultUnit} onChange={(e) => set("resultUnit", e.target.value)} className={inputCls} placeholder="% / mm" /></Field>
          </div>
          <Field label="Moisture %"><input type="number" step={0.1} value={f.moisturePct} onChange={(e) => set("moisturePct", e.target.value)} className={inputCls} data-testid="fm-qc-moisture" /></Field>
          <Field label="Texture">
            <select value={f.textureGrade} onChange={(e) => set("textureGrade", e.target.value)} className={inputCls}>
              <option value="">—</option><option>FINE</option><option>MEDIUM</option><option>COARSE</option>
            </select>
          </Field>
        </div>
        <Field label="Contaminants seen"><input value={f.contaminantsNote} onChange={(e) => set("contaminantsNote", e.target.value)} className={inputCls} placeholder="mould caking, weevils, foreign matter…" /></Field>
        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        {f.passFail === "FAIL" && <div className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">A FAIL fans out a critical management alert. If it is a FINISHED FEED fail and the batch sits on hold, consider rejecting the batch (Owner).</div>}
        <SubmitBar busy={busy} label="Log QC Check" testid="fm-qc-submit" />
      </form>
    </ModalShell>
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
