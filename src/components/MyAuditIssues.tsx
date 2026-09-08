"use client";

// My Audit Issues — the assigned user's dashboard inbox for the issue
// workflow. Every flagged issue / correction request lands here, still linked
// to the original checklist / activity / record. The user responds with a
// note + photo evidence and either sends it back for review (UNDER_REVIEW) or
// marks the correction complete (RESOLVED); the auditor then verifies & closes.

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck, Flag, X, Loader2, Send, CheckCircle2, AlertTriangle,
  MessageSquare, ImagePlus, History, Link2,
} from "lucide-react";

const STEPS = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "RESOLVED", "VERIFIED"] as const;
const STEP_LABEL: Record<string, string> = {
  FLAGGED: "Flagged", UNDER_REVIEW: "Under Review", CORRECTION_REQUIRED: "Correction Required", RESOLVED: "Resolved", VERIFIED: "Verified",
};
const STATUS_TINT: Record<string, string> = {
  FLAGGED: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  UNDER_REVIEW: "text-amber-300 bg-amber-500/15 border-amber-500/30",
  CORRECTION_REQUIRED: "text-orange-300 bg-orange-500/15 border-orange-500/30",
  RESOLVED: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  VERIFIED: "text-teal-300 bg-teal-500/15 border-teal-500/30",
};
const fmtTs = (v: any) => (v ? new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function Pipeline({ status }: { status: string }) {
  const cur = STEPS.indexOf(status as any);
  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid="myi-pipeline">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-1">
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[8px] font-black uppercase tracking-wide ${
            s === status ? "bg-teal-500/20 text-teal-200 border-teal-400/50 ring-1 ring-teal-400/40"
            : i < cur || status === "VERIFIED" ? "bg-emerald-500/10 text-emerald-300/80 border-emerald-500/25"
            : "bg-slate-800 text-slate-500 border-slate-700"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s === status ? "bg-teal-300" : i < cur || status === "VERIFIED" ? "bg-emerald-400" : "bg-slate-600"}`} />
            {STEP_LABEL[s]}
          </div>
          {i < STEPS.length - 1 && <span className="text-slate-700 text-[9px]">›</span>}
        </div>
      ))}
    </div>
  );
}

export default function MyAuditIssues({ currentUser, focusIssueId, onClose }: { currentUser: any; focusIssueId?: number | null; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forms, setForms] = useState<Record<number, { note: string; evidence: string; photo: string }>>({});
  const [histId, setHistId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/audit/issues");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load your issues");
      setData(body);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (focusIssueId && data) {
      setTimeout(() => document.querySelector(`[data-testid="myi-issue-${focusIssueId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    }
  }, [focusIssueId, data]);

  const setForm = (id: number, patch: Partial<{ note: string; evidence: string; photo: string }>) =>
    setForms((f) => ({ ...f, [id]: { note: f[id]?.note ?? "", evidence: f[id]?.evidence ?? "", photo: f[id]?.photo ?? "", ...patch } }));

  const onPhoto = (id: number, file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Evidence photo must be an image file."); return; }
    const r = new FileReader();
    r.onload = () => setForm(id, { photo: String(r.result) });
    r.readAsDataURL(file);
  };

  const submit = async (id: number, action: "RESPOND" | "MARK_RESOLVED") => {
    setBusy(true); setError(""); setNotice("");
    try {
      const f = forms[id] || { note: "", evidence: "", photo: "" };
      const res = await fetch("/api/audit/issues", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: id, action, note: f.note, evidence: f.evidence, photo: f.photo }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not send your response");
      setNotice(action === "RESPOND"
        ? "Response sent — the issue is now UNDER REVIEW and the auditor has been notified."
        : "Marked RESOLVED — the auditor has been notified to verify & close it.");
      setForms((prev) => ({ ...prev, [id]: { note: "", evidence: "", photo: "" } }));
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const issues: any[] = data?.issues || [];
  const threads: Record<number, any[]> = data?.threads || {};
  const bizMap: Record<number, { name: string; code: string }> = data?.bizMap || {};
  const inputCls = "w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-teal-500";
  const labelCls = "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1";

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[88vh] overflow-y-auto p-5 space-y-4" data-testid="myi-root">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
            <Flag className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-black text-white">My Audit Issues</h3>
            <p className="text-[11px] text-slate-400">
              Issues & corrections auditors assigned to you — each one stays linked to the original checklist, activity or record.
              Respond with a note and photo evidence, send it back for review, or mark the correction complete.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200" data-testid="myi-close"><X className="w-4 h-4" /></button>
        </div>

        {notice && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs px-4 py-2.5" data-testid="myi-notice">{notice}</div>}
        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs px-4 py-2.5" data-testid="myi-error">{error}</div>}
        {loading && <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-xs"><Loader2 className="w-4 h-4 animate-spin" /> Loading your issues…</div>}

        {!loading && issues.length === 0 && (
          <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-8 text-center text-slate-500 text-sm flex flex-col items-center gap-2" data-testid="myi-empty">
            <ShieldCheck className="w-7 h-7 text-emerald-400" />
            Nothing assigned to you right now — clean slate.
          </div>
        )}

        {!loading && issues.map((i) => {
          const actionable = i.status === "FLAGGED" || i.status === "CORRECTION_REQUIRED";
          const form = forms[i.id] || { note: "", evidence: "", photo: "" };
          const thread = threads[i.id] || [];
          return (
            <div key={i.id} className={`bg-slate-950/60 border rounded-xl p-4 space-y-3 ${focusIssueId === i.id ? "border-amber-400/60 ring-1 ring-amber-400/40" : "border-slate-700/80"}`} data-testid={`myi-issue-${i.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${STATUS_TINT[i.status] || STATUS_TINT.FLAGGED}`} data-testid={`myi-status-${i.id}`}>{STEP_LABEL[i.status] || i.status}</span>
                {i.issueTitle && <span className="font-black text-slate-100 text-xs">{i.issueTitle}</span>}
                <span className="text-[10px] text-slate-500 ml-auto">{fmtTs(i.createdAt)}</span>
              </div>
              <Pipeline status={i.status} />
              <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link2 className="w-3 h-3 text-cyan-400" />
                <span className="font-mono text-[10px] text-cyan-300">{i.recordRef}</span>
                <span className="text-slate-300">{i.recordTitle}</span>
                <span className="text-slate-500">· {bizMap[i.businessId]?.name || `Business #${i.businessId}`}{i.branchCode ? ` · ${i.branchCode}` : ""}</span>
              </div>
              {i.reason && <div className="text-xs text-amber-200 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {i.reason}</div>}
              {i.comment && <div className="text-xs text-slate-300">“{i.comment}”</div>}
              {i.evidence && <div className="text-[11px] text-cyan-300">Auditor evidence: {i.evidence}</div>}
              {i.evidencePhoto && <img src={i.evidencePhoto} alt="auditor evidence" className="max-h-36 rounded-lg border border-slate-700" data-testid={`myi-photo-ev-${i.id}`} />}
              <div className="text-[10px] text-slate-500">
                Raised by <span className="font-bold text-slate-300">{i.reviewerName}</span> ({i.reviewerRole})
                {i.responseAt && <> · your last response {fmtTs(i.responseAt)}</>}
              </div>

              {thread.length > 0 && (
                <div>
                  <button onClick={() => setHistId(histId === i.id ? null : i.id)} className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-200" data-testid={`myi-hist-${i.id}`}>
                    <History className="w-3 h-3" /> Conversation & status history ({thread.length})
                  </button>
                  {histId === i.id && (
                    <div className="mt-2 space-y-1.5 border-l-2 border-slate-700 pl-3" data-testid={`myi-thread-${i.id}`}>
                      {thread.map((t: any) => (
                        <div key={t.id} className="text-[10px] text-slate-400">
                          <span className="font-bold text-slate-200">{t.actorName}</span>
                          <span className="text-slate-500"> · {fmtTs(t.createdAt)} · </span>
                          <span className="font-bold text-teal-300">{t.action}</span>
                          {t.statusFrom || t.statusTo ? <span className="text-slate-500"> ({t.statusFrom ? STEP_LABEL[t.statusFrom] || t.statusFrom : "new"} → {STEP_LABEL[t.statusTo || ""] || t.statusTo})</span> : null}
                          {t.note && <div className="text-slate-300 mt-0.5">“{t.note}”</div>}
                          {t.evidence && <div className="text-cyan-300/80">evidence: {t.evidence}</div>}
                          {t.photo && <img src={t.photo} alt="evidence" className="max-h-24 rounded border border-slate-700 mt-1" />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {i.status === "VERIFIED" && (
                <div className="rounded-lg bg-teal-500/10 border border-teal-500/25 px-3 py-2 text-[11px] text-teal-200 flex items-start gap-1.5" data-testid={`myi-closed-${i.id}`}>
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Verified & closed by <span className="font-bold">{i.resolvedByName}</span> · {fmtTs(i.resolvedAt)}{i.resolutionNote ? ` — ${i.resolutionNote}` : ""}
                </div>
              )}

              {actionable && (
                <div className="rounded-xl border border-slate-700/80 bg-slate-900/70 p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3 text-teal-400" /> Your response
                  </div>
                  <div>
                    <label className={labelCls}>Note *</label>
                    <textarea className={`${inputCls} h-16`} value={form.note} placeholder="Explain what happened / what you corrected…" onChange={(e) => setForm(i.id, { note: e.target.value })} data-testid={`myi-note-${i.id}`} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Evidence (link / receipt no. / note)</label>
                      <input className={inputCls} value={form.evidence} placeholder="e.g. deposit slip #, photo link…" onChange={(e) => setForm(i.id, { evidence: e.target.value })} data-testid={`myi-evidence-${i.id}`} />
                    </div>
                    <div>
                      <label className={labelCls}>Photo evidence</label>
                      <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-300 cursor-pointer" data-testid={`myi-photo-btn-${i.id}`}>
                        <ImagePlus className="w-3.5 h-3.5 text-teal-400" /> {form.photo ? "Photo attached ✓" : "Attach a photo"}
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(i.id, e.target.files?.[0] || null)} data-testid={`myi-photo-${i.id}`} />
                      </label>
                    </div>
                  </div>
                  {form.photo && <img src={form.photo} alt="evidence preview" className="max-h-28 rounded-lg border border-slate-700" data-testid={`myi-photo-preview-${i.id}`} />}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button onClick={() => submit(i.id, "RESPOND")} disabled={busy || !form.note.trim()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-[11px] font-bold" data-testid={`myi-send-review-${i.id}`}>
                      <Send className="w-3 h-3" /> Respond & mark for review
                    </button>
                    <button onClick={() => submit(i.id, "MARK_RESOLVED")} disabled={busy || !form.note.trim()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-[11px] font-bold" data-testid={`myi-mark-resolved-${i.id}`}>
                      <CheckCircle2 className="w-3 h-3" /> Correction complete — mark resolved
                    </button>
                  </div>
                </div>
              )}
              {!actionable && i.status !== "VERIFIED" && (
                <div className="text-[10px] text-slate-500 italic">
                  {i.status === "UNDER_REVIEW" ? "With the auditor — they are reviewing your response." : "With the auditor — awaiting verification."}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
