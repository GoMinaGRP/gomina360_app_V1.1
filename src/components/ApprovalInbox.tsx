"use client";
/**
 * R1 Approvals UI — embedded in the Action Center.
 *
 * Three zones, all fed by GET /api/approvals:
 *  1. "Awaiting your decision" — the approver inbox (managers/owners):
 *     one card per pending request with Approve / Reject (+ reason).
 *  2. "My requests" — everything I submitted and its current state
 *     (everyone, workers included — a gated expense is theirs to follow).
 *  3. "Approval policies" (OWNER / GENERAL_MANAGER) — create, pause and
 *     remove the gate rules. With zero active rules the app behaves exactly
 *     as it did before approvals existed; rules are opt-in per organization.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, ShieldCheck, Clock, Trash2, Plus, ChevronDown, ChevronRight, Receipt, X } from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { MAX_SOURCE_IMAGE_BYTES, optimizedDataUrls } from "@/lib/imageOptimize";

const ACTION_LABEL: Record<string, string> = {
  EXPENSE: "Expense",
  PURCHASE_ORDER: "Purchase order",
  PURCHASE_REQUISITION: "Requisition",
  INVENTORY_ADJUSTMENT: "Stock adjustment",
  DISCOUNT: "Discount",
  DELETION: "Deletion",
  DATA_EXPORT: "Data export",
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  APPROVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  REJECTED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  CANCELLED: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

function money(n: number | null | undefined, currency: CurrencyCode): string {
  return n != null && Number(n) > 0 ? formatMoney(Number(n), currency) : "";
}

export default function ApprovalInbox({
  currentUser,
  businesses,
  currentCurrency = "GHS",
  focusRequestId = null,
  onFocusHandled,
  onChanged,
}: {
  currentUser: any;
  businesses: any[];
  currentCurrency?: CurrencyCode;
  focusRequestId?: number | null;
  onFocusHandled?: () => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reasonFor, setReasonFor] = useState<number | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [showPolicies, setShowPolicies] = useState(false);
  const [policySaved, setPolicySaved] = useState(false);
  const [form, setForm] = useState({ action: "EXPENSE", scopeBusinessId: "", threshold: "", approverRole: "OWNER" });

  // Disburse / Post receipt state for approved pre-approvals
  const [postModalRequest, setPostModalRequest] = useState<any | null>(null);
  const [postPaymentMethod, setPostPaymentMethod] = useState("CASH");
  const [postDate, setPostDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [postReceipts, setPostReceipts] = useState<string[]>([]);
  const [postBusy, setPostBusy] = useState(false);
  const [postSuccessNotice, setPostSuccessNotice] = useState<string | null>(null);

  const role = String(currentUser?.role || "").toUpperCase();
  const canManagePolicies = role === "OWNER" || role === "GENERAL_MANAGER";
  const bizName = useMemo(
    () => new Map((businesses || []).map((b: any) => [Number(b.id), b.name || b.code])),
    [businesses],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not load approvals");
      setData(body);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load approvals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-linking: scroll and highlight focused approval request
  useEffect(() => {
    if (!focusRequestId || loading || !data) return;
    const reqIdNum = Number(focusRequestId);
    const inboxItem = (data.inbox || []).find(
      (r: any) => Number(r.id) === reqIdNum || Number(r.targetId) === reqIdNum
    );
    const myItem = (data.myRequests || []).find(
      (r: any) => Number(r.id) === reqIdNum || Number(r.targetId) === reqIdNum
    );
    const target = inboxItem || myItem;
    if (target) {
      const elId = inboxItem ? `approval-card-${target.id}` : `my-request-${target.id}`;
      const timer = setTimeout(() => {
        const el = document.getElementById(elId) || document.querySelector(`[data-testid="${elId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("ring-2", "ring-indigo-500", "shadow-indigo-500/40");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-indigo-500", "shadow-indigo-500/40");
          }, 3500);
        }
        onFocusHandled?.();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [focusRequestId, loading, data, onFocusHandled]);

  /** Receipts attached while posting an approved expense — optimized in the
   *  browser (≤1800px, q0.82) so the printed figures stay readable at a
   *  fraction of the original capture weight. */
  const handlePostReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const picked = Array.from(files).filter((f) => f.size <= MAX_SOURCE_IMAGE_BYTES);
    if (picked.length !== files.length) alert("Some files were too large to process (max 20MB each).");
    if (picked.length === 0) {
      e.target.value = "";
      return;
    }
    try {
      const urls = await optimizedDataUrls(picked, "receipt");
      setPostReceipts((prev) => [...prev, ...urls]);
    } catch {
      alert("One or more receipts could not be processed — try another image.");
    } finally {
      e.target.value = "";
    }
  };

  const submitPostApprovedExpense = async () => {
    if (!postModalRequest) return;
    setPostBusy(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: Number(postModalRequest.targetId),
          op: "MARK_SPENT",
          paymentMethod: postPaymentMethod,
          date: postDate,
          receiptImages: postReceipts.length > 0 ? postReceipts : null,
          receiptImage: postReceipts[0] || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to post expense to Finance.");

      setPostSuccessNotice("Expense successfully disbursed and posted to Finance ledger!");
      setTimeout(() => {
        setPostModalRequest(null);
        setPostReceipts([]);
        setPostSuccessNotice(null);
        setPostBusy(false);
        load();
        onChanged?.();
      }, 1200);
    } catch (err: any) {
      alert(err.message || "Failed to post expense.");
      setPostBusy(false);
    }
  };

  const decide = async (requestId: number, decision: "APPROVE" | "REJECT", reason?: string) => {
    setBusyId(requestId);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "DECIDE", requestId, decision, reason: reason || null }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Decision failed");
      setReasonFor(null);
      setReasonText("");
      await load();
      onChanged?.();
    } catch (e: any) {
      alert(e?.message || "Decision failed");
    } finally {
      setBusyId(null);
    }
  };

  const cancelMine = async (requestId: number) => {
    setBusyId(requestId);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "CANCEL", requestId }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not withdraw");
      await load();
      onChanged?.();
    } catch (e: any) {
      alert(e?.message || "Could not withdraw");
    } finally {
      setBusyId(null);
    }
  };

  const createPolicy = async () => {
    const isDiscount = form.action === "DISCOUNT";
    const payload: any = {
      op: "POLICY_CREATE",
      action: form.action,
      approverRole: form.approverRole,
      scopeBusinessId: form.scopeBusinessId ? Number(form.scopeBusinessId) : null,
    };
    if (form.threshold.trim() !== "") {
      payload[isDiscount ? "thresholdPercent" : "thresholdAmountGhs"] = Number(form.threshold);
    }
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not save the policy");
      setPolicySaved(true);
      setTimeout(() => setPolicySaved(false), 2200);
      setForm({ ...form, threshold: "" });
      await load();
    } catch (e: any) {
      alert(e?.message || "Could not save the policy");
    }
  };

  const togglePolicy = async (policyId: number, isActive: boolean) => {
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "POLICY_UPDATE", policyId, isActive }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not update");
      await load();
    } catch (e: any) {
      alert(e?.message || "Could not update");
    }
  };

  const deletePolicy = async (policyId: number) => {
    if (!confirm("Remove this approval gate permanently?")) return;
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "POLICY_DELETE", policyId }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || "Could not remove");
      await load();
    } catch (e: any) {
      alert(e?.message || "Could not remove");
    }
  };

  if (loading) return null;
  if (error) {
    return (
      <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 text-xs text-slate-400" data-testid="approval-box-error">
        {error}
      </div>
    );
  }

  const inbox: any[] = data?.inbox || [];
  const myRequests: any[] = data?.myRequests || [];
  const policies: any[] = data?.policies || [];
  const actionCatalog: string[] = data?.actions || [];
  const activePolicies = policies.filter((p) => p.isActive);

  return (
    <div className="space-y-4" data-testid="approval-inbox">
      {/* ── Approver inbox ── */}
      {role !== "WORKER" && (
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-3" data-testid="approval-inbox-zone">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Approvals — awaiting your decision
              {inbox.length ? (
                <span className="ml-1 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-black">
                  {inbox.length}
                </span>
              ) : null}
            </h3>
            <span className="text-[10px] text-slate-500">
              {activePolicies.length
                ? `${activePolicies.length} active gate${activePolicies.length === 1 ? "" : "s"}`
                : "No gates yet — add a policy below"}
            </span>
          </div>
          {!inbox.length ? (
            <p className="text-xs text-slate-500" data-testid="approval-inbox-empty">
              Nothing waiting. Gated expenses, purchase orders, stock changes, discounts and deletions land here.
            </p>
          ) : (
            <div className="space-y-2" data-testid="approval-inbox-list">
              {inbox.map((r) => (
                <div key={r.id} className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3 sm:p-4" data-testid={`approval-card-${r.id}`}>
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-slate-100">
                          {ACTION_LABEL[r.action] || r.action} · {r.targetLabel || `#${r.targetId}`}
                        </p>
                        {r.action === "EXPENSE" && (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${
                              r.payloadSnapshot?.isPreApproval || r.payloadSnapshot?.expenseMode === "REQUEST"
                                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                                : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            }`}
                          >
                            {r.payloadSnapshot?.isPreApproval || r.payloadSnapshot?.expenseMode === "REQUEST"
                              ? "Pre-Approval Request"
                              : "Incurred Expense"}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        {bizName.get(Number(r.businessId)) || "(deleted unit)"}
                        {r.branchCode ? ` · ${r.branchCode}` : ""} · by {r.requestedByName || "staff"}
                        {money(r.amountGhs, currentCurrency) ? ` · ${money(r.amountGhs, currentCurrency)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                      <button
                        onClick={() => decide(r.id, "APPROVE")}
                        disabled={busyId === r.id}
                        className="flex-1 sm:flex-initial px-3 py-2 min-h-[38px] rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black disabled:opacity-50 flex items-center justify-center shadow-sm"
                        data-testid={`approval-approve-${r.id}`}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => setReasonFor(reasonFor === r.id ? null : r.id)}
                        disabled={busyId === r.id}
                        className="flex-1 sm:flex-initial px-3 py-2 min-h-[38px] rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs font-black disabled:opacity-50 flex items-center justify-center shadow-sm"
                        data-testid={`approval-reject-${r.id}`}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                  {reasonFor === r.id && (
                    <div className="mt-3 pt-3 border-t border-slate-700/60 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                      <input
                        value={reasonText}
                        onChange={(e) => setReasonText(e.target.value)}
                        placeholder="Reason (optional, shown to the requester)"
                        className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-900/90 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                        data-testid={`approval-reason-${r.id}`}
                      />
                      <button
                        onClick={() => decide(r.id, "REJECT", reasonText)}
                        disabled={busyId === r.id}
                        className="px-3 py-2 min-h-[38px] rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-black shrink-0 flex items-center justify-center"
                      >
                        Confirm Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── My requests ── */}
      <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-3" data-testid="approval-mine-zone">
        <h3 className="text-sm font-black text-slate-200 flex items-center gap-2">
          <Clock className="w-4 h-4 text-sky-400" /> My approval requests
        </h3>
        {!myRequests.length ? (
          <p className="text-xs text-slate-500" data-testid="approval-mine-empty">
            Nothing you submitted has needed approval.
          </p>
        ) : (
          <div className="space-y-2" data-testid="approval-mine-list">
            {myRequests.slice(0, 15).map((r) => {
              const isPreApproval =
                r.action === "EXPENSE" &&
                (r.payloadSnapshot?.isPreApproval || r.payloadSnapshot?.expenseMode === "REQUEST");
              const isApprovedExpense = r.action === "EXPENSE" && r.status === "APPROVED";

              return (
                <div
                  key={r.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-slate-700/50 bg-slate-800/40 p-3"
                  data-testid={`my-request-${r.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-bold text-slate-200">
                        {ACTION_LABEL[r.action] || r.action} · {r.targetLabel || `#${r.targetId}`}
                      </p>
                      {isPreApproval && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          Pre-Approval
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {bizName.get(Number(r.businessId)) || "(deleted unit)"}
                      {money(r.amountGhs, currentCurrency) ? ` · ${money(r.amountGhs, currentCurrency)}` : ""}
                      {r.decidedByName ? ` · ${r.status === "PENDING" ? "with" : "by"} ${r.decidedByName}` : ""}
                      {r.decisionReason ? ` — “${r.decisionReason}”` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-between sm:justify-end shrink-0 w-full sm:w-auto pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-700/40">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${STATUS_STYLE[r.status] || ""}`}>
                      {r.status}
                    </span>
                    {isApprovedExpense && isPreApproval && (
                      <button
                        onClick={() => {
                          setPostModalRequest(r);
                          setPostPaymentMethod("CASH");
                          setPostDate(new Date().toISOString().split("T")[0]);
                          setPostReceipts([]);
                        }}
                        className="px-3 py-1.5 min-h-[34px] rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center justify-center gap-1.5 shadow-sm ml-auto sm:ml-0"
                        data-testid={`disburse-expense-${r.id}`}
                      >
                        <Receipt className="w-3.5 h-3.5" />
                        Disburse & Post Receipt
                      </button>
                    )}
                    {r.status === "PENDING" && (
                      <button
                        onClick={() => cancelMine(r.id)}
                        disabled={busyId === r.id}
                        className="text-[11px] font-bold text-slate-400 hover:text-slate-200 underline ml-auto sm:ml-0"
                      >
                        withdraw
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Policy manager (OWNER / GM) ── */}
      {canManagePolicies && (
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/60 p-4 sm:p-5 space-y-3" data-testid="approval-policies-zone">
          <button
            onClick={() => setShowPolicies((v) => !v)}
            className="w-full flex items-center justify-between text-sm font-black text-slate-200"
          >
            <span className="flex items-center gap-2">
              {showPolicies ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              Approval policies {activePolicies.length ? `(${activePolicies.length} active)` : ""}
            </span>
            <span className="text-[10px] font-medium text-slate-500">
              off by default — no rules, no gates, nothing changes
            </span>
          </button>
          {showPolicies && (
            <div className="space-y-3">
              {!policies.length ? (
                <p className="text-xs text-slate-500" data-testid="approval-policies-empty">
                  No policies yet. Example: require the Owner&apos;s approval for expenses of GH₵ 500 or more.
                </p>
              ) : (
                <div className="space-y-1.5" data-testid="approval-policies-list">
                  {policies.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700/50 bg-slate-800/40 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-200">
                          {ACTION_LABEL[p.action] || p.action}
                          {p.thresholdAmountGhs != null ? ` ≥ GH₵ ${Number(p.thresholdAmountGhs).toFixed(2)}` : ""}
                          {p.thresholdPercent != null ? ` ≥ ${Number(p.thresholdPercent)}%` : ""}
                          {` → ${p.approverRole === "OWNER" ? "Owner" : "General Manager"}`}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {p.scopeBusinessId ? bizName.get(Number(p.scopeBusinessId)) || `unit #${p.scopeBusinessId}` : "whole organization"}
                          {p.approverUserId ? ` · delegate #${p.approverUserId}` : ""}
                          {p.createdByName ? ` · by ${p.createdByName}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${p.isActive ? STATUS_STYLE.APPROVED : STATUS_STYLE.CANCELLED}`}>
                          {p.isActive ? "active" : "paused"}
                        </span>
                        {role === "OWNER" && (
                          <button
                            onClick={() => togglePolicy(p.id, !p.isActive)}
                            className="text-[10px] font-bold text-sky-300 hover:text-sky-200 underline"
                          >
                            {p.isActive ? "pause" : "resume"}
                          </button>
                        )}
                        {role === "OWNER" && (
                          <button
                            onClick={() => deletePolicy(p.id)}
                            className="text-slate-500 hover:text-rose-400"
                            title="Delete policy"
                            data-testid={`approval-policy-delete-${p.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-3 space-y-2" data-testid="approval-policy-form">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400">Gate</span>
                    <select
                      value={form.action}
                      onChange={(e) => setForm({ ...form, action: e.target.value })}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700 text-xs text-slate-200"
                    >
                      {actionCatalog.map((a) => (
                        <option key={a} value={a}>
                          {ACTION_LABEL[a] || a}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400">
                      {form.action === "DISCOUNT" ? "Discount % ≥" : "Amount GH₵ ≥ (blank = all)"}
                    </span>
                    <input
                      value={form.threshold}
                      onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                      inputMode="decimal"
                      placeholder={form.action === "DISCOUNT" ? "e.g. 10" : "e.g. 500"}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700 text-xs text-slate-200"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400">Unit</span>
                    <select
                      value={form.scopeBusinessId}
                      onChange={(e) => setForm({ ...form, scopeBusinessId: e.target.value })}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700 text-xs text-slate-200"
                    >
                      <option value="">Whole organization</option>
                      {(data?.businesses || []).map((b: any) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400">Approved by</span>
                    <select
                      value={form.approverRole}
                      onChange={(e) => setForm({ ...form, approverRole: e.target.value })}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700 text-xs text-slate-200"
                    >
                      <option value="OWNER">Owner</option>
                      <option value="GENERAL_MANAGER">General Manager</option>
                    </select>
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={createPolicy}
                    className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-black flex items-center gap-1.5"
                    data-testid="approval-policy-create"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add gate
                  </button>
                  {policySaved && (
                    <span className="text-[11px] font-bold text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Policy saved — it applies from the next submission.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modal: Disburse & Post Receipt for Approved Pre-Approval ── */}
      {postModalRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPostModalRequest(null);
          }}
          data-testid="disburse-modal"
        >
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-md shadow-2xl max-h-[calc(100dvh-1rem)] sm:max-h-[90vh] flex flex-col my-auto overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-800 p-3.5 sm:p-5 shrink-0 bg-slate-900">
              <div className="min-w-0 flex-1 pr-2">
                <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2 truncate">
                  <Receipt className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="truncate">Disburse & Post Receipt</span>
                </h3>
                <p className="text-[11px] text-slate-400 truncate mt-0.5">
                  {postModalRequest.targetLabel} ({money(postModalRequest.amountGhs, currentCurrency)})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPostModalRequest(null)}
                className="p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto p-3.5 sm:p-5 space-y-3.5 flex-1 overscroll-contain">
              {postSuccessNotice && (
                <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-2.5 rounded-lg text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{postSuccessNotice}</span>
                </div>
              )}

              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment Method</label>
                <select
                  value={postPaymentMethod}
                  onChange={(e) => setPostPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
                  data-testid="disburse-payment-method"
                >
                  <option value="CASH">Cash</option>
                  <option value="MOMO">Mobile Money (MTN / Telecel / AT)</option>
                  <option value="BANK">Bank Transfer</option>
                  <option value="CARD">Debit / Credit Card</option>
                  <option value="CHEQUE">Cheque</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-400 mb-1">Payment Date</label>
                <input
                  type="date"
                  value={postDate}
                  onChange={(e) => setPostDate(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs sm:text-sm"
                  data-testid="disburse-date"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-semibold text-slate-400">Receipt / Invoice Images</label>
                  <span className="text-[10px] text-slate-500">{postReceipts.length} attached</span>
                </div>
                {postReceipts.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {postReceipts.map((img, idx) => (
                      <div key={idx} className="relative group w-16 h-16">
                        <img
                          src={img}
                          alt={`Receipt ${idx + 1}`}
                          className="w-full h-full object-cover rounded-lg border border-slate-700"
                        />
                        <button
                          type="button"
                          onClick={() => setPostReceipts((prev) => prev.filter((_, i) => i !== idx))}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-600 text-white rounded-full text-[11px] flex items-center justify-center"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <label className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-300 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition">
                  <Plus className="w-4 h-4 shrink-0" /> Attach Receipt Photo
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handlePostReceiptUpload}
                    className="hidden"
                    data-testid="disburse-file-input"
                  />
                </label>
              </div>

              <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-2.5 text-[11px] text-slate-300">
                <span>
                  Posting will mark this request as <b>Spent & Posted</b> (<code>COMPLETED</code>) and include the
                  amount in official Finance & P&L statements.
                </span>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 p-3.5 sm:p-4 bg-slate-900/95 border-t border-slate-800 shrink-0">
              <button
                type="button"
                onClick={() => setPostModalRequest(null)}
                className="w-full sm:w-auto px-4 py-2.5 min-h-[42px] rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition flex items-center justify-center"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={postBusy}
                onClick={submitPostApprovedExpense}
                className="w-full sm:w-auto px-4 py-2.5 min-h-[42px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-lg"
                data-testid="disburse-submit"
              >
                {postBusy ? "Posting…" : "Confirm & Post to Finance"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
