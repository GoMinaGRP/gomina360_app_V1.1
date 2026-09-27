"use client";

/**
 * Feed-mill engine hook (P1.2) — the shared operational core of BOTH feed
 * mills (Poultry + Fish Farm). The two module components stay separate by
 * design (species vocabularies, insights and consumption targets differ);
 * what they share — data flow, API writes, derived stock math and the
 * release/reject governance gates — lives here exactly once.
 *
 * Parameterized by:
 *   apiBase  — "/api/poultry/feed-mill" | "/api/aquaculture/feed-mill"
 *   feedNoun — "flock" | "pond" (release-gate copy)
 *
 * Everything returns the same names the hand-rolled components used, so the
 * module shells read almost identically to before.
 */
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/currency";
import { fmtKg } from "@/lib/feedUnits";

export type FeedMillConfirm = null | {
  title: string;
  message: string;
  details: any[];
  tone: any;
  label: string;
  run: () => Promise<void>;
};

export interface UseFeedMillOptions {
  apiBase: string;
  bizId?: number | string | null;
  currentCurrency: any;
  canOverride: boolean;
  onChanged: () => void;
  feedNoun?: "flock" | "pond";
  /** extra mill-state keys the species API returns (flocks / ponds / …) */
  extraMillKeys?: string[];
}

export function useFeedMill(opts: UseFeedMillOptions) {
  const { apiBase, bizId, currentCurrency, canOverride, onChanged, feedNoun = "flock", extraMillKeys = [] } = opts;

  const [view, setView] = useState<any>("OVERVIEW");
  const [modal, setModal] = useState<any>(null);
  const [editForm, setEditForm] = useState<any>(null); // formulation being edited
  const [qcBatch, setQcBatch] = useState<any>(null);   // batch context for QC modal
  const [consumeBatch, setConsumeBatch] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<FeedMillConfirm>(null);
  const [toast, setToast] = useState("");

  const [mill, setMill] = useState<any>({
    formulations: [], formulationItems: [], batches: [], batchInputs: [], qcChecks: [],
    rawMaterials: [], finishedFeeds: [], consumption: [], feedLogs: [],
    ...Object.fromEntries(extraMillKeys.map((k) => [k, []])),
  });

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 5000);
  }, []);

  const refresh = useCallback(async () => {
    if (!bizId) return;
    try {
      const res = await fetch(`${apiBase}?businessId=${bizId}`);
      const d = await res.json();
      if (d.success) setMill(d);
      else setErr(d.error || "Failed to load feed mill data.");
    } catch (e: any) { setErr(e.message || "Network error"); }
    finally { setLoading(false); }
  }, [apiBase, bizId]);

  useEffect(() => { refresh(); }, [refresh]);

  /** kg remaining per released/hold batch = stocked − own-mill consumption so far. */
  const remainingOf = useCallback((batch: any) => {
    const used = (mill.consumption || [])
      .filter((c: any) => c.feedBatchId === batch.id)
      .reduce((s: number, c: any) => s + (c.quantityKg || 0), 0);
    return Math.max(0, (batch.stockedQtyKg || 0) - used);
  }, [mill.consumption]);

  const bomOf = useCallback((formId: number) =>
    (mill.formulationItems || []).filter((i: any) => i.formulationId === formId), [mill.formulationItems]);

  const stockLeft = useCallback((inventoryId: number | null) => {
    const hit = (mill.rawMaterials || []).find((r: any) => r.id === inventoryId);
    return hit ? (hit.quantity || 0) : 0;
  }, [mill.rawMaterials]);

  /* ── submit ── */
  const post = async (entity: string, data: any, method = "POST") => {
    setBusy(true); setErr("");
    try {
      // PATCH on this endpoint follows the app's shared convention:
      // { entity, id (top-level), data } — POST uses { entity, data }.
      const payload = method === "PATCH" ? { entity, id: data.id, data } : { entity, data };
      const res = await fetch(apiBase, {
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

  /* ── release / reject ── */
  const hasFinishedPass = useCallback((batchId: number) =>
    (mill.qcChecks || []).some((q: any) => q.batchId === batchId && q.stage === "FINISHED_FEED" && q.passFail === "PASS"),
    [mill.qcChecks]);

  const askRelease = (batch: any) => {
    const passed = hasFinishedPass(batch.id);
    if (!passed && !canOverride) {
      setErr(`Batch ${batch.batchNumber} has no PASSING finished-feed QC check. Run a finished-feed test first (QC tab), or ask the Owner to override.`);
      return;
    }
    setConfirm({
      title: `Release ${batch.batchNumber}`,
      message: passed
        ? `This batch passed finished-feed QC. Releasing makes it available for ${feedNoun} feeding.`
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

  return {
    // state
    view, setView, modal, setModal, editForm, setEditForm, qcBatch, setQcBatch,
    consumeBatch, setConsumeBatch, loading, busy, err, setErr, confirm, setConfirm,
    mill, setMill, toast, flash,
    // data flow
    refresh, post, finishOk,
    // derived
    remainingOf, bomOf, stockLeft, hasFinishedPass,
    // governance
    askRelease, askReject,
  };
}
