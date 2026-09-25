"use client";

/**
 * Farm Advisor Console — two faces of one screen:
 *
 *  mode "advisor" (role FARM_ADVISOR): the pre-visit / remote-monitoring
 *  home. Engagement scope + expiry per granted unit, open follow-ups across
 *  units (overdue first), recent notes with AI severity + data-corroboration
 *  chips, per-unit stats, and one-tap jumps into the (read-only) farm units.
 *
 *  mode "manage" (OWNER / GENERAL_MANAGER): the OWNER-controlled access
 *  console — grant / extend / revoke advisor access per farm unit with an
 *  optional expiry date and scope note, plus the group-wide note overview.
 *
 * All authorization is server-side (/api/advisor, /api/advisor-notes); this
 * component only renders what those endpoints return for the caller.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  Landmark,
  Lock,
  Plus,
  ShieldCheck,
  Stethoscope,
  Undo2,
} from "lucide-react";
import { AdvisorNoteComposer } from "./AdvisorNotesPanel";
import AdvisorSectionPicker from "./AdvisorSectionPicker";
import { farmModuleOfBusiness } from "@/lib/advisorSections";
import { isFarmBusinessCategory } from "@/lib/businessTypeKeys";

const PRI_STYLE: Record<string, string> = {
  CRITICAL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  HIGH: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  MEDIUM: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  LOW: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};
const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  IN_PROGRESS: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  ADDRESSED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CLOSED: "bg-slate-500/15 text-slate-300 border-slate-500/40",
};
// Shared farm-type vocabulary (single source of truth in lib/businessTypes).
const today = new Date().toISOString().slice(0, 10);

export default function AdvisorConsole({
  mode,
  currentUser,
  businesses,
  onSelectTab,
}: {
  mode: "advisor" | "manage";
  currentUser: any;
  businesses: any[];
  onSelectTab?: (tab: string) => void;
}) {
  const [console_, setConsole] = useState<any>(null);
  const [grants, setGrants] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeBiz, setComposeBiz] = useState<number | null>(null);

  // Manage-mode grant form state
  const [advisorId, setAdvisorId] = useState("");
  const [pickedBiz, setPickedBiz] = useState<Set<number>>(new Set());
  // Per-unit section visibility for the grant being composed: businessId →
  // section list (null = all — default for untouched units).
  const [pickedSections, setPickedSections] = useState<Record<number, string[] | null>>({});
  const [validUntil, setValidUntil] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const [c, g] = await Promise.all([
        fetch("/api/advisor-notes?console=1").then((r) => r.json()).catch(() => null),
        mode === "manage"
          ? fetch("/api/advisor").then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (c?.success) setConsole(c);
      else if (c) setErr(c.error || "Could not load the advisor console.");
      if (mode === "manage" && g) {
        if (g.success) setGrants(g);
        else setErr(g.error || "Could not load advisor grants.");
      }
    } catch {
      setErr("Network error — try again.");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    load();
  }, [load]);

  const grant = async () => {
    setGrantBusy(true);
    setGrantMsg("");
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: Number(advisorId),
          businessIds: [...pickedBiz],
          validUntil: validUntil || null,
          scopeNote: scopeNote || null,
          sectionsByBusiness: Object.fromEntries(
            [...pickedBiz]
              .filter((bid) => pickedSections[bid] !== undefined)
              .map((bid) => [String(bid), pickedSections[bid]])
          ),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        setGrantMsg(d.error || "Grant failed.");
        return;
      }
      setGrantMsg(`Access granted to ${d.granted} unit(s)${d.reactivated ? `, ${d.reactivated} re-activated` : ""}.`);
      setPickedBiz(new Set());
      setPickedSections({});
      setValidUntil("");
      setScopeNote("");
      await load();
    } catch {
      setGrantMsg("Network error — try again.");
    } finally {
      setGrantBusy(false);
    }
  };

  const patchAssignment = async (assignmentId: number, patch: any) => {
    await fetch("/api/advisor", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId, ...patch }),
    });
    await load();
  };

  const assignments: any[] = useMemo(() => {
    if (mode === "advisor") return console_?.assignments || [];
    return grants?.assignments || [];
  }, [mode, console_, grants]);

  const openFollowUps: any[] = console_?.openFollowUps || [];
  const recentNotes: any[] = console_?.notes || [];
  const units: any[] = console_?.units || [];
  const stats = console_?.stats;

  const bizById = useCallback((id: number) => businesses.find((b) => Number(b.id) === Number(id)), [businesses]);

  return (
    <div className="space-y-5" data-testid="advisor-console">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-teal-500/30 bg-gradient-to-br from-teal-950/60 via-slate-900 to-slate-900 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-teal-500/15 border border-teal-500/30">
              {mode === "advisor" ? <Stethoscope className="w-6 h-6 text-teal-300" /> : <ShieldCheck className="w-6 h-6 text-teal-300" />}
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-white flex items-center gap-2">
                {mode === "advisor" ? "Farm Advisor Console" : "Farm Advisors — Access & Guidance"}
              </h1>
              <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
                {mode === "advisor"
                  ? "Your engagement across the farm units the OWNER granted. Monitor read-only, file observations & recommendations, and track every follow-up to closure."
                  : "OWNER-controlled access for external Farm Advisors: grant per-unit read-only monitoring with an optional expiry, and follow every advisor note & follow-up across the group."}
              </p>
            </div>
          </div>
          {mode === "advisor" && (
            <span className="flex items-center gap-1.5 text-[10px] font-black px-2 py-1 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/40">
              <Lock className="w-3 h-3" /> READ-ONLY MONITOR
            </span>
          )}
        </div>
        {mode === "advisor" && stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
            {[
              { label: "Open follow-ups", value: stats.open + stats.inProgress, color: "text-sky-300" },
              { label: "Overdue", value: stats.overdue, color: stats.overdue ? "text-rose-300" : "text-slate-300" },
              { label: "Addressed", value: stats.addressed, color: "text-emerald-300" },
              { label: "Total notes", value: stats.total, color: "text-slate-200" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl bg-slate-900/70 border border-slate-700/60 px-3 py-2.5">
                <div className={`text-xl font-extrabold ${s.color}`}>{s.value}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{s.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {err && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4" /> {err}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-400 py-8 text-center">Loading…</p>
      ) : (
        <>
          {/* ── ADVISOR MODE ────────────────────────────────────────────── */}
          {mode === "advisor" && (
            <>
              {/* Engagement scope */}
              <section>
                <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5" /> My Engagements
                </h2>
                {assignments.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-6 text-center text-xs text-slate-400">
                    No active engagements. The OWNER grants you farm-unit access (with an optional expiry) from the Users console.
                  </div>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-2.5">
                    {assignments.map((a: any) => (
                      <div
                        key={a.id}
                        className={`rounded-xl border px-4 py-3 ${a.effective ? "border-teal-500/30 bg-slate-900/70" : "border-slate-700/60 bg-slate-900/40 opacity-70"}`}
                        data-testid={`advisor-engagement-${a.businessCode || a.businessId}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-bold text-sm text-white truncate">{a.businessName}</div>
                          {a.effective ? (
                            <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">ACTIVE</span>
                          ) : (
                            <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-300 border border-slate-500/40">
                              {a.expired ? "EXPIRED" : "REVOKED"}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 space-y-0.5">
                          {a.scopeNote && <p>Scope: {a.scopeNote}</p>}
                          <p>
                            {a.validUntil ? `Access until ${a.validUntil}` : "No expiry"} · granted by {a.grantedByName}
                          </p>
                        </div>
                        {a.effective && onSelectTab && a.businessCode && (
                          <button
                            onClick={() => onSelectTab(a.businessCode)}
                            data-testid={`advisor-open-unit-${a.businessCode}`}
                            className="mt-2 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-[11px] font-bold"
                          >
                            Open unit (read-only)
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Open follow-ups */}
              <section>
                <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5" /> Open Follow-ups {openFollowUps.length > 0 && `(${openFollowUps.length})`}
                </h2>
                {openFollowUps.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-5 text-center text-xs text-slate-400">
                    Nothing open — every recommendation has been addressed. 🎉
                  </div>
                ) : (
                  <div className="space-y-2">
                    {openFollowUps.slice(0, 12).map((n: any) => {
                      const overdue = n.followUpDueDate && String(n.followUpDueDate) < today;
                      return (
                        <div key={n.id} className={`rounded-xl border px-4 py-3 ${overdue ? "border-rose-500/40 bg-rose-950/20" : "border-slate-700/60 bg-slate-900/60"}`}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${PRI_STYLE[n.priority] || PRI_STYLE.MEDIUM}`}>{n.priority}</span>
                            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${STATUS_STYLE[n.followUpStatus] || ""}`}>
                              {String(n.followUpStatus).replace("_", " ")}
                            </span>
                            {overdue && <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/40">OVERDUE — due {n.followUpDueDate}</span>}
                            <span className="text-[10px] text-slate-500">{n.businessName}</span>
                          </div>
                          <div className="text-xs font-bold text-slate-100 mt-1">{n.title}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {n.noteDate} · {n.flockLabel || n.batchLabel || "whole farm"}{n.followUpDueDate && !overdue ? ` · due ${n.followUpDueDate}` : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Recent notes */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <BookOpenCheck className="w-3.5 h-3.5" /> My Recent Notes
                  </h2>
                  {assignments.some((a: any) => a.effective) && (
                    <div className="flex items-center gap-1.5">
                      <select
                        value={composeBiz || ""}
                        onChange={(e) => setComposeBiz(Number(e.target.value) || null)}
                        className="px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-[11px] focus:outline-none"
                      >
                        <option value="">Choose unit…</option>
                        {assignments.filter((a: any) => a.effective).map((a: any) => (
                          <option key={a.id} value={a.businessId}>{a.businessName}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => composeBiz && setComposing(true)}
                        disabled={!composeBiz}
                        data-testid="advisor-console-new-note"
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-[11px] font-bold"
                      >
                        <Plus className="w-3 h-3" /> New note
                      </button>
                    </div>
                  )}
                </div>
                {recentNotes.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-5 text-center text-xs text-slate-400">
                    No notes yet — file your first observation after your next monitoring round.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {recentNotes.slice(0, 10).map((n: any) => (
                      <div key={n.id} className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${PRI_STYLE[n.priority] || PRI_STYLE.MEDIUM}`}>{n.priority}</span>
                          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${STATUS_STYLE[n.followUpStatus] || ""}`}>
                            {String(n.followUpStatus).replace("_", " ")}
                          </span>
                          {n.aiSeverity === "URGENT" && <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/40">AI: URGENT</span>}
                          <span className="text-[10px] text-slate-500">{n.businessName} · {n.noteDate}</span>
                        </div>
                        <div className="text-xs font-bold text-slate-100 mt-1">{n.title}</div>
                        {n.aiSummary && <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">{n.aiSummary}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {/* ── MANAGE MODE ─────────────────────────────────────────────── */}
          {mode === "manage" && grants && (
            <>
              {/* Grant form */}
              <section className="rounded-2xl border border-slate-700/60 bg-slate-900/70 p-4 sm:p-5" data-testid="advisor-grant-form">
                <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
                  <ShieldCheck className="w-4 h-4 text-teal-400" /> Grant Advisor Access
                </h2>
                <div className="space-y-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Advisor account *</label>
                      <select
                        value={advisorId}
                        onChange={(e) => setAdvisorId(e.target.value)}
                        data-testid="advisor-grant-advisor-select"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                      >
                        <option value="">Choose advisor…</option>
                        {(grants.advisors || []).map((a: any) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({a.email}){a.isActive === false ? " — INACTIVE" : ""}
                          </option>
                        ))}
                      </select>
                      {(grants.advisors || []).length === 0 && (
                        <p className="text-[10px] text-slate-500 mt-1">
                          No advisor accounts yet — create one in Users &amp; Access with the role “Farm Advisor”, then grant units here.
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Access expires (optional)</label>
                      <input
                        type="date"
                        value={validUntil}
                        min={today}
                        onChange={(e) => setValidUntil(e.target.value)}
                        data-testid="advisor-grant-valid-until"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Farm units * <span className="text-slate-500 normal-case font-medium">(farm types highlighted)</span></label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
                      {(grants.businesses || []).map((b: any) => {
                        const farm = isFarmBusinessCategory(b.category);
                        const on = pickedBiz.has(Number(b.id));
                        return (
                          <button
                            key={b.id}
                            onClick={() =>
                              setPickedBiz((prev) => {
                                const next = new Set(prev);
                                if (on) next.delete(Number(b.id));
                                else next.add(Number(b.id));
                                return next;
                              })
                            }
                            data-testid={`advisor-grant-biz-${b.code}`}
                            className={`text-left px-2.5 py-2 rounded-lg border text-[11px] font-semibold transition ${
                              on
                                ? "bg-teal-500/20 border-teal-400/60 text-teal-200"
                                : farm
                                  ? "bg-slate-800/80 border-emerald-600/40 text-slate-200 hover:border-emerald-500/60"
                                  : "bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-500"
                            }`}
                          >
                            <div className="truncate">{b.name}</div>
                            <div className="text-[9px] font-mono opacity-70">{b.code}{farm ? " · FARM" : ""}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {[...pickedBiz]
                    .map((bid) => (grants.businesses || []).find((b: any) => Number(b.id) === Number(bid)))
                    .filter((b: any) => !!b && farmModuleOfBusiness(b))
                    .length > 0 && (
                    <div className="space-y-2.5 rounded-lg border border-slate-700/60 bg-slate-900/60 p-2.5">
                      <div className="text-[10px] text-slate-400">
                        Section visibility per selected farm unit — uncheck what this advisor must <b>not</b> see (default: all).
                      </div>
                      {[...pickedBiz]
                        .map((bid) => (grants.businesses || []).find((b: any) => Number(b.id) === Number(bid)))
                        .filter((b: any) => !!b && farmModuleOfBusiness(b))
                        .map((b: any) => (
                          <AdvisorSectionPicker
                            key={b.id}
                            business={b}
                            value={pickedSections[Number(b.id)] ?? null}
                            onChange={(next) => setPickedSections((prev) => ({ ...prev, [Number(b.id)]: next }))}
                            compact
                            testidPrefix="console-sec"
                          />
                        ))}
                    </div>
                  )}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Scope note (optional)</label>
                    <input
                      value={scopeNote}
                      onChange={(e) => setScopeNote(e.target.value)}
                      placeholder="e.g. Growth & health review only"
                      data-testid="advisor-grant-scope-note"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                    />
                  </div>
                  {grantMsg && (
                    <div className={`text-xs rounded-lg px-3 py-2 border ${grantMsg.includes("granted") ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" : "text-rose-300 bg-rose-500/10 border-rose-500/30"}`}>
                      {grantMsg}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={grant}
                      disabled={grantBusy || !advisorId || pickedBiz.size === 0}
                      data-testid="advisor-grant-submit"
                      className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> {grantBusy ? "Granting…" : `Grant access (${pickedBiz.size} unit${pickedBiz.size === 1 ? "" : "s"})`}
                    </button>
                  </div>
                </div>
              </section>

              {/* Assignments table */}
              <section>
                <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                  <Landmark className="w-3.5 h-3.5" /> Active Grants ({assignments.filter((a: any) => a.isActive && (!a.validUntil || a.validUntil >= today)).length})
                </h2>
                {assignments.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-5 text-center text-xs text-slate-400">
                    No grants yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-700/60">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px]">
                        <tr>
                          <th className="px-3 py-2.5">Advisor</th>
                          <th className="px-3 py-2.5">Unit</th>
                          <th className="px-3 py-2.5">Scope</th>
                          <th className="px-3 py-2.5">Expires</th>
                          <th className="px-3 py-2.5">State</th>
                          <th className="px-3 py-2.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/60 bg-slate-900/50">
                        {assignments.map((a: any) => {
                          const expired = a.validUntil && String(a.validUntil) < today;
                          const active = a.isActive && !expired;
                          return (
                            <tr key={a.id} data-testid={`advisor-grant-row-${a.id}`}>
                              <td className="px-3 py-2.5 font-bold text-slate-100">{a.userName}</td>
                              <td className="px-3 py-2.5 text-slate-300">{bizById(a.businessId)?.name || `Unit #${a.businessId}`}</td>
                              <td className="px-3 py-2.5 text-slate-400 max-w-[180px] truncate">
                                {a.scopeNote || "—"}
                                <div className="text-[9px] text-slate-500" data-testid={`advisor-grant-sections-${a.id}`}>
                                  {a.sections === null || a.sections === undefined
                                    ? "all sections"
                                    : a.sections.length
                                      ? `${a.sections.length} section${a.sections.length === 1 ? "" : "s"}`
                                      : "no sections"}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-slate-300">{a.validUntil || "never"}</td>
                              <td className="px-3 py-2.5">
                                <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${active ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : expired ? "bg-amber-500/15 text-amber-300 border-amber-500/40" : "bg-slate-500/15 text-slate-300 border-slate-500/40"}`}>
                                  {active ? "ACTIVE" : expired ? "EXPIRED" : "REVOKED"}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <div className="flex justify-end gap-1.5">
                                  {!active && (
                                    <button
                                      onClick={() => patchAssignment(a.id, { isActive: true })}
                                      title="Re-activate"
                                      className="px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold flex items-center gap-1"
                                    >
                                      <Undo2 className="w-3 h-3" /> Re-activate
                                    </button>
                                  )}
                                  {active && (
                                    <button
                                      onClick={() => patchAssignment(a.id, { isActive: false })}
                                      data-testid={`advisor-grant-revoke-${a.id}`}
                                      className="px-2 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 text-[10px] font-bold"
                                    >
                                      Revoke
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Advisor notes overview */}
              <section>
                <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" /> Advisor Notes Across the Group
                </h2>
                {recentNotes.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-5 text-center text-xs text-slate-400">
                    No advisor notes yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {recentNotes.slice(0, 15).map((n: any) => (
                      <div key={n.id} className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-3 flex flex-wrap items-center gap-2">
                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${PRI_STYLE[n.priority] || PRI_STYLE.MEDIUM}`}>{n.priority}</span>
                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${STATUS_STYLE[n.followUpStatus] || ""}`}>
                          {String(n.followUpStatus).replace("_", " ")}
                        </span>
                        <span className="text-xs font-bold text-slate-100 truncate max-w-[280px]">{n.title}</span>
                        <span className="text-[10px] text-slate-500">{n.businessName} · {n.noteDate} · {n.authorName}</span>
                        {onSelectTab && n.businessCode && (
                          <button onClick={() => onSelectTab(n.businessCode)} className="ml-auto text-[10px] font-bold text-teal-300 hover:text-teal-200">
                            open unit →
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {composing && composeBiz != null && (
        <AdvisorNoteComposer
          businessId={composeBiz}
          currentUser={currentUser}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            setComposeBiz(null);
            load();
          }}
        />
      )}
    </div>
  );
}
