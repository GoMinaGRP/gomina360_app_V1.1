"use client";

/**
 * Feed-mill shared entry modals (P1.2).
 *
 * One implementation of the four species-agnostic modals both feed mills
 * shipped as near-copies of: formulation builder, raw-material intake,
 * batch run and QC check. Species differences are injected:
 *
 *   tidPrefix   — "fm" (poultry) / "ffm" (fish) keeps every data-testid
 *                 exactly where its suite expects it
 *   speciesSlot — extra form fields (bird type / ages / ME vs species /
 *                 feed class / stage / pellet target; texture vs float test)
 *   vocab       — feed-type option list, QC stage list, expense category
 *                 label, formulation option label
 *
 * Field keys written into the form state are unchanged, so each module's
 * submit handler and its /api/<module>/feed-mill contract are untouched.
 */
import React, { useEffect, useState } from "react";
import { FlaskConical, Scale, Truck, X } from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { FEED_UNITS, feedToKg, fmtKg } from "@/lib/feedUnits";
import { Field, ModalShell, SubmitBar, UnitPicker, ErrBox, inputCls } from "./parts";

/* ═════════════════════════ FORMULA builder ═════════════════════════════ */

export function FormulaModal({
  existing, bom, rawMaterials, busy, error, canDeactivate, onClose, onSubmit,
  tidPrefix = "fm", initial, speciesFields, namePlaceholder = "e.g. Koforidua Layer Mash 18%", batchSizeHint = "Default mix quantity; adjustable per run",
}: any) {
  const [f, setF] = useState<any>(initial);
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
            <input required value={f.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder={namePlaceholder} data-testid={`${tidPrefix}-form-name`} />
          </Field>
          {speciesFields && speciesFields(f, set)}
          <Field label="Standard batch size (kg)" hint={batchSizeHint}>
            <input type="number" min={1} step={1} value={f.batchSizeKg} onChange={(e) => set("batchSizeKg", Number(e.target.value))} className={inputCls} data-testid={`${tidPrefix}-form-batchsize`} />
          </Field>
          <Field label="CP target %"><input type="number" step={0.1} value={f.cpPctTarget} onChange={(e) => set("cpPctTarget", e.target.value)} className={inputCls} placeholder="e.g. 18" /></Field>
        </div>
        <Field label="Commercial reference price (GH₵/kg)" hint="What equivalent commercial feed sells for. Savings vs your milling cost use this; left blank we fall back to your 90-day commercial purchase average.">
          <input type="number" step="0.01" value={f.commercialRefPriceGhs} onChange={(e) => set("commercialRefPriceGhs", e.target.value)} className={inputCls} placeholder="e.g. 9.80" data-testid={`${tidPrefix}-form-refprice`} />
        </Field>

        <div className="border border-slate-700 rounded-xl p-3 space-y-2" data-testid={`${tidPrefix}-form-items`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Ingredients (% of mix)</span>
            <span className={`text-[10px] font-bold ${Math.abs(shareTotal - 100) < 0.01 ? "text-emerald-400" : "text-rose-400"}`}>Total: {shareTotal.toFixed(1)}%</span>
          </div>
          {items.map((it, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_90px_28px] gap-2 items-center">
              <div>
                <input list={`${tidPrefix}-raw-list`} value={it.ingredientName}
                  onChange={(e) => {
                    const name = e.target.value;
                    const hit = rawMaterials.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
                    setItems(items.map((x, i) => i === idx ? { ...x, ingredientName: name, inventoryId: hit ? hit.id : null } : x));
                  }}
                  className={inputCls} placeholder="Ingredient (e.g. Maize)" data-testid={`${tidPrefix}-form-item-name-${idx}`} />
              </div>
              <input type="number" step="0.1" min="0" max="100" value={it.sharePct}
                onChange={(e) => setItems(items.map((x, i) => i === idx ? { ...x, sharePct: e.target.value } : x))}
                className={inputCls} placeholder="%" data-testid={`${tidPrefix}-form-item-share-${idx}`} />
              <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))}
                className="p-1.5 rounded text-slate-500 hover:text-rose-400"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <datalist id={`${tidPrefix}-raw-list`}>{rawMaterials.map((r: any) => <option key={r.id} value={r.name} />)}</datalist>
          <button type="button" onClick={() => setItems([...items, { inventoryId: null, ingredientName: "", sharePct: "" }])}
            className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300" data-testid={`${tidPrefix}-form-add-item`}>+ add ingredient</button>
        </div>

        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional — formulation rationale, vet advice…" /></Field>
        {existing && canDeactivate && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active (uncheck to retire this formulation — owner authority)
          </label>
        )}
        <SubmitBar busy={busy} label={existing ? "Save Formulation" : "Create Formulation"} testid={`${tidPrefix}-form-submit`} />
      </form>
    </ModalShell>
  );
}

/* ═════════════════════════ INTAKE ══════════════════════════════════════ */

export function IntakeModal({ rawMaterials, busy, error, currency, onClose, onSubmit, expenseCategoryLabel = "Poultry · Feed Raw Material" }: any) {
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
          <Field label="Quantity *"><input required type="number" min="0.1" step="0.1" value={f.qty} onChange={(e) => set("qty", e.target.value)} className={inputCls} data-testid="fm-intake-qty" /></Field>
          <UnitPicker f={f} set={set} />
        </div>
        {qtyKg > 0 && <div className="text-[11px] text-emerald-300 font-semibold">= {fmtKg(qtyKg, { bag: f.unit === "BAG25" ? "BAG25" : "BAG50" })} into mill store</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Cost per ${f.unit === "KG" ? "kg" : f.unit === "BAG25" ? "25-kg bag" : f.unit === "BAG50" ? "50-kg bag" : "tonne"} (GH₵)`}>
            <input type="number" min="0" step="0.01" value={f.unitCostGhsPerUnit} onChange={(e) => set("unitCostGhsPerUnit", e.target.value)} className={inputCls} placeholder="e.g. 420 per bag" data-testid="fm-intake-cost" />
          </Field>
          <Field label="Total paid (GH₵)" hint={total > 0 ? `auto ${formatMoney(total, currency)} — override if negotiated` : "quantity × cost"}>
            <input type="number" min="0" step="0.01" value={f.totalCostGhs} onChange={(e) => set("totalCostGhs", e.target.value)} className={inputCls} placeholder="auto" data-testid="fm-intake-total" />
          </Field>
          <Field label="Supplier"><input value={f.supplierName} onChange={(e) => set("supplierName", e.target.value)} className={inputCls} placeholder="e.g. Olam Grains, Koforidua" data-testid="fm-intake-supplier" /></Field>
          <Field label="Payment">
            <select value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} className={inputCls}>
              {["CASH", "MOMO", "BANK", "CREDIT"].map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} className={inputCls} /></Field>
          <Field label="Low-stock threshold (kg)" hint="optional, new ingredients">
            <input type="number" min="0" step="1" value={f.minStockThreshold} onChange={(e) => set("minStockThreshold", e.target.value)} className={inputCls} placeholder="e.g. 100" />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-xs text-slate-300" data-testid="fm-intake-expense-row">
          <input type="checkbox" className="mt-0.5" checked={f.recordExpense} onChange={(e) => set("recordExpense", e.target.checked)} />
          <span>Book the purchase to Finance once (category <b>{expenseCategoryLabel}</b>). Milling will draw cost from this stock — never re-expensed.</span>
        </label>
        <SubmitBar busy={busy} label="Record Intake" testid="fm-intake-submit" />
      </form>
    </ModalShell>
  );
}

/* ═════════════════════════ BATCH run ═══════════════════════════════════ */

function formulationItemsKey(bom: any[]) { return bom.map((b: any) => b.id).join(","); }

export function BatchModal({ formulations, bomOf, stockLeft, rawMaterials, busy, error, currency, onClose, onSubmit, tidPrefix = "fm", formulationLabel }: any) {
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
            <select value={f.formulationId} onChange={(e) => set("formulationId", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-batch-formula`}>
              {formulations.map((x: any) => <option key={x.id} value={x.id}>{formulationLabel ? formulationLabel(x) : `${x.name} (${x.feedType.replace(/_/g, " ")})`}</option>)}
            </select>
          </Field>
          <Field label="Production date"><input type="date" value={f.productionDate} onChange={(e) => set("productionDate", e.target.value)} className={inputCls} /></Field>
          <Field label="Planned input" hint={`recipe standard: ${form?.batchSizeKg} kg`}>
            <input type="number" min="1" step="1" value={f.plannedInput || (form?.batchSizeKg ?? "")} onChange={(e) => set("plannedInput", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-batch-input`} />
          </Field>
          <Field label="Input unit">
            <select value={f.inputUnit} onChange={(e) => set("inputUnit", e.target.value)} className={inputCls}>
              {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="border border-slate-700 rounded-xl p-3" data-testid={`${tidPrefix}-batch-draws`}>
          <div className="text-[10px] font-bold text-slate-400 uppercase mb-2">Ingredient draw (kg) — stock is deducted when the batch is saved</div>
          {draws.map((d, idx) => {
            const left = stockLeft(d.inventoryId);
            const short = left + 1e-9 < d.actualKg;
            return (
              <div key={d.formulationItemId} className="grid grid-cols-[1fr_80px_90px] gap-2 items-center py-1.5 border-b border-slate-800 last:border-0">
                <div className="text-xs text-slate-200">{d.ingredientName} <span className="text-[9px] text-slate-500">({d.sharePct}%)</span></div>
                <div className={`text-[10px] text-right ${short ? "text-rose-400 font-bold" : "text-slate-500"}`}>{left.toFixed(0)} kg left{short ? " ⚠" : ""}</div>
                <input type="number" min="0" step="0.1" value={d.actualKg}
                  onChange={(e) => setDraws(draws.map((x, i) => i === idx ? { ...x, actualKg: Number(e.target.value) } : x))}
                  className={inputCls} data-testid={`${tidPrefix}-batch-draw-${idx}`} />
              </div>
            );
          })}
          {anyShort && <div className="mt-2 text-[10px] font-bold text-rose-400">Some ingredients run short — intake them first or reduce the draws.</div>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Actual output (weighed) *">
            <input required type="number" min="0.1" step="0.1" value={f.actualOutput} onChange={(e) => set("actualOutput", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-batch-output`} />
          </Field>
          <Field label="Output unit">
            <select value={f.outputUnit} onChange={(e) => set("outputUnit", e.target.value)} className={inputCls}>
              {FEED_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </Field>
          <Field label="Labour cost (GH₵)" hint="milling-day crew cost — booked once as Mill Operations expense">
            <input type="number" min="0" step="0.01" value={f.labourCostGhs} onChange={(e) => set("labourCostGhs", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-batch-labour`} />
          </Field>
          <Field label="Overheads (GH₵)" hint="power, fuel, bags — same single Mill Operations booking">
            <input type="number" min="0" step="0.01" value={f.overheadCostGhs} onChange={(e) => set("overheadCostGhs", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-batch-overhead`} />
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
        <SubmitBar busy={busy || anyShort} label={anyShort ? "Insufficient raw stock" : "Run Batch (QC hold)"} testid={`${tidPrefix}-batch-submit`} />
      </form>
    </ModalShell>
  );
}

/* ═════════════════════════ QC check ════════════════════════════════════ */

export function QcModal({
  batches, preset, busy, error, testerName, testerRole, onClose, onSubmit,
  tidPrefix = "fm", qcStages, extraFields, extraPayload,
}: any) {
  const [f, setF] = useState<any>({
    batchId: preset?.id || "", stage: preset ? "FINISHED_FEED" : "RAW_MATERIAL",
    sampleRef: "", testName: "", requiredStandard: "", testResult: "", resultValue: "", resultUnit: "",
    passFail: "PASS", moisturePct: "", contaminantsNote: "", notes: "",
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
      ...(extraPayload ? extraPayload(f) : {}),
      contaminantsNote: f.contaminantsNote || undefined,
      notes: f.notes || undefined, testerName, testerRole,
    });
  };
  return (
    <ModalShell title={preset ? `QC Check — ${preset.batchNumber}` : "Log QC Check"} icon={FlaskConical} onClose={onClose}>
      <ErrBox error={error} />
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Batch (optional)" hint="finished-feed tests gate release">
            <select value={f.batchId} onChange={(e) => set("batchId", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-qc-batch`}>
              <option value="">— Raw material / general —</option>
              {batches.map((b: any) => <option key={b.id} value={b.id}>{b.batchNumber} ({b.status})</option>)}
            </select>
          </Field>
          <Field label="Stage">
            <select value={f.stage} onChange={(e) => set("stage", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-qc-stage`}>
              {qcStages.map((s: string) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Test name *"><input required value={f.testName} onChange={(e) => set("testName", e.target.value)} className={inputCls} placeholder="e.g. Moisture content" data-testid={`${tidPrefix}-qc-test`} /></Field>
          <Field label="Verdict">
            <select value={f.passFail} onChange={(e) => set("passFail", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-qc-verdict`}>
              <option value="PASS">PASS</option><option value="FAIL">FAIL</option>
            </select>
          </Field>
          <Field label="Sample ref"><input value={f.sampleRef} onChange={(e) => set("sampleRef", e.target.value)} className={inputCls} placeholder="e.g. Top of bin 3" /></Field>
          <Field label="Required standard"><input value={f.requiredStandard} onChange={(e) => set("requiredStandard", e.target.value)} className={inputCls} placeholder="e.g. ≤ 13% moisture" /></Field>
          <Field label="Result (text)"><input value={f.testResult} onChange={(e) => set("testResult", e.target.value)} className={inputCls} placeholder="e.g. 11.5% — within spec" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Result value"><input type="number" step="0.01" value={f.resultValue} onChange={(e) => set("resultValue", e.target.value)} className={inputCls} /></Field>
            <Field label="Unit"><input value={f.resultUnit} onChange={(e) => set("resultUnit", e.target.value)} className={inputCls} placeholder="% / mm" /></Field>
          </div>
          <Field label="Moisture %"><input type="number" step="0.1" value={f.moisturePct} onChange={(e) => set("moisturePct", e.target.value)} className={inputCls} data-testid={`${tidPrefix}-qc-moisture`} /></Field>
          {extraFields && extraFields(f, set)}
        </div>
        <Field label="Contaminants seen"><input value={f.contaminantsNote} onChange={(e) => set("contaminantsNote", e.target.value)} className={inputCls} placeholder="mould caking, weevils, foreign matter…" /></Field>
        <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} placeholder="Optional" /></Field>
        {f.passFail === "FAIL" && <div className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">A FAIL fans out a critical management alert. If it is a FINISHED FEED fail and the batch sits on hold, consider rejecting the batch (Owner).</div>}
        <SubmitBar busy={busy} label="Log QC Check" testid={`${tidPrefix}-qc-submit`} />
      </form>
    </ModalShell>
  );
}
