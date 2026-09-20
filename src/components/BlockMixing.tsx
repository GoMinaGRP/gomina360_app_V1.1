"use client";

/**
 * Block Mixing — concrete mix formulation & mixer-run management.
 *
 * Sub-tab of the Block Factory ("MIXING"). Reuses the module's own
 * machinery end-to-end — nothing here duplicates it:
 *   recipes (MIX_FORMULATION) → mixer runs (MIX: stock-out "Block Raw
 *   Materials", one optional BLOCK_MIX_OPS expense booked ONCE, batch on
 *   QC_HOLD) → release gate (existing QC_CHECK at stage MIXING on the
 *   MXB-… batch number, or OWNER/canManageRecords override with note) →
 *   consumption when a PRODUCTION log names the released batch (1:1);
 *   MIX_REJECT (owner-only) recovers dry draws back to stock.
 *
 * Raw materials come in via the module's existing RESTOCK path (supplier
 * name now links the org-wide Suppliers ledger). Finance invariant: raw
 * material cost is expensed once at RESTOCK; mixer ops once per batch;
 * production never re-books money.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  FlaskConical, Plus, X, Loader2, ShieldCheck, Ban, Unlock,
  AlertTriangle, CheckCircle2, Boxes, Scale, Cog,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import ConfirmActionModal from "./ConfirmActionModal";

interface Props {
  currentUser: any;
  businessInfo: any;
  currentCurrency: CurrencyCode;
  blockTypes: any[];
  onChanged: () => void; // bubble a global refresh after writes
}

const inputCls = "w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:border-emerald-500/60 focus:outline-none";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-slate-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[9px] text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

const statusPill = (s: string) =>
  s === "RELEASED" ? "bg-emerald-500/20 text-emerald-300"
  : s === "QC_HOLD" || s === "MIXING" ? "bg-amber-500/20 text-amber-300"
  : s === "CONSUMED" ? "bg-sky-500/20 text-sky-300"
  : s === "REJECTED" ? "bg-rose-500/20 text-rose-300" : "bg-slate-700 text-slate-300";

export default function BlockMixing({ currentUser, businessInfo, currentCurrency, blockTypes, onChanged }: Props) {
  const bizId = businessInfo?.id;
  const branchCode = businessInfo?.code;
  const branchName = businessInfo?.name;
  const role = currentUser?.role;
  const canOverride = role === "OWNER" || currentUser?.canManageRecords === true;

  const [mix, setMix] = useState<any>({ mixFormulations: [], mixFormulationItems: [], mixBatches: [], mixBatchInputs: [], mixRawMaterials: [], qcChecks: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<null | "RECIPE" | "MIX">(null);
  const [editRecipe, setEditRecipe] = useState<any>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; details: any[]; tone: any; label: string; run: () => Promise<void> }>(null);

  const refresh = async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`/api/block-factory?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) setMix(d);
      else setErr(d.error || "Failed to load mixing data.");
    } catch (e: any) { setErr(e.message || "Network error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, [bizId]);

  const post = async (entity: string, data: any, id?: number) => {
    setBusy(true); setErr("");
    try {
      const method = id != null ? "PATCH" : "POST";
      const payload = id != null ? { entity, id, data } : { entity, data };
      const res = await fetch("/api/block-factory", {
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
    setModal(null); setEditRecipe(null);
    setToast(msg); setTimeout(() => setToast(""), 5000);
    await refresh();
    onChanged();
  };

  const { mixFormulations, mixFormulationItems, mixBatches, mixBatchInputs, mixRawMaterials, qcChecks } = mix;

  const bomOf = (formId: number) => mixFormulationItems.filter((i: any) => i.formulationId === formId);
  const hasMixingPass = (batchNumber: string) =>
    (qcChecks || []).some((q: any) => q.batchId === batchNumber && q.stage === "MIXING" && q.passFail === "PASS");
  const inputsOf = (batchId: number) => mixBatchInputs.filter((i: any) => i.mixBatchId === batchId);

  const releasedCount = mixBatches.filter((b: any) => b.status === "RELEASED").length;
  const holdCount = mixBatches.filter((b: any) => b.status === "QC_HOLD" || b.status === "MIXING").length;
  const consumedCount = mixBatches.filter((b: any) => b.status === "CONSUMED").length;
  const totalMixedKg = mixBatches.filter((b: any) => b.status !== "REJECTED").reduce((s: number, b: any) => s + (b.actualOutputKg || 0), 0);

  /* ── release / reject ── */
  const askRelease = (batch: any) => {
    const passed = hasMixingPass(batch.mixBatchNumber);
    if (!passed && !canOverride) {
      setErr(`Mix batch ${batch.mixBatchNumber} has no PASSING MIXING-stage QC check. Run it in the QC tab (stage MIXING, batch ${batch.mixBatchNumber}), or ask the Owner to override.`);
      return;
    }
    setConfirm({
      title: `Release ${batch.mixBatchNumber}`,
      message: passed
        ? "This mix passed its MIXING-stage QC. Releasing makes it selectable on the Production form."
        : "⚠ OVERRIDE: this mix has NO passing MIXING-stage QC check. As Owner/records manager you may release it with a justification that stays in the audit trail.",
      details: [
        { label: "Mix batch", value: batch.mixBatchNumber },
        { label: "Output", value: `${(batch.actualOutputKg || 0).toFixed(0)} kg of ${batch.blockType} mix` },
        { label: "Cost", value: `${formatMoney(batch.costPerKgGhs, currentCurrency)}/kg · ${formatMoney(batch.totalCostGhs, currentCurrency)}` },
        { label: "QC basis", value: passed ? "MIXING-stage PASS" : "OWNER OVERRIDE (note required)" },
      ],
      tone: passed ? "emerald" : "amber",
      label: passed ? "Release Mix" : "Override & Release",
      run: async () => {
        let note = "";
        if (!passed) {
          note = window.prompt("Override justification (audited):")?.trim() || "";
          if (!note) { setErr("Override release needs a justification note."); return; }
        }
        const ok = await post("MIX_RELEASE", { businessId: bizId, branchCode, mixBatchId: batch.id, note });
        if (ok) await finishOk(`Mix ${batch.mixBatchNumber} released — ready for molding.`);
      },
    });
  };

  const askReject = (batch: any) => {
    if (!canOverride) { setErr("Only the Owner (or a records-authorized manager) may reject a mix batch."); return; }
    setConfirm({
      title: `Reject ${batch.mixBatchNumber}?`,
      message: "Rejecting kills the batch. Dry draws (sand/stone) are recovered back to stock by default — clearly state in the reason if the wet mix was discarded (then recovery is skipped).",
      details: [
        { label: "Mix batch", value: batch.mixBatchNumber },
        { label: "Raw draw", value: `${(batch.actualInputKg || 0).toFixed(0)} kg` },
        { label: "Derived cost", value: formatMoney(batch.totalCostGhs, currentCurrency) },
      ],
      tone: "rose",
      label: "Reject Mix",
      run: async () => {
        const reason = window.prompt("Reason for rejection (audited). Start with 'DISCARDED' if the wet mix is dumped:")?.trim() || "";
        if (!reason) { setErr("Rejection needs a reason."); return; }
        const discarded = reason.toUpperCase().startsWith("DISCARDED");
        const ok = await post("MIX_REJECT", {
          businessId: bizId, branchCode, mixBatchId: batch.id, reason,
          recoverMaterials: discarded ? false : undefined,
        });
        if (ok) await finishOk(`Mix ${batch.mixBatchNumber} rejected${ok.recoveredKg ? `; ${ok.recoveredKg} kg recovered to stock` : ""}.`);
      },
    });
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-slate-400 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading mixing data…</div>;
  }

  return (
    <div className="space-y-4" data-testid="bmx-mixing">
      {toast && <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 px-4 py-2.5 rounded-xl text-xs font-bold">{toast}</div>}
      {err && <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 px-4 py-2.5 rounded-xl text-xs flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {err}</div>}

      {/* flow strip */}
      <div className="bg-slate-800/70 border border-slate-700/70 rounded-xl px-4 py-3 text-[11px] text-slate-400">
        <b className="text-slate-200">Mixer flow:</b> restock raw materials (Inventory tab) → 1) build a <b>recipe</b> → 2) <b>run the mixer</b> → 3) pass the <b>MIXING-stage QC</b> (QC tab, batch MXB-…) and release → 4) pick the released mix on the <b>Production</b> entry form. Money: raw materials are expensed once at restock; mixer labour/overhead books once as BLOCK_MIX_OPS; molding never re-books cost.
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid="bmx-stat-recipes"><div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5 text-emerald-400" /> Recipes</div><div className="text-lg font-black text-white mt-1">{mixFormulations.length}</div><div className="text-[10px] text-slate-500">{mixFormulations.filter((f: any) => f.active !== false).length} active</div></div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid="bmx-stat-hold"><div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> On QC hold</div><div className="text-lg font-black text-amber-300 mt-1">{holdCount}</div><div className="text-[10px] text-slate-500">await MIXING QC</div></div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid="bmx-stat-released"><div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5"><Unlock className="w-3.5 h-3.5 text-emerald-400" /> Released</div><div className="text-lg font-black text-emerald-300 mt-1">{releasedCount}</div><div className="text-[10px] text-slate-500">ready to mold · consumed {consumedCount}</div></div>
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-4" data-testid="bmx-stat-kg"><div className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5"><Scale className="w-3.5 h-3.5 text-sky-400" /> Mixed (all time)</div><div className="text-lg font-black text-sky-300 mt-1">{totalMixedKg.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg</div><div className="text-[10px] text-slate-500">across {mixBatches.length} batches</div></div>
      </div>

      {/* recipes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-white flex items-center gap-2"><FlaskConical className="w-4 h-4 text-emerald-400" /> Mix Formulations</h3>
          <button onClick={() => { setEditRecipe(null); setModal("RECIPE"); }} data-testid="bmx-btn-new-recipe"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30">
            <Plus className="w-3.5 h-3.5" /> New Recipe
          </button>
        </div>
        {mixFormulations.length === 0 ? (
          <div className="bg-slate-800/90 border border-slate-700/80 rounded-xl p-8 text-center text-slate-500 text-xs" data-testid="bmx-empty-recipes">
            No mix recipes yet. Create one — e.g. <i>"6in Hollow — Sandcrete 1:8"</i> binding cement + sharp sand to the <b>6-INCH-HOLLOW</b> block type.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mixFormulations.map((f: any) => (
              <div key={f.id} className={`bg-slate-800/90 border rounded-2xl p-4 ${f.active === false ? "border-slate-700/60 opacity-60" : "border-slate-700/80"}`} data-testid={`bmx-recipe-${f.formulationNo}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-[10px] text-purple-300">{f.formulationNo}</div>
                    <div className="text-sm font-bold text-white">{f.name}</div>
                    <div className="text-[10px] text-slate-400">{f.blockType.replace(/-/g, " ")}{f.waterCementRatio ? ` · w/c ${f.waterCementRatio}` : ""}{f.designNote ? ` · ${f.designNote}` : ""}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${f.active === false ? "bg-slate-700 text-slate-400" : "bg-emerald-500/20 text-emerald-300"}`}>{f.active === false ? "INACTIVE" : "ACTIVE"}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {bomOf(f.id).sort((a: any, b: any) => (a.sequence || 0) - (b.sequence || 0)).map((it: any) => {
                    const inv = mixRawMaterials.find((r: any) => r.id === it.inventoryId);
                    return (
                      <div key={it.id} className="flex justify-between text-[11px] text-slate-300">
                        <span>{it.ingredientName}</span>
                        <span className="font-mono">{it.sharePct}%{inv ? ` · ${(inv.quantity || 0).toFixed(0)} kg in stock` : ""}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="text-[10px] text-slate-500">std batch {f.batchSizeKg} kg{f.lastCostPerKgGhs ? ` · last ${formatMoney(f.lastCostPerKgGhs, currentCurrency)}/kg mix` : ""}</div>
                  <div className="flex gap-2">
                    <button onClick={() => { setEditRecipe(f); setModal("RECIPE"); }} data-testid={`bmx-edit-${f.id}`}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-700 text-slate-200 text-[10px] font-bold hover:bg-slate-600">Edit</button>
                    <button onClick={() => { setEditRecipe(f); setModal("MIX"); }} disabled={f.active === false} data-testid={`bmx-run-${f.id}`}
                      className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 text-[10px] font-bold hover:bg-emerald-500/30 disabled:opacity-40"><Cog className="w-3 h-3 inline -mt-0.5 mr-1" />Run Mixer</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* batches */}
      <div>
        <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-2"><Boxes className="w-4 h-4 text-amber-400" /> Mixer Batches</h3>
        <div className="overflow-x-auto bg-slate-800/90 border border-slate-700/80 rounded-2xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
              <tr>
                <th className="px-4 py-3">Batch</th><th className="px-4 py-3">Recipe</th><th className="px-4 py-3">For</th>
                <th className="px-4 py-3 text-right">Mixed</th><th className="px-4 py-3 text-right">Cost/kg</th>
                <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {mixBatches.map((b: any) => (
                <tr key={b.id} className="hover:bg-slate-700/40" data-testid={`bmx-batch-${b.mixBatchNumber}`}>
                  <td className="px-4 py-3">
                    <div className="font-mono text-[10px] text-purple-300">{b.mixBatchNumber}</div>
                    <div className="text-[10px] text-slate-500">{b.productionDate}{b.operatorName ? ` · ${b.operatorName}` : ""}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300 max-w-[140px] truncate">{b.formulationName}</td>
                  <td className="px-4 py-3 text-slate-300">{b.blockType.replace(/-/g, " ")}</td>
                  <td className="px-4 py-3 text-right font-bold text-white">{(b.actualOutputKg || 0).toFixed(0)} kg
                    {b.waterLitresUsed != null && <div className="text-[9px] font-normal text-slate-500">+{b.waterLitresUsed} L water{b.slumpMm != null ? ` · slump ${b.slumpMm}mm` : ""}</div>}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300">{formatMoney(b.costPerKgGhs, currentCurrency)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${statusPill(b.status)}`}>{b.status}</span>
                    {b.status === "CONSUMED" && b.consumedProductionBatch && <div className="text-[9px] text-slate-500 mt-0.5">→ {b.consumedProductionBatch}</div>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(b.status === "QC_HOLD" || b.status === "MIXING") && (
                      <div className="inline-flex gap-1.5">
                        <button onClick={() => askRelease(b)} title={hasMixingPass(b.mixBatchNumber) ? "QC passed — release" : "No MIXING PASS yet (owner may override)"}
                          className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${hasMixingPass(b.mixBatchNumber) ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30" : "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"}`}
                          data-testid={`bmx-release-${b.id}`}>
                          {hasMixingPass(b.mixBatchNumber) ? <CheckCircle2 className="w-3 h-3 inline -mt-0.5 mr-0.5" /> : <Unlock className="w-3 h-3 inline -mt-0.5 mr-0.5" />}
                          Release
                        </button>
                        <button onClick={() => askReject(b)} className="px-2.5 py-1.5 rounded-lg bg-rose-500/10 text-rose-300 text-[10px] font-bold hover:bg-rose-500/20" data-testid={`bmx-reject-${b.id}`}>
                          <Ban className="w-3 h-3 inline -mt-0.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {mixBatches.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500" data-testid="bmx-empty-batches">No mixer runs yet — create a recipe above and press <b>Run Mixer</b>.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* recipe modal */}
      {modal === "RECIPE" && (
        <RecipeModal
          existing={editRecipe}
          bom={editRecipe ? bomOf(editRecipe.id) : []}
          blockTypes={blockTypes}
          rawMaterials={mixRawMaterials}
          busy={busy} error={err} canDeactivate={canOverride}
          onClose={() => { setModal(null); setEditRecipe(null); setErr(""); }}
          onSubmit={async (f: any) => {
            const payload = { ...f, businessId: bizId, branchCode, branchName };
            const ok = editRecipe
              ? await post("MIX_FORMULATION", payload, editRecipe.id)
              : await post("MIX_FORMULATION", payload);
            if (ok) await finishOk(editRecipe ? `Recipe ${editRecipe.formulationNo} updated.` : `Recipe ${ok.item.formulationNo} created.`);
          }}
        />
      )}

      {/* mixer-run modal */}
      {modal === "MIX" && editRecipe && (
        <MixerModal
          formulation={editRecipe}
          bom={bomOf(editRecipe.id)}
          rawMaterials={mixRawMaterials}
          busy={busy} error={err}
          onClose={() => { setModal(null); setEditRecipe(null); setErr(""); }}
          onSubmit={async (f: any) => {
            const ok = await post("MIX", { ...f, businessId: bizId, branchCode, branchName, formulationId: editRecipe.id });
            if (ok) await finishOk(`Mix batch ${ok.item.mixBatchNumber} on QC hold — run the MIXING QC (QC tab) to release it.`);
          }}
        />
      )}

      <ConfirmActionModal
        open={!!confirm}
        title={confirm?.title || ""} message={confirm?.message || ""} details={confirm?.details}
        tone={confirm?.tone} confirmLabel={confirm?.label}
        onCancel={() => setConfirm(null)} onConfirm={async () => { const c = confirm; if (!c) return; setConfirm(null); await c.run(); }}
      />
    </div>
  );
}

/* ═══════════════════════ modals ═══════════════════════ */

function ModalShell({ title, icon: Icon, onClose, children, wide }: any) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`bg-slate-800 border border-slate-700 rounded-2xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto p-5`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">{Icon && <Icon className="w-4 h-4 text-emerald-400" />} {title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const SubmitBar = ({ busy, label, testid }: any) => (
  <button disabled={busy} type="submit" data-testid={testid}
    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 text-slate-900 text-xs font-black hover:bg-emerald-400 disabled:opacity-50">
    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
    {busy ? "Saving…" : label}
  </button>
);
const ErrBox = ({ error }: any) => error ? <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs mb-3">{error}</div> : null;

function RecipeModal({ existing, bom, blockTypes, rawMaterials, busy, error, canDeactivate, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>(existing ? {
    name: existing.name, blockType: existing.blockType, designNote: existing.designNote || "",
    waterCementRatio: existing.waterCementRatio ?? "", batchSizeKg: existing.batchSizeKg,
    notes: existing.notes || "", active: existing.active !== false,
  } : {
    name: "", blockType: "", designNote: "", waterCementRatio: "", batchSizeKg: 800, notes: "", active: true,
  });
  const [items, setItems] = useState<any[]>(bom?.length
    ? bom.map((b: any) => ({ inventoryId: b.inventoryId, ingredientName: b.ingredientName, sharePct: b.sharePct }))
    : [{ inventoryId: null, ingredientName: "", sharePct: "" }]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const shareTotal = items.reduce((s, i) => s + (Number(i.sharePct) || 0), 0);

  return (
    <ModalShell title={existing ? `Edit ${existing.formulationNo}` : "New Mix Recipe"} icon={FlaskConical} onClose={onClose} wide>
      <ErrBox error={error} />
      <form onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...f, items: items.filter((i) => i.ingredientName && Number(i.sharePct) > 0) });
      }} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Recipe name *">
            <input required value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder='e.g. 6in Hollow — Sandcrete 1:8' data-testid="bmx-form-name" />
          </Field>
          <Field label="Block type *" hint="The master-list type this mix produces">
            <select required value={f.blockType} onChange={(e) => set("blockType", e.target.value)} className={inputCls} data-testid="bmx-form-blocktype" disabled={!!existing}>
              <option value="">— choose —</option>
              {blockTypes.map((t: any) => <option key={t.id} value={t.typeKey}>{t.name} ({t.typeKey})</option>)}
            </select>
          </Field>
          <Field label="Design note"><input value={f.designNote} onChange={(e) => set("designNote", e.target.value)} className={inputCls} placeholder="e.g. 1 part cement : 8 parts sharp sand" /></Field>
          <Field label="Water/cement ratio" hint="Sandcrete 0.50–0.65 typical"><input type="number" step={0.01} min={0.2} max={1.5} value={f.waterCementRatio} onChange={(e) => set("waterCementRatio", e.target.value)} className={inputCls} placeholder="e.g. 0.55" /></Field>
          <Field label="Standard batch (kg)" hint="Materials per mixer run, water excluded">
            <input type="number" min={50} step={10} value={f.batchSizeKg} onChange={(e) => set("batchSizeKg", Number(e.target.value))} className={inputCls} data-testid="bmx-form-batchsize" />
          </Field>
        </div>

        <div className="border border-slate-700 rounded-xl p-3 space-y-2" data-testid="bmx-form-items">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Ingredients (% of mix)</span>
            <span className={`text-[10px] font-bold ${Math.abs(shareTotal - 100) < 0.01 ? "text-emerald-400" : "text-rose-400"}`}>Total: {shareTotal.toFixed(1)}%</span>
          </div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_90px_28px] gap-2 items-center">
              <input list="bmx-raw-list" value={it.ingredientName}
                onChange={(e) => {
                  const name = e.target.value;
                  const hit = rawMaterials.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
                  setItems(items.map((x, i) => i === idx ? { ...x, ingredientName: name, inventoryId: hit ? hit.id : null } : x));
                }}
                className={inputCls} placeholder="Ingredient (e.g. Cement, Sharp Sand)" data-testid={`bmx-form-item-name-${idx}`} />
              <input type="number" step="0.1" min={0} max={100} value={it.sharePct}
                onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, sharePct: e.target.value } : x))}
                className={inputCls} placeholder="%" data-testid={`bmx-form-item-share-${idx}`} />
              <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))}
                className="p-1.5 rounded text-slate-500 hover:text-rose-400"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <datalist id="bmx-raw-list">{rawMaterials.map((r: any) => <option key={r.id} value={r.name} />)}</datalist>
          <button type="button" onClick={() => setItems([...items, { inventoryId: null, ingredientName: "", sharePct: "" }])}
            className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300" data-testid="bmx-form-add-item">+ add ingredient</button>
        </div>

        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        {existing && canDeactivate && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (uncheck to retire — owner authority)
          </label>
        )}
        <SubmitBar busy={busy} label={existing ? "Save Recipe" : "Create Recipe"} testid="bmx-form-submit" />
      </form>
    </ModalShell>
  );
}

function MixerModal({ formulation, bom, rawMaterials, busy, error, onClose, onSubmit }: any) {
  const [f, setF] = useState<any>({
    plannedInputKg: formulation.batchSizeKg, waterLitresUsed: "", slumpMm: "",
    labourCostGhs: "", overheadCostGhs: "", paymentMethod: "CASH",
    operatorName: "", productionDate: new Date().toISOString().split("T")[0], notes: "",
  });
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const plan = bom.map((l: any) => {
    const inv = rawMaterials.find((r: any) => r.id === l.inventoryId);
    const kg = Math.round(((l.sharePct || 0) / 100) * (Number(f.plannedInputKg) || 0) * 100) / 100;
    const have = inv ? inv.quantity || 0 : 0;
    return { ...l, kg, have, short: kg > have + 1e-9 };
  });
  const anyShort = plan.some((p: any) => p.short);
  const cementLine = plan.find((p: any) => /cement/i.test(p.ingredientName));
  const wcExpected = cementLine && formulation.waterCementRatio && cementLine.kg > 0
    ? Math.round(cementLine.kg * Number(formulation.waterCementRatio))
    : null;

  return (
    <ModalShell title={`Run Mixer — ${formulation.name}`} icon={Cog} onClose={onClose} wide>
      <ErrBox error={error} />
      <form onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          plannedInputKg: Number(f.plannedInputKg),
          waterLitresUsed: f.waterLitresUsed === "" ? undefined : Number(f.waterLitresUsed),
          slumpMm: f.slumpMm === "" ? undefined : Number(f.slumpMm),
          labourCostGhs: f.labourCostGhs === "" ? undefined : Number(f.labourCostGhs),
          overheadCostGhs: f.overheadCostGhs === "" ? undefined : Number(f.overheadCostGhs),
          paymentMethod: f.paymentMethod,
          operatorName: f.operatorName || undefined,
          productionDate: f.productionDate, notes: f.notes || undefined,
        });
      }} className="space-y-3">
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-3 text-[11px] text-slate-400">
          Draw plan for <b className="text-white">{f.plannedInputKg || 0} kg</b> of materials — stock is deducted now and the batch goes straight onto QC hold (release after the MIXING-stage check).
        </div>
        <Field label="Materials to draw (kg)">
          <input required type="number" min={50} step={10} value={f.plannedInputKg} onChange={(e) => set("plannedInputKg", Number(e.target.value))} className={inputCls} data-testid="bmx-mix-kg" />
        </Field>
        <div className="border border-slate-700 rounded-xl divide-y divide-slate-700/60">
          {plan.map((p: any) => (
            <div key={p.id} className={`px-3 py-2 flex justify-between text-[11px] ${p.short ? "text-rose-300" : "text-slate-300"}`}>
              <span>{p.ingredientName} <span className="text-slate-500">({p.sharePct}%)</span></span>
              <span className="font-mono">{p.kg.toFixed(1)} kg{p.short ? ` — only ${p.have.toFixed(0)} in stock` : ""}</span>
            </div>
          ))}
        </div>
        {anyShort && <div className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">Stock is short — restock the flagged ingredients in the Inventory tab first (server blocks the run otherwise).</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Water added (L)" hint={wcExpected ? `≈ ${wcExpected} L for ${formulation.waterCementRatio} w/c` : "measured at drum"}>
            <input type="number" step={1} min={0} value={f.waterLitresUsed} onChange={(e) => set("waterLitresUsed", e.target.value)} className={inputCls} data-testid="bmx-mix-water" />
          </Field>
          <Field label="Slump at drum (mm)"><input type="number" step={5} min={0} max={250} value={f.slumpMm} onChange={(e) => set("slumpMm", e.target.value)} className={inputCls} placeholder="e.g. 30–75" data-testid="bmx-mix-slump" /></Field>
          <Field label="Labour cost (GH₵)" hint="books once as BLOCK_MIX_OPS"><input type="number" step={0.01} min={0} value={f.labourCostGhs} onChange={(e) => set("labourCostGhs", e.target.value)} className={inputCls} data-testid="bmx-mix-labour" /></Field>
          <Field label="Overhead (GH₵)"><input type="number" step={0.01} min={0} value={f.overheadCostGhs} onChange={(e) => set("overheadCostGhs", e.target.value)} className={inputCls} data-testid="bmx-mix-overhead" /></Field>
          <Field label="Payment method">
            <select value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} className={inputCls}>
              <option value="CASH">CASH</option><option value="MOMO">MOMO</option><option value="BANK_TRANSFER">BANK TRANSFER</option>
            </select>
          </Field>
          <Field label="Operator"><input value={f.operatorName} onChange={(e) => set("operatorName", e.target.value)} className={inputCls} placeholder="e.g. Kojo (mixer lead)" /></Field>
          <Field label="Date"><input type="date" value={f.productionDate} onChange={(e) => set("productionDate", e.target.value)} className={inputCls} /></Field>
          <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        </div>
        <SubmitBar busy={busy} label={anyShort ? "Run Mixer (stock short — will fail)" : "Run Mixer → QC Hold"} testid="bmx-mix-submit" />
      </form>
    </ModalShell>
  );
}
