"use client";

// Supervisor & Auditor Control Center — reviews EXISTING worker records
// (daily checklists, operations & activities, sales, finance, inventory,
// production, payroll, attendance, assets, CCTV) in place: verify, flag,
// comment, request corrections and attach photo evidence without ever
// duplicating checklists. Flagged issues are routed straight to the assigned
// user's dashboard (bell + My Issues inbox) and travel the pipeline
// FLAGGED → UNDER_REVIEW → CORRECTION_REQUIRED → RESOLVED → VERIFIED with a
// complete per-issue thread and audit-trail mirroring.
// Who can see what is enforced by the API: OWNER → everything and controls
// Auditor permissions; delegated managers → grant/revoke Auditor access
// inside their branches; auditors → strictly the businesses + modules granted.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck, RefreshCw, Flag, MessageSquare, PencilLine, BadgeCheck, History,
  KeyRound, ScrollText, BarChart3, Rows3, X, FileSpreadsheet, UserCheck, Ban, Search, AlertTriangle,
  ImagePlus, Send, User,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";
import AiSectionGuide from "./AiSectionGuide";

const MODULES = ["OPERATIONS", "FINANCE", "INVENTORY", "EMPLOYEES", "PAYROLL", "ATTENDANCE", "ASSETS", "CCTV"];
const MODULE_LABEL: Record<string, string> = {
  OPERATIONS: "Operations · Production", FINANCE: "Sales · Finance", INVENTORY: "Inventory",
  EMPLOYEES: "Employees", PAYROLL: "Payroll", ATTENDANCE: "Attendance", ASSETS: "Assets", CCTV: "CCTV",
};
const MODULE_TINT: Record<string, string> = {
  OPERATIONS: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  FINANCE: "text-teal-300 bg-teal-500/15 border-teal-500/30",
  INVENTORY: "text-cyan-300 bg-cyan-500/15 border-cyan-500/30",
  EMPLOYEES: "text-violet-300 bg-violet-500/15 border-violet-500/30",
  PAYROLL: "text-amber-300 bg-amber-500/15 border-amber-500/30",
  ATTENDANCE: "text-sky-300 bg-sky-500/15 border-sky-500/30",
  ASSETS: "text-orange-300 bg-orange-500/15 border-orange-500/30",
  CCTV: "text-rose-300 bg-rose-500/15 border-rose-500/30",
};
const ACTION_TINT: Record<string, string> = {
  VERIFIED: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  VERIFY: "text-teal-300 bg-teal-500/15 border-teal-500/30",
  FLAGGED: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  FLAG: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  COMMENT: "text-slate-300 bg-slate-600/25 border-slate-500/30",
  CORRECTION_REQUESTED: "text-amber-300 bg-amber-500/15 border-amber-500/30",
  REQUEST_CORRECTION: "text-orange-300 bg-orange-500/15 border-orange-500/30",
  RESPOND: "text-cyan-300 bg-cyan-500/15 border-cyan-500/30",
  MARK_REVIEW: "text-amber-300 bg-amber-500/15 border-amber-500/30",
  MARK_RESOLVED: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  RESOLVE: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  RESOLVED: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  INFO: "text-slate-300 bg-slate-600/25 border-slate-500/30",
};
const STATE_TINT: Record<string, string> = {
  FLAGGED: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  OPEN: "text-rose-300 bg-rose-500/15 border-rose-500/30",
  UNDER_REVIEW: "text-amber-300 bg-amber-500/15 border-amber-500/30",
  CORRECTION_REQUIRED: "text-orange-300 bg-orange-500/15 border-orange-500/30",
  RESOLVED: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
  VERIFIED: "text-teal-300 bg-teal-500/15 border-teal-500/30",
  INFO: "text-slate-300 bg-slate-600/25 border-slate-500/30",
  UNREVIEWED: "text-slate-500 bg-slate-800/60 border-slate-700",
};
const ISSUE_STEPS = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "RESOLVED", "VERIFIED"] as const;
const STEP_LABEL: Record<string, string> = {
  FLAGGED: "Flagged", UNDER_REVIEW: "Under Review", CORRECTION_REQUIRED: "Correction Required", RESOLVED: "Resolved", VERIFIED: "Verified",
  INFO: "Comment", OPEN: "Flagged",
};
const ISSUE_ACTION_SET = ["FLAGGED", "CORRECTION_REQUESTED"];
const OPEN_ISSUE_STATUSES = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED"];

/** 5-step pipeline visual: Flagged → Under Review → Correction Required → Resolved → Verified */
function PipelineSteps({ status }: { status: string }) {
  const cur = ISSUE_STEPS.indexOf(status as any);
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {ISSUE_STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-1">
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[8px] font-black uppercase tracking-wide ${
            s === status ? "bg-teal-500/20 text-teal-200 border-teal-400/50 ring-1 ring-teal-400/40"
            : i < cur || status === "VERIFIED" ? "bg-emerald-500/10 text-emerald-300/80 border-emerald-500/25"
            : "bg-slate-800 text-slate-500 border-slate-700"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s === status ? "bg-teal-300" : i < cur || status === "VERIFIED" ? "bg-emerald-400" : "bg-slate-600"}`} />
            {STEP_LABEL[s]}
          </div>
          {i < ISSUE_STEPS.length - 1 && <span className="text-slate-700 text-[9px]">›</span>}
        </div>
      ))}
    </div>
  );
}
const DONUT_COLORS = ["#34d399", "#f87171", "#fbbf24", "#94a3b8"];
const money = (n: number) => `GH₵ ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const fmtTs = (v: any) => (v ? new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const dayOnly = (v: any) => String(v ?? "").slice(0, 10);

type Rec = any;
type Rev = any;

export default function AuditCommandCenter({ currentUser, businesses, focusIssueId, onFocusHandled }: { currentUser: any; businesses: any[]; focusIssueId?: number | null; onFocusHandled?: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"RECORDS" | "ISSUES" | "REPORTS" | "ACCESS" | "LOG">("RECORDS");
  const [filters, setFilters] = useState({ businessId: "", module: "", recordType: "", branchCode: "", worker: "", status: "", q: "", from: "", to: "" });
  const [histKey, setHistKey] = useState<string | null>(null);
  const [actionModal, setActionModal] = useState<{ rec: Rec; action: string } | null>(null);
  const [actionForm, setActionForm] = useState({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" });
  const [actError, setActError] = useState("");
  const [verifyModal, setVerifyModal] = useState<Rev | null>(null);
  const [verifyNote, setVerifyNote] = useState("");
  const [correctModal, setCorrectModal] = useState<Rev | null>(null);
  const [correctNote, setCorrectNote] = useState("");
  const [modalError, setModalError] = useState("");
  const [threadId, setThreadId] = useState<number | null>(null);
  const [focusIssue, setFocusIssue] = useState<number | null>(null);
  const [issuesView, setIssuesView] = useState<"OPEN" | "FLAGGED" | "UNDER_REVIEW" | "CORRECTION_REQUIRED" | "RESOLVED" | "VERIFIED" | "ALL">("OPEN");
  const [grantForm, setGrantForm] = useState<{ userId: string; businessIds: number[]; branches: Record<number, string[]>; note: string; modules: string[] }>({ userId: "", businessIds: [], branches: {}, note: "", modules: [] });
  const [accessMsg, setAccessMsg] = useState("");
  const [accessErr, setAccessErr] = useState("");
  const [busy, setBusy] = useState(false);

  const bizSource = data?.bizList?.length ? data.bizList : businesses;
  const bizName = useCallback((id: number) => bizSource.find((b: any) => b.id === id)?.name || `Business #${id}`, [bizSource]);
  const bizCode = useCallback((id: number) => bizSource.find((b: any) => b.id === id)?.code || "", [bizSource]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
      const res = await fetch(`/api/audit${p.size ? `?${p.toString()}` : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load the audit workspace");
      setData(body);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const t = setTimeout(load, filters.q || filters.worker ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q, filters.worker]);

  // Deep-link from a notification: open the Issues tab focused on that issue.
  useEffect(() => {
    if (focusIssueId) {
      setTab("ISSUES");
      setIssuesView("ALL");
      setFocusIssue(focusIssueId);
      onFocusHandled?.();
    }
  }, [focusIssueId, onFocusHandled]);
  useEffect(() => {
    if (focusIssue && data) {
      setTimeout(() => document.querySelector(`[data-testid="aud-issue-${focusIssue}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 90);
    }
  }, [focusIssue, data]);

  const scope = data?.scope;
  const records: Rec[] = data?.records || [];
  const reviews: Rev[] = data?.reviews || [];
  const log: any[] = data?.log || [];
  const report = data?.report;
  const allowedModules: string[] = useMemo(() => {
    if (!scope) return [];
    if (scope.businessIds === null) return MODULES;
    const set = new Set<string>();
    Object.values(scope.moduleByBusiness || {}).forEach((mods: any) => (mods as string[]).forEach((m) => set.add(m)));
    return MODULES.filter((m) => set.has(m));
  }, [scope]);
  const allowedBusinessIds: number[] | null = scope?.businessIds ?? null;
  const visibleBusinesses = useMemo(
    () => (allowedBusinessIds === null || allowedBusinessIds === undefined ? bizSource : bizSource.filter((b: any) => (allowedBusinessIds as number[]).includes(b.id))),
    [bizSource, allowedBusinessIds]
  );
  // Businesses the granter may CREATE grants for (OWNER: all; delegated
  // manager: only inside their accessible businesses — independent of any
  // audit grants they themselves hold).
  const grantableBusinessIds: number[] | null = scope?.canGrant ? (scope?.grantBusinessIds ?? null) : [];
  const grantableBusinesses = useMemo(
    () => (grantableBusinessIds === null ? bizSource : bizSource.filter((b: any) => (grantableBusinessIds as number[]).includes(b.id))),
    [bizSource, grantableBusinessIds]
  );
  // Branch candidates per business: the business code itself + every branch
  // code seen on records in scope.
  const branchOptionsFor = (businessId: number): string[] => {
    const own = bizSource.find((b: any) => b.id === businessId)?.code;
    const fromRecords = records.filter((r: Rec) => r.businessId === businessId && r.branchCode).map((r: Rec) => String(r.branchCode));
    return [...new Set([...(own ? [own] : []), ...fromRecords])].sort();
  };
  const workerOptions = useMemo(() => [...new Set(records.map((r) => r.workerName).filter(Boolean))].sort() as string[], [records]);
  const allIssues = useMemo(() => reviews.filter((r: Rev) => ISSUE_ACTION_SET.includes(r.action)), [reviews]);
  const issues = useMemo(() => {
    if (issuesView === "ALL") return allIssues;
    if (issuesView === "OPEN") return allIssues.filter((r: Rev) => OPEN_ISSUE_STATUSES.includes(r.status));
    return allIssues.filter((r: Rev) => r.status === issuesView);
  }, [allIssues, issuesView]);
  const issueCountBy = useCallback((s: string) => s === "OPEN" ? allIssues.filter((r: Rev) => OPEN_ISSUE_STATUSES.includes(r.status)).length : s === "ALL" ? allIssues.length : allIssues.filter((r: Rev) => r.status === s).length, [allIssues]);
  const reviewsFor = useCallback((rec: Rec) => reviews.filter((r: Rev) => `${r.recordType}:${r.recordSource || ""}:${r.recordId}` === rec.key), [reviews]);

  const onPhoto = (setter: (v: string) => void, err: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { err("Evidence photo must be an image file."); return; }
    const r = new FileReader();
    r.onload = () => setter(String(r.result));
    r.readAsDataURL(file);
  };

  const submitAction = async () => {
    if (!actionModal) return;
    setBusy(true); setActError("");
    try {
      const res = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: actionModal.action, recordType: actionModal.rec.recordType,
          recordSource: actionModal.rec.recordSource, recordId: actionModal.rec.recordId,
          issueTitle: actionForm.issueTitle,
          reason: actionForm.reason, comment: actionForm.comment, evidence: actionForm.evidence,
          evidencePhoto: actionForm.photo,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Review failed");
      const routed = body.assignedTo ? ` Routed to ${body.assignedTo.name}'s dashboard — they were notified.` : actionModal.action === "VERIFIED" || actionModal.action === "COMMENT" ? "" : " No user account matched the record's worker — it stays tracked here.";
      setNotice(`${actionModal.action === "VERIFIED" ? "Record verified" : actionModal.action === "FLAGGED" ? "Issue flagged" : actionModal.action === "CORRECTION_REQUESTED" ? "Correction requested" : "Comment added"} — ${actionModal.rec.ref}. It is on the audit trail.${routed}`);
      setActionModal(null); setActionForm({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" });
      await load();
    } catch (e: any) { setActError(e.message); } finally { setBusy(false); }
  };

  const submitVerify = async () => {
    if (!verifyModal) return;
    setBusy(true); setModalError("");
    try {
      const res = await fetch("/api/audit", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "VERIFY", reviewId: verifyModal.id, resolution: verifyNote }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not verify & close");
      setNotice(`Issue on ${verifyModal.recordRef} VERIFIED & closed — the assigned user was notified.`);
      setVerifyModal(null); setVerifyNote("");
      await load();
    } catch (e: any) { setModalError(e.message); } finally { setBusy(false); }
  };

  const submitCorrect = async () => {
    if (!correctModal) return;
    setBusy(true); setModalError("");
    try {
      const res = await fetch("/api/audit", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REQUEST_CORRECTION", reviewId: correctModal.id, note: correctNote }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not request correction");
      setNotice(`Correction requested on ${correctModal.recordRef} — ${correctModal.assignedUserName || "the assigned user"} was notified on their dashboard.`);
      setCorrectModal(null); setCorrectNote("");
      await load();
    } catch (e: any) { setModalError(e.message); } finally { setBusy(false); }
  };

  const submitGrant = async () => {
    setBusy(true); setAccessErr(""); setAccessMsg("");
    try {
      const res = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "GRANT",
          userId: Number(grantForm.userId),
          businessIds: grantForm.businessIds,
          branches: Object.fromEntries(Object.entries(grantForm.branches).filter(([, v]) => v.length > 0)),
          modules: grantForm.modules,
          note: grantForm.note || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Grant failed");
      const n = Number(body.count || 1);
      setAccessMsg(body.updated && n === 1
        ? "Auditor access updated — modules & scope replaced."
        : `Auditor access granted — ${n} assignment${n > 1 ? "s" : ""} saved. They can now sign in and audit exactly that scope.`);
      setGrantForm({ userId: "", businessIds: [], branches: {}, note: "", modules: [] });
      await load();
    } catch (e: any) { setAccessErr(e.message); } finally { setBusy(false); }
  };

  const revokeGrant = async (grantId: number) => {
    setBusy(true); setAccessErr(""); setAccessMsg("");
    try {
      const res = await fetch("/api/audit", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "REVOKE_GRANT", grantId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Revoke failed");
      setAccessMsg("Auditor access revoked — effective immediately.");
      await load();
    } catch (e: any) { setAccessErr(e.message); } finally { setBusy(false); }
  };

  const toggleDelegation = async (u: any) => {
    setBusy(true); setAccessErr(""); setAccessMsg("");
    try {
      const res = await fetch("/api/users", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: u.id, canManageAuditors: !u.canManageAuditors }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not update delegation");
      setAccessMsg(!u.canManageAuditors ? `${u.name} may now manage Auditor access for their assigned branches.` : `${u.name}'s Auditor-access delegation removed.`);
      await load();
    } catch (e: any) { setAccessErr(e.message); } finally { setBusy(false); }
  };

  const downloadCsv = () => {
    const head = ["Date", "Time", "Reviewer", "Reviewer Role", "Action", "Status", "Issue Title", "Assigned To", "Module", "Record", "Record Ref", "Business", "Branch", "Worker", "Reason", "Comment", "Evidence", "Response", "Response By", "Response At", "Resolution", "Verified By", "Verified At"];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = reviews.map((r: Rev) => [dayOnly(r.createdAt), fmtTs(r.createdAt).split(", ").pop(), r.reviewerName, r.reviewerRole, r.action, STEP_LABEL[r.status] || r.status, r.issueTitle || "", r.assignedUserName || "", r.module, r.recordTitle, r.recordRef, bizName(r.businessId), r.branchCode || "", r.workerName || "", r.reason || "", r.comment || "", r.evidence || (r.evidencePhoto ? "[photo attached]" : ""), r.responseNote || "", r.responseByName || "", r.responseAt ? fmtTs(r.responseAt) : "", r.resolutionNote || "", r.resolvedByName || "", r.resolvedAt ? fmtTs(r.resolvedAt) : ""].map(esc).join(","));
    const blob = new Blob(["\uFEFF" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gomina-audit-reviews-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const inputCls = "w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-teal-500";
  const labelCls = "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1";
  const tabs = [
    { key: "RECORDS", label: "Records", icon: Rows3, testid: "aud-tab-RECORDS" },
    { key: "ISSUES", label: `Issues${report ? ` (${report.totals.openIssues} open)` : ""}`, icon: Flag, testid: "aud-tab-ISSUES" },
    { key: "REPORTS", label: "Reports & Charts", icon: BarChart3, testid: "aud-tab-REPORTS" },
    ...(scope?.canGrant ? [{ key: "ACCESS", label: "Auditor Access", icon: KeyRound, testid: "aud-tab-ACCESS" }] : []),
    { key: "LOG", label: "Audit Log", icon: ScrollText, testid: "aud-tab-LOG" },
  ] as any[];

  const kpis = report ? [
    { label: "Records in scope", value: report.totals.records.toLocaleString(), sub: `${visibleBusinesses.length} business(es)` },
    { label: "Reviews logged", value: report.totals.reviews.toLocaleString(), sub: `${report.totals.reviewedRecords} record(s) covered`, tint: "text-teal-300" },
    { label: "Verified", value: report.totals.verified.toLocaleString(), sub: "records confirmed", tint: "text-emerald-300" },
    { label: "Open issues", value: report.totals.openIssues.toLocaleString(), sub: `${report.totals.flaggedNow} flagged · ${report.totals.underReview} in review · ${report.totals.correctionsRequired} corrections`, tint: "text-amber-300" },
    { label: "Resolved · awaiting verify", value: report.totals.resolvedIssues.toLocaleString(), sub: `${report.totals.verifiedIssues} verified & closed${report.avgResolveHrs != null ? ` · avg ${report.avgResolveHrs}h` : ""}`, tint: "text-emerald-300" },
    { label: "Flagged amount", value: money(report.totals.flaggedAmount), sub: "open financial flags", tint: "text-rose-300" },
  ] : [];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto" data-testid="aud-root">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-teal-500/20">
          <ShieldCheck className="w-6 h-6 text-white" />
        </div>
        <div className="flex-1 min-w-[220px]">
          <h2 className="text-xl font-black text-white">Supervisor & Auditor Control Center</h2>
          <p className="text-[11px] text-slate-400">Review the records workers already keep — verify, flag, comment, request corrections, attach evidence · every action is on the audit trail</p>
        </div>
        {scope && (
          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border ${scope.level === "OWNER" ? "text-amber-300 bg-amber-500/15 border-amber-500/30" : scope.level === "SUPERVISOR" ? "text-cyan-300 bg-cyan-500/15 border-cyan-500/30" : "text-teal-300 bg-teal-500/15 border-teal-500/30"}`} data-testid="aud-scope">
            {scope.level === "OWNER" ? "OWNER · full control" : scope.level === "SUPERVISOR" ? `SUPERVISOR · ${scope.businessIds?.length ?? 0} business(es)` : `AUDITOR · authorized scope only`}
          </span>
        )}
        <AiSectionGuide moduleKey="AUDIT" section="DEFAULT" variant="header" />
        <button onClick={load} disabled={loading} className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300" data-testid="aud-refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {notice && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs px-4 py-2.5" data-testid="aud-notice">{notice}</div>}
      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs px-4 py-2.5" data-testid="aud-error">{error}</div>}

      {/* KPIs */}
      {report && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="aud-kpis">
          {kpis.map((k) => (
            <div key={k.label} className="bg-slate-900 border border-slate-700/80 rounded-xl p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{k.label}</div>
              <div className={`text-lg font-black ${k.tint || "text-white"}`}>{k.value}</div>
              <div className="text-[10px] text-slate-500">{k.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} data-testid={t.testid}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-bold border transition ${tab === t.key ? "bg-teal-500/15 text-teal-300 border-teal-500/40" : "bg-slate-900 text-slate-400 border-slate-700/80 hover:text-slate-200"}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* Filters (records / issues / log) */}
      {(tab === "RECORDS" || tab === "ISSUES" || tab === "LOG") && (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-9 gap-2" data-testid="aud-filters">
          <div>
            <label className={labelCls}>Business</label>
            <select className={inputCls} value={filters.businessId} onChange={(e) => setFilters({ ...filters, businessId: e.target.value })} data-testid="aud-f-business">
              <option value="">All in scope</option>
              {visibleBusinesses.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {tab === "RECORDS" && (<>
            <div>
              <label className={labelCls}>Activity / module</label>
              <select className={inputCls} value={filters.module} onChange={(e) => setFilters({ ...filters, module: e.target.value, recordType: "" })} data-testid="aud-f-module">
                <option value="">All modules</option>
                {allowedModules.map((m) => <option key={m} value={m}>{MODULE_LABEL[m]}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Record type</label>
              <select className={inputCls} value={filters.recordType} onChange={(e) => setFilters({ ...filters, recordType: e.target.value })} data-testid="aud-f-type">
                <option value="">All types</option>
                {[...new Set(records.map((r) => r.recordType))].sort().map((t: any) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Branch</label>
              <input className={inputCls} value={filters.branchCode} placeholder="e.g. POULTRY-01" onChange={(e) => setFilters({ ...filters, branchCode: e.target.value })} data-testid="aud-f-branch" />
            </div>
            <div>
              <label className={labelCls}>Worker</label>
              <input className={inputCls} list="aud-workers" value={filters.worker} placeholder="who recorded it" onChange={(e) => setFilters({ ...filters, worker: e.target.value })} data-testid="aud-f-worker" />
              <datalist id="aud-workers">{workerOptions.map((w) => <option key={w} value={w} />)}</datalist>
            </div>
            <div>
              <label className={labelCls}>Review status</label>
              <select className={inputCls} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} data-testid="aud-f-status">
                <option value="">All</option>
                <option value="UNREVIEWED">Unreviewed</option>
                <option value="VERIFIED">Verified</option>
                <option value="FLAGGED">Flagged</option>
                <option value="UNDER_REVIEW">Under review</option>
                <option value="CORRECTION_REQUIRED">Correction required</option>
                <option value="RESOLVED">Resolved · awaiting verify</option>
                <option value="INFO">Commented</option>
              </select>
            </div>
          </>)}
          <div>
            <label className={labelCls}>From</label>
            <input type="date" className={inputCls} value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} data-testid="aud-f-from" />
          </div>
          <div>
            <label className={labelCls}>To</label>
            <input type="date" className={inputCls} value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} data-testid="aud-f-to" />
          </div>
          <div>
            <label className={labelCls}>Search</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
              <input className={`${inputCls} pl-8`} value={filters.q} placeholder="ref, title, person…" onChange={(e) => setFilters({ ...filters, q: e.target.value })} data-testid="aud-f-q" />
            </div>
          </div>
        </div>
      )}

      {/* ── RECORDS ─────────────────────────────────────────────── */}
      {tab === "RECORDS" && (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
              <tr>
                <th className="px-4 py-2">Record</th><th className="px-3 py-2">Module</th><th className="px-3 py-2">Business · Branch</th>
                <th className="px-3 py-2">Worker</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Review state</th>
                <th className="px-3 py-2 text-right">Audit actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70" data-testid="aud-rec-rows">
              {records.map((r) => (
                <>
                  <tr key={r.key} className="text-slate-300 hover:bg-slate-800/40" data-testid={`aud-rec-row-${r.key}`}>
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-[10px] text-cyan-300">{r.ref}</div>
                      <div className="font-semibold text-slate-100">{r.title}</div>
                      <div className="text-[10px] text-slate-500 line-clamp-1">{r.detail}</div>
                    </td>
                    <td className="px-3 py-2.5"><span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${MODULE_TINT[r.module] || MODULE_TINT.OPERATIONS}`}>{r.module}</span></td>
                    <td className="px-3 py-2.5">{bizName(r.businessId)} · <span className="font-mono text-[10px] text-cyan-300">{r.branchCode || bizCode(r.businessId)}</span></td>
                    <td className="px-3 py-2.5">{r.workerName || <span className="text-slate-600">—</span>}</td>
                    <td className="px-3 py-2.5 font-mono text-[10px]">{r.date || "—"}</td>
                    <td className="px-3 py-2.5"><span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${STATE_TINT[r.reviewState] || STATE_TINT.UNREVIEWED}`} data-testid={`aud-rec-state-${r.key}`}>{r.reviewState}</span></td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button title="Review history" onClick={() => setHistKey(histKey === r.key ? null : r.key)} className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400" data-testid={`aud-hist-${r.key}`}><History className="w-3.5 h-3.5" /></button>
                        <button title="Verify record" onClick={() => { setActionModal({ rec: r, action: "VERIFIED" }); setActionForm({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" }); setActError(""); }} className="p-1.5 rounded bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 border border-emerald-500/30" data-testid={`aud-verify-${r.key}`}><BadgeCheck className="w-3.5 h-3.5" /></button>
                        <button title="Flag issue" onClick={() => { setActionModal({ rec: r, action: "FLAGGED" }); setActionForm({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" }); setActError(""); }} className="p-1.5 rounded bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30" data-testid={`aud-flag-${r.key}`}><Flag className="w-3.5 h-3.5" /></button>
                        <button title="Request correction" onClick={() => { setActionModal({ rec: r, action: "CORRECTION_REQUESTED" }); setActionForm({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" }); setActError(""); }} className="p-1.5 rounded bg-amber-600/20 hover:bg-amber-600/40 text-amber-300 border border-amber-500/30" data-testid={`aud-correct-${r.key}`}><PencilLine className="w-3.5 h-3.5" /></button>
                        <button title="Add comment" onClick={() => { setActionModal({ rec: r, action: "COMMENT" }); setActionForm({ issueTitle: "", reason: "", comment: "", evidence: "", photo: "" }); setActError(""); }} className="p-1.5 rounded bg-slate-700/60 hover:bg-slate-700 text-slate-300 border border-slate-600" data-testid={`aud-comment-${r.key}`}><MessageSquare className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                  {histKey === r.key && (
                    <tr key={`${r.key}-hist`} className="bg-slate-950/60">
                      <td colSpan={7} className="px-6 py-3" data-testid={`aud-hist-panel-${r.key}`}>
                        {reviewsFor(r).length === 0 ? (
                          <div className="text-[11px] text-slate-500">No reviews yet — this record is unreviewed.</div>
                        ) : (
                          <div className="space-y-2">
                            {reviewsFor(r).map((v: Rev) => (
                              <div key={v.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ACTION_TINT[v.action]}`}>{v.action}</span>
                                <span className="text-slate-400">{fmtTs(v.createdAt)}</span>
                                <span className="font-bold text-slate-200">{v.reviewerName}</span>
                                <span className="text-slate-500">({v.reviewerRole})</span>
                                {v.reason && <span className="text-amber-300">reason: {v.reason}</span>}
                                {v.comment && <span className="text-slate-400">“{v.comment}”</span>}
                                {v.evidence && <span className="text-cyan-300 break-all">evidence: {v.evidence}</span>}
                                {v.evidencePhoto && <img src={v.evidencePhoto} alt="evidence" className="max-h-10 rounded border border-slate-700" />}
                                {v.assignedUserName && <span className="text-cyan-300">→ {v.assignedUserName}</span>}
                                {v.resolvedByName && <span className="text-emerald-300">verified & closed by {v.resolvedByName} · {fmtTs(v.resolvedAt)} · {v.resolutionNote}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {records.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500 text-sm">No records match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── ISSUES ──────────────────────────────────────────────── */}
      {tab === "ISSUES" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {(["OPEN", "FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "RESOLVED", "VERIFIED", "ALL"] as const).map((v) => (
              <button key={v} onClick={() => setIssuesView(v)} data-testid={`aud-issues-${v}`}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border ${issuesView === v ? "bg-teal-500/15 text-teal-300 border-teal-500/40" : "bg-slate-900 text-slate-400 border-slate-700/80"}`}>
                {v === "OPEN" ? "Needs attention" : v === "ALL" ? "All" : STEP_LABEL[v]} ({issueCountBy(v)})
              </button>
            ))}
          </div>
          {issues.length === 0 && <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-8 text-center text-slate-500 text-sm">{issuesView === "OPEN" ? "Nothing needs attention — every issue is verified & closed or waiting on verification." : "Nothing here yet."}</div>}
          {issues.map((i: Rev) => (
            <div key={i.id} className={`bg-slate-900 border rounded-xl p-4 space-y-3 ${focusIssue === i.id ? "border-amber-400/60 ring-1 ring-amber-400/40" : "border-slate-700/80"}`} data-testid={`aud-issue-${i.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${STATE_TINT[i.status] || STATE_TINT.FLAGGED}`} data-testid={`aud-issue-status-${i.id}`}>{STEP_LABEL[i.status] || i.status}</span>
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${MODULE_TINT[i.module]}`}>{i.module}</span>
                {i.issueTitle && <span className="font-black text-slate-100 text-xs">{i.issueTitle}</span>}
                <span className="ml-auto text-[10px] text-slate-500">raised {fmtTs(i.createdAt)}</span>
              </div>
              <PipelineSteps status={i.status} />
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="font-mono text-[10px] text-cyan-300">{i.recordRef}</span>
                <span className="text-slate-300 text-xs">{i.recordTitle}</span>
                <span className="text-slate-500">{bizName(i.businessId)} · {i.branchCode || bizCode(i.businessId)}</span>
                <span className="text-[9px] text-slate-500">· stays linked to the original record</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                <span>Auditor: <span className="font-bold text-slate-300">{i.reviewerName}</span> ({i.reviewerRole})</span>
                <span className="flex items-center gap-1">· Assigned to:
                  <span className={`inline-flex items-center gap-1 font-bold px-1.5 py-0.5 rounded border ${i.assignedUserName ? "text-cyan-300 bg-cyan-500/10 border-cyan-500/30" : "text-slate-500 bg-slate-800 border-slate-700"}`} data-testid={`aud-issue-assigned-${i.id}`}>
                    <User className="w-3 h-3" />{i.assignedUserName ? `${i.assignedUserName} (${i.assignedUserRole})` : i.workerName || "no account matched"}
                  </span>
                </span>
              </div>
              {i.reason && <div className="text-xs text-amber-200 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {i.reason}</div>}
              {i.comment && <div className="text-xs text-slate-300">“{i.comment}”</div>}
              <div className="flex flex-wrap items-start gap-3">
                {i.evidence && <div className="text-[11px] text-cyan-300 break-all">Evidence: {i.evidence}</div>}
                {i.evidencePhoto && <img src={i.evidencePhoto} alt="flag evidence" className="max-h-32 rounded-lg border border-slate-700" data-testid={`aud-issue-photo-${i.id}`} />}
              </div>

              {i.responseAt && (
                <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2 space-y-1" data-testid={`aud-issue-response-${i.id}`}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-300 flex items-center gap-1.5">
                    <Send className="w-3 h-3" /> Response from {i.responseByName} · {fmtTs(i.responseAt)}
                  </div>
                  <div className="text-[11px] text-slate-200">“{i.responseNote}”</div>
                  {i.responseEvidence && <div className="text-[10px] text-cyan-300">evidence: {i.responseEvidence}</div>}
                  {i.responsePhoto && <img src={i.responsePhoto} alt="response evidence" className="max-h-28 rounded-lg border border-slate-700 mt-1" data-testid={`aud-issue-resp-photo-${i.id}`} />}
                </div>
              )}

              {i.status === "VERIFIED" && (
                <div className="rounded-lg bg-teal-500/10 border border-teal-500/20 px-3 py-2 text-[11px] text-teal-200" data-testid={`aud-issue-closed-${i.id}`}>
                  Verified & closed by <span className="font-bold">{i.resolvedByName}</span> · {fmtTs(i.resolvedAt)} — {i.resolutionNote}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {(data?.threads?.[i.id]?.length || 0) > 0 && (
                  <button onClick={() => setThreadId(threadId === i.id ? null : i.id)} className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-200" data-testid={`aud-issue-thread-${i.id}`}>
                    <History className="w-3 h-3" /> Full history ({data.threads[i.id].length})
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {i.status !== "VERIFIED" && (
                    <>
                      <button onClick={() => { setCorrectModal(i); setCorrectNote(""); setModalError(""); }} className="px-2.5 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/40 text-amber-300 border border-amber-500/30 text-[10px] font-bold" data-testid={`aud-issue-correct-${i.id}`}>
                        Request correction
                      </button>
                      <button onClick={() => { setVerifyModal(i); setVerifyNote(""); setModalError(""); }} className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold" data-testid={`aud-issue-verify-${i.id}`}>
                        Review response & verify
                      </button>
                    </>
                  )}
                </div>
              </div>

              {threadId === i.id && (
                <div className="space-y-1.5 border-l-2 border-slate-700 pl-3" data-testid={`aud-issue-thread-panel-${i.id}`}>
                  {(data?.threads?.[i.id] || []).map((t: any) => (
                    <div key={t.id} className="text-[10px] text-slate-400">
                      <span className={`text-[8px] font-bold px-1 py-0.5 rounded border mr-1 ${ACTION_TINT[t.action] || ACTION_TINT.INFO}`}>{t.action}</span>
                      <span className="font-bold text-slate-200">{t.actorName}</span>
                      <span className="text-slate-500"> ({t.actorRole}) · {fmtTs(t.createdAt)}</span>
                      {(t.statusFrom || t.statusTo) && <span className="text-slate-500"> · {t.statusFrom ? STEP_LABEL[t.statusFrom] || t.statusFrom : "new"} → {STEP_LABEL[t.statusTo || ""] || t.statusTo}</span>}
                      {t.note && <div className="text-slate-300 mt-0.5">“{t.note}”</div>}
                      {t.evidence && <div className="text-cyan-300/80">evidence: {t.evidence}</div>}
                      {t.photo && <img src={t.photo} alt="thread evidence" className="max-h-24 rounded border border-slate-700 mt-1" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── REPORTS ─────────────────────────────────────────────── */}
      {tab === "REPORTS" && report && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-white flex items-center gap-2"><BarChart3 className="w-4 h-4 text-teal-400" /> Performance, compliance, financial discrepancies & issues</h4>
            <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold" data-testid="aud-csv">
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" /> Reviews CSV
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="aud-chart-module">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Reviews & issues by module</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={report.byModule}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="module" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="verified" name="Verified" stackId="a" fill="#34d399" />
                  <Bar dataKey="openIssues" name="Open issues" stackId="a" fill="#f87171" />
                  <Bar dataKey="reviews" name="Reviews" fill="#14b8a6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="aud-chart-actions">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Review action mix</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie dataKey="value" nameKey="name" innerRadius={55} outerRadius={85}
                    data={[
                      { name: "Verified", value: reviews.filter((r: Rev) => r.action === "VERIFIED").length },
                      { name: "Flagged", value: reviews.filter((r: Rev) => r.action === "FLAGGED").length },
                      { name: "Corrections", value: reviews.filter((r: Rev) => r.action === "CORRECTION_REQUESTED").length },
                      { name: "Comments", value: reviews.filter((r: Rev) => r.action === "COMMENT").length },
                    ].filter((d) => d.value > 0)}>
                    {[0, 1, 2, 3].map((i) => <Cell key={i} fill={DONUT_COLORS[i]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="aud-chart-trend">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Review activity — last 6 months</div>
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={report.trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="reviews" name="Reviews" stroke="#14b8a6" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="issues" name="Issues raised" stroke="#f87171" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="resolved" name="Resolved" stroke="#34d399" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="aud-chart-biz">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Open vs resolved issues per business</div>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={report.byBusiness.map((b: any) => ({ ...b, name: bizCode(b.businessId) || bizName(b.businessId) }))} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis type="number" tick={{ fontSize: 9, fill: "#94a3b8" }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: "#94a3b8" }} width={90} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="openIssues" name="Open" fill="#f87171" radius={[0, 3, 3, 0]} />
                  <Bar dataKey="resolvedIssues" name="Resolved" fill="#34d399" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Compliance + performance */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4" data-testid="aud-compliance">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Compliance — review coverage by module</div>
              <div className="space-y-2.5">
                {report.byModule.map((m: any) => (
                  <div key={m.module}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-slate-200">{MODULE_LABEL[m.module] || m.module}</span>
                      <span className="text-slate-400">{m.reviews} reviews · {m.records} records · {m.openIssues} open</span>
                    </div>
                    <div className="h-1.5 rounded bg-slate-800 overflow-hidden mt-1">
                      <div className="h-full rounded bg-gradient-to-r from-teal-500 to-emerald-500" style={{ width: `${m.reviewedPct}%` }} />
                    </div>
                    <div className="text-right text-[9px] text-slate-500">{m.reviewedPct}% of records reviewed</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 overflow-x-auto" data-testid="aud-perf">
              <div className="text-[11px] font-bold text-slate-400 uppercase mb-2">Reviewer performance</div>
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500 uppercase text-[9px] tracking-wider">
                  <tr><th className="py-1.5 pr-2">Reviewer</th><th className="py-1.5 pr-2">Role</th><th className="py-1.5 pr-2 text-right">Reviews</th><th className="py-1.5 pr-2 text-right">Verified</th><th className="py-1.5 pr-2 text-right">Flags</th><th className="py-1.5 pr-2 text-right">Corrections</th><th className="py-1.5 text-right">Resolved</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {report.performance.map((p: any, i: number) => (
                    <tr key={i} className="text-slate-300">
                      <td className="py-1.5 pr-2 font-semibold text-slate-100">{p.name}</td>
                      <td className="py-1.5 pr-2">{p.role}</td>
                      <td className="py-1.5 pr-2 text-right">{p.reviews}</td>
                      <td className="py-1.5 pr-2 text-right text-emerald-300">{p.verifications}</td>
                      <td className="py-1.5 pr-2 text-right text-rose-300">{p.flags}</td>
                      <td className="py-1.5 pr-2 text-right text-amber-300">{p.corrections}</td>
                      <td className="py-1.5 text-right text-teal-300">{p.resolved || 0}</td>
                    </tr>
                  ))}
                  {report.performance.length === 0 && <tr><td colSpan={7} className="py-4 text-center text-slate-500">No review activity yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* Financial discrepancies */}
          <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden" data-testid="aud-disc">
            <div className="px-4 py-3 flex items-center justify-between bg-slate-950/60 border-b border-slate-800">
              <div className="text-[11px] font-bold text-slate-400 uppercase">Financial discrepancies — open flags & corrections on the books</div>
              <div className="text-rose-300 font-black text-sm" data-testid="aud-disc-total">{money(report.totals.flaggedAmount)}</div>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500 uppercase text-[9px] tracking-wider bg-slate-950/40">
                <tr><th className="px-4 py-2">Record</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Reason</th><th className="px-3 py-2">Business</th><th className="px-3 py-2">Raised by</th><th className="px-3 py-2 text-right">Amount</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70" data-testid="aud-disc-rows">
                {report.discrepancies.map((d: any) => (
                  <tr key={d.reviewId} className="text-slate-300">
                    <td className="px-4 py-2"><span className="font-mono text-[10px] text-cyan-300">{d.ref}</span> · {d.title}</td>
                    <td className="px-3 py-2"><span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ACTION_TINT[d.action]}`}>{d.action}</span></td>
                    <td className="px-3 py-2 text-amber-200">{d.reason || "—"}</td>
                    <td className="px-3 py-2">{bizName(d.businessId)}</td>
                    <td className="px-3 py-2">{d.raisedBy} · {fmtTs(d.raisedAt)}</td>
                    <td className="px-3 py-2 text-right font-bold text-rose-300">{d.amountGhs != null ? money(d.amountGhs) : "—"}</td>
                  </tr>
                ))}
                {report.discrepancies.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">No open discrepancies — clean books.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── ACCESS ──────────────────────────────────────────────── */}
      {tab === "ACCESS" && scope?.canGrant && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 space-y-3" data-testid="aud-grant-form">
              <h4 className="text-sm font-bold text-white flex items-center gap-2"><KeyRound className="w-4 h-4 text-teal-400" /> Grant Auditor access</h4>
              <p className="text-[10px] text-slate-500">Pick a user, one or MORE businesses, optionally narrow each to specific branches, then exactly the modules they may see and review. Re-saving the same scope updates it; the auditor only ever sees their assigned businesses, branches and sections.</p>
              <div className="space-y-2.5">
                <div>
                  <label className={labelCls}>Auditor (existing user)</label>
                  <select className={inputCls} value={grantForm.userId} onChange={(e) => setGrantForm({ ...grantForm, userId: e.target.value })} data-testid="aud-grant-user">
                    <option value="">Select user…</option>
                    {(data?.grantUsers || []).map((u: any) => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Businesses to audit (select one or more)</label>
                  <div className="flex flex-wrap gap-1.5" data-testid="aud-grant-biz-list">
                    {grantableBusinesses.map((b: any) => {
                      const on = grantForm.businessIds.includes(b.id);
                      return (
                        <button key={b.id} type="button"
                          onClick={() => setGrantForm((gf) => ({
                            ...gf,
                            businessIds: on ? gf.businessIds.filter((x) => x !== b.id) : [...gf.businessIds, b.id],
                            branches: on ? Object.fromEntries(Object.entries(gf.branches).filter(([k]) => Number(k) !== b.id)) : gf.branches,
                          }))}
                          className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition ${on ? "bg-teal-500/15 text-teal-300 border-teal-500/40" : "bg-slate-800/60 text-slate-500 border-slate-700 hover:border-slate-500"}`}
                          data-testid={`aud-grant-biz-${b.id}`}>
                          {b.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {grantForm.businessIds.map((bid) => {
                  const opts = branchOptionsFor(bid);
                  const chosen = grantForm.branches[bid] || [];
                  return (
                    <div key={bid} className="bg-slate-950/50 border border-slate-800 rounded-lg p-2.5">
                      <label className={labelCls}>{bizName(bid)} — branches <span className="normal-case text-slate-600">(none selected = all branches)</span></label>
                      <div className="flex flex-wrap gap-1.5" data-testid={`aud-grant-branches-${bid}`}>
                        {opts.map((code) => {
                          const on = chosen.includes(code);
                          return (
                            <button key={code} type="button"
                              onClick={() => setGrantForm((gf) => {
                                const cur = gf.branches[bid] || [];
                                return { ...gf, branches: { ...gf.branches, [bid]: on ? cur.filter((x) => x !== code) : [...cur, code] } };
                              })}
                              className={`px-2 py-1 rounded-lg text-[9px] font-bold border transition ${on ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40" : "bg-slate-800/60 text-slate-500 border-slate-700 hover:border-slate-500"}`}
                              data-testid={`aud-grant-branch-${bid}-${code}`}>
                              {code}
                            </button>
                          );
                        })}
                        {opts.length === 0 && <span className="text-[9px] text-slate-600">Single-branch business — grant covers it automatically.</span>}
                      </div>
                    </div>
                  );
                })}
                <div>
                  <label className={labelCls}>Note (optional)</label>
                  <input className={inputCls} value={grantForm.note} placeholder="e.g. Q3 books review" onChange={(e) => setGrantForm({ ...grantForm, note: e.target.value })} data-testid="aud-grant-note" />
                </div>
              </div>
              <div>
                <label className={labelCls}>What may they audit?</label>
                <div className="flex flex-wrap gap-1.5">
                  {MODULES.map((m) => (
                    <button key={m} type="button" onClick={() => setGrantForm({ ...grantForm, modules: grantForm.modules.includes(m) ? grantForm.modules.filter((x) => x !== m) : [...grantForm.modules, m] })}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold border transition ${grantForm.modules.includes(m) ? MODULE_TINT[m] : "bg-slate-800/60 text-slate-500 border-slate-700"}`}
                      data-testid={`aud-grant-mod-${m}`}>
                      {MODULE_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>
              {accessErr && <div className="text-[11px] text-rose-300" data-testid="aud-access-error">{accessErr}</div>}
              {accessMsg && <div className="text-[11px] text-emerald-300" data-testid="aud-access-notice">{accessMsg}</div>}
              <button onClick={submitGrant} disabled={busy || !grantForm.userId || grantForm.businessIds.length === 0 || grantForm.modules.length === 0} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-bold" data-testid="aud-grant-save">
                Save auditor access{grantForm.businessIds.length > 1 ? ` (${grantForm.businessIds.length} businesses)` : ""}
              </button>
            </div>

            {currentUser?.role === "OWNER" && (
              <div className="bg-slate-900 border border-slate-700/80 rounded-xl p-4 space-y-2" data-testid="aud-delegation">
                <h4 className="text-sm font-bold text-white flex items-center gap-2"><UserCheck className="w-4 h-4 text-cyan-400" /> Manager delegation</h4>
                <p className="text-[10px] text-slate-500">Authorize a manager to manage Auditor access for their assigned branches. Grant/revoke here is OWNER-only; managers work strictly inside their own scope.</p>
                {(data?.grantUsers || []).filter((u: any) => ["GENERAL_MANAGER", "BRANCH_MANAGER"].includes(u.role)).map((u: any) => (
                  <div key={u.id} className="flex items-center gap-2 py-1.5 border-b border-slate-800/70 last:border-0">
                    <div className="flex-1">
                      <div className="text-xs font-bold text-slate-100">{u.name}</div>
                      <div className="text-[10px] text-slate-500">{u.role} · {u.assignedBusinessId ? bizName(u.assignedBusinessId) : "All branches"}</div>
                    </div>
                    <button onClick={() => toggleDelegation(u)} disabled={busy}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border ${u.canManageAuditors ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40" : "bg-slate-800 text-slate-400 border-slate-700"}`}
                      data-testid={`aud-delegate-toggle-${u.id}`}>
                      {u.canManageAuditors ? "May manage auditors ✓" : "No delegation"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden h-fit">
            <div className="px-4 py-3 bg-slate-950/60 border-b border-slate-800 text-[11px] font-bold text-slate-400 uppercase">Active auditor grants{(data?.grants || []).filter((g: any) => g.isActive).length > 0 ? ` — ${(data?.grants || []).filter((g: any) => g.isActive).length}` : ""}</div>
            <div className="divide-y divide-slate-800/70">
              {(data?.grants || []).map((g: any) => (
                <div key={g.id} className={`px-4 py-3 space-y-1.5 ${g.isActive ? "" : "opacity-50"}`} data-testid={`aud-grant-${g.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-slate-100 text-xs">{g.userName}</span>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">{g.userRole}</span>
                    <span className="text-[10px] text-slate-400">→ {bizName(g.businessId)}{g.branchCode ? ` · ${g.branchCode}` : " · all branches"}</span>
                    <span className={`ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded border ${g.isActive ? "text-emerald-300 bg-emerald-500/15 border-emerald-500/30" : "text-slate-500 bg-slate-800 border-slate-700"}`}>{g.isActive ? "ACTIVE" : "REVOKED"}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(g.modules || []).map((m: string) => <span key={m} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${MODULE_TINT[m]}`}>{m}</span>)}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span>Granted by {g.grantedByName} · {fmtTs(g.createdAt)}</span>
                    {g.note && <span>· {g.note}</span>}
                    {g.isActive && (
                      <button onClick={() => revokeGrant(g.id)} disabled={busy} className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-[10px] font-bold" data-testid={`aud-grant-revoke-${g.id}`}>
                        <Ban className="w-3 h-3" /> Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {(data?.grants || []).length === 0 && <div className="px-4 py-8 text-center text-slate-500 text-xs">No auditor grants yet.</div>}
            </div>
          </div>
        </div>
      )}

      {/* ── AUDIT LOG ───────────────────────────────────────────── */}
      {tab === "LOG" && (
        <div className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider">
              <tr><th className="px-4 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Target</th><th className="px-3 py-2">Business</th><th className="px-3 py-2">Reason / detail</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70" data-testid="aud-log-rows">
              {log.map((l: any) => (
                <tr key={l.id} className="text-slate-300" data-testid={`aud-log-row-${l.id}`}>
                  <td className="px-4 py-2 font-mono text-[10px] whitespace-nowrap">{fmtTs(l.createdAt)}</td>
                  <td className="px-3 py-2"><span className="font-semibold text-slate-100">{l.actorName}</span> <span className="text-[9px] text-slate-500">({l.actorRole})</span></td>
                  <td className="px-3 py-2"><span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ACTION_TINT[l.action] || (l.action.includes("GRANT") || l.action === "DELEGATE" ? "text-cyan-300 bg-cyan-500/15 border-cyan-500/30" : l.action === "RESOLVE" ? ACTION_TINT.RESOLVED : "text-slate-300 bg-slate-700/40 border-slate-600")}`}>{l.action}</span></td>
                  <td className="px-3 py-2">{l.targetLabel}</td>
                  <td className="px-3 py-2">{l.businessId ? bizName(l.businessId) : "—"}{l.branchCode ? ` · ${l.branchCode}` : ""}</td>
                  <td className="px-3 py-2 text-slate-400">{l.reason || ""}{l.reason && l.detail ? " — " : ""}{l.detail || ""}</td>
                </tr>
              ))}
              {log.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">Nothing on the audit trail yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Action modal ────────────────────────────────────────── */}
      {actionModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 space-y-3" data-testid="aud-action">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-black text-white">
                  {actionModal.action === "VERIFIED" ? "Verify record" : actionModal.action === "FLAGGED" ? "Flag an issue" : actionModal.action === "CORRECTION_REQUESTED" ? "Request a correction" : "Add a comment"}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5"><span className="font-mono text-cyan-300">{actionModal.rec.ref}</span> · {actionModal.rec.title}</p>
                <p className="text-[10px] text-slate-500">{bizName(actionModal.rec.businessId)} · {actionModal.rec.branchCode || bizCode(actionModal.rec.businessId)}{actionModal.rec.workerName ? ` · worker: ${actionModal.rec.workerName}` : ""}</p>
                {(actionModal.action === "FLAGGED" || actionModal.action === "CORRECTION_REQUESTED") && (
                  <p className="text-[10px] mt-1 flex items-center gap-1 text-cyan-300" data-testid="aud-action-routing">
                    <User className="w-3 h-3" />
                    {actionModal.rec.workerName
                      ? `On save it goes straight to ${actionModal.rec.workerName}'s dashboard with a notification.`
                      : "No user account is linked to this record — the issue stays tracked here."}
                  </p>
                )}
              </div>
              <button onClick={() => setActionModal(null)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400" data-testid="aud-action-close"><X className="w-4 h-4" /></button>
            </div>
            {(actionModal.action === "FLAGGED" || actionModal.action === "CORRECTION_REQUESTED") && (
              <div>
                <label className={labelCls}>Issue title (optional — short label for dashboards)</label>
                <input className={inputCls} value={actionForm.issueTitle} placeholder={`e.g. ${actionModal.action === "FLAGGED" ? "Missing deposit slip" : "Quantity mismatch"}`} onChange={(e) => setActionForm({ ...actionForm, issueTitle: e.target.value })} data-testid="aud-action-title" />
              </div>
            )}
            <div>
              <label className={labelCls}>{actionModal.action === "VERIFIED" ? "Verification basis (optional)" : actionModal.action === "COMMENT" ? "Topic (optional)" : "Reason *"}</label>
              <input className={inputCls} value={actionForm.reason} placeholder={actionModal.action === "FLAGGED" ? "e.g. Amount does not match the MoMo statement" : actionModal.action === "CORRECTION_REQUESTED" ? "e.g. Wrong quantity received" : "e.g. Matched against the MoMo statement"} onChange={(e) => setActionForm({ ...actionForm, reason: e.target.value })} data-testid="aud-action-reason" />
            </div>
            <div>
              <label className={labelCls}>Comment</label>
              <textarea className={`${inputCls} h-20`} value={actionForm.comment} placeholder="Notes for the worker / next reviewer…" onChange={(e) => setActionForm({ ...actionForm, comment: e.target.value })} data-testid="aud-action-comment" />
            </div>
            <div>
              <label className={labelCls}>Evidence (note / document link / receipt no.)</label>
              <input className={inputCls} value={actionForm.evidence} placeholder="e.g. photos drive link, receipt number…" onChange={(e) => setActionForm({ ...actionForm, evidence: e.target.value })} data-testid="aud-action-evidence" />
            </div>
            <div>
              <label className={labelCls}>Photo evidence</label>
              <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-300 cursor-pointer" data-testid="aud-action-photo-btn">
                <ImagePlus className="w-3.5 h-3.5 text-teal-400" /> {actionForm.photo ? "Photo attached ✓ — stored with the issue" : "Attach a photo (screenshot, receipt, scene…)"}
                <input type="file" accept="image/*" className="hidden" onChange={onPhoto((v) => setActionForm((f) => ({ ...f, photo: v })), setActError)} data-testid="aud-action-photo" />
              </label>
              {actionForm.photo && <img src={actionForm.photo} alt="evidence preview" className="max-h-28 rounded-lg border border-slate-700 mt-2" data-testid="aud-action-photo-preview" />}
            </div>
            {actError && <div className="text-[11px] text-rose-300" data-testid="aud-action-error">{actError}</div>}
            <button onClick={submitAction} disabled={busy} className={`w-full py-2.5 rounded-lg text-white text-xs font-bold ${actionModal.action === "VERIFIED" ? "bg-emerald-600 hover:bg-emerald-500" : actionModal.action === "FLAGGED" ? "bg-rose-600 hover:bg-rose-500" : actionModal.action === "CORRECTION_REQUESTED" ? "bg-amber-600 hover:bg-amber-500" : "bg-teal-600 hover:bg-teal-500"}`} data-testid="aud-action-submit">
              {actionModal.action === "VERIFIED" ? "Mark verified" : actionModal.action === "FLAGGED" ? "Raise flag" : actionModal.action === "CORRECTION_REQUESTED" ? "Request correction" : "Post comment"}
            </button>
          </div>
        </div>
      )}

      {/* ── Verify & close modal (review the response, then close) ── */}
      {verifyModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 space-y-3" data-testid="aud-verify">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-black text-white">Review response & verify</h3>
                <p className="text-[11px] text-slate-400 mt-0.5"><span className="font-mono text-cyan-300">{verifyModal.recordRef}</span> — {verifyModal.issueTitle || verifyModal.reason}</p>
                <p className="text-[10px] text-slate-500">Assigned to {verifyModal.assignedUserName || verifyModal.workerName || "—"} · current status {STEP_LABEL[verifyModal.status] || verifyModal.status}</p>
              </div>
              <button onClick={() => setVerifyModal(null)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400" data-testid="aud-verify-close"><X className="w-4 h-4" /></button>
            </div>
            {verifyModal.responseNote && (
              <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Latest response — {verifyModal.responseByName}</div>
                <div className="text-[11px] text-slate-200 mt-0.5">“{verifyModal.responseNote}”</div>
                {verifyModal.responseEvidence && <div className="text-[10px] text-cyan-300 mt-0.5">evidence: {verifyModal.responseEvidence}</div>}
              </div>
            )}
            <div>
              <label className={labelCls}>Verification note — what did you confirm? *</label>
              <textarea className={`${inputCls} h-20`} value={verifyNote} placeholder="e.g. Deposit slip received and matched — books stand." onChange={(e) => setVerifyNote(e.target.value)} data-testid="aud-verify-note" />
            </div>
            {modalError && <div className="text-[11px] text-rose-300" data-testid="aud-verify-error">{modalError}</div>}
            <button onClick={submitVerify} disabled={busy || !verifyNote.trim()} className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold" data-testid="aud-verify-submit">
              Verify & close issue
            </button>
          </div>
        </div>
      )}

      {/* ── Request correction modal (sends it back to the assignee) ─ */}
      {correctModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-5 space-y-3" data-testid="aud-correct">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-black text-white">Request correction</h3>
                <p className="text-[11px] text-slate-400 mt-0.5"><span className="font-mono text-cyan-300">{correctModal.recordRef}</span> — {correctModal.issueTitle || correctModal.reason}</p>
                <p className="text-[10px] text-cyan-300 mt-0.5">Sent straight to {correctModal.assignedUserName || correctModal.workerName || "the assigned user"}'s dashboard with a notification.</p>
              </div>
              <button onClick={() => setCorrectModal(null)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400" data-testid="aud-correct-close"><X className="w-4 h-4" /></button>
            </div>
            {correctModal.responseNote && (
              <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">Their response you're sending back</div>
                <div className="text-[11px] text-slate-200 mt-0.5">“{correctModal.responseNote}”</div>
              </div>
            )}
            <div>
              <label className={labelCls}>What must they correct or complete? *</label>
              <textarea className={`${inputCls} h-20`} value={correctNote} placeholder="e.g. The slip still doesn't cover Saturday's sales — re-upload the full weekend deposit." onChange={(e) => setCorrectNote(e.target.value)} data-testid="aud-correct-note" />
            </div>
            {modalError && <div className="text-[11px] text-rose-300" data-testid="aud-correct-error">{modalError}</div>}
            <button onClick={submitCorrect} disabled={busy || !correctNote.trim()} className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-bold" data-testid="aud-correct-submit">
              Send correction request
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
