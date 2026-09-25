"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Lock,
  PauseCircle,
  PlayCircle,
  Plus,
  ShieldCheck,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import AdvisoryDigestCard from "./AdvisoryDigestCard";
import AdvisoryNotesPanel from "./AdvisoryNotesPanel";

/**
 * AdvisoryConsole — the OWNER / manager side of the Farm Advisor feature.
 *
 *  • Grant, scope, pause and revoke advisor access (farms, branches, flocks,
 *    scopes, cost visibility, engagement window) — the Owner is in control.
 *  • Read the advisor's notes, acknowledge, action and close them.
 *  • Read the GoMina AI Advisory Digest for the selected farm.
 *
 * All writes go through /api/advisor* which re-checks authority server-side.
 */

const SCOPES: { key: string; label: string; hint: string }[] = [
  { key: "DASHBOARD", label: "Dashboard", hint: "KPIs & health score" },
  { key: "FLOCKS", label: "Flock & batch", hint: "Flock register" },
  { key: "DAILY_OPS", label: "Daily operations", hint: "Checklists & activities" },
  { key: "DAILY_NOTES", label: "Staff daily notes", hint: "Context for advice" },
  { key: "FEED_WATER", label: "Feed & water", hint: "Intake, quality" },
  { key: "GROWTH_FCR", label: "Growth & FCR", hint: "Weights vs targets" },
  { key: "MORTALITY_HEALTH", label: "Mortality & health", hint: "Vaccination, treatment" },
  { key: "PRODUCTION", label: "Production", hint: "Eggs / harvest" },
  { key: "BENCHMARK", label: "Benchmark performance", hint: "Breed standards" },
  { key: "ALERTS", label: "Alerts", hint: "Analytics warnings" },
  { key: "INVENTORY_LEVELS", label: "Inventory levels", hint: "Quantities only" },
  { key: "PHOTOS_CCTV", label: "Photos / CCTV stills", hint: "Off by default" },
];

const DEFAULT_SCOPES = SCOPES.filter((s) => s.key !== "PHOTOS_CCTV").map((s) => s.key);

export default function AdvisoryConsole({
  currentUser,
  businesses,
  users = [],
  onChanged,
}: {
  currentUser: any;
  businesses: any[];
  users?: any[];
  onChanged?: () => void;
}) {
  const [grants, setGrants] = useState<any[]>([]);
  const [advisors, setAdvisors] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>({ canManage: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [businessId, setBusinessId] = useState<number | null>(businesses?.[0]?.id ?? null);
  const [data, setData] = useState<any>(null);
  const [showGrant, setShowGrant] = useState(false);

  // new-advisor + grant form
  const [advisorUserId, setAdvisorUserId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [showCosts, setShowCosts] = useState(false);
  const [canExport, setCanExport] = useState(false);
  const [endsOn, setEndsOn] = useState("");
  const [createdPassword, setCreatedPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/advisor");
      const d = await res.json();
      if (d.success) {
        setGrants(d.grants || []);
        setAdvisors(d.advisors || []);
        setMeta(d.meta || {});
      } else setError(d.error || "Could not load advisor access.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFarm = useCallback(async () => {
    if (!businessId) return;
    try {
      const res = await fetch(`/api/advisor/data?businessId=${businessId}&windowDays=30`);
      const d = await res.json();
      if (d.success) setData(d);
    } catch { /* non-fatal */ }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFarm(); }, [loadFarm]);

  const farmGrants = useMemo(
    () => grants.filter((g) => !businessId || Number(g.businessId) === Number(businessId)),
    [grants, businessId],
  );

  const createAdvisorAccount = async () => {
    if (!newName.trim() || !newEmail.trim()) { setError("An advisor needs a name and an email."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim(), role: "ADVISOR", phone: newPhone || "+233 24 000 0000" }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not create the advisor account.");
      setCreatedPassword(d.initialPassword || d.password || "");
      setNotice(`Advisor account created for ${newName.trim()}${d.initialPassword ? ` · temporary password ${d.initialPassword}` : ""}`);
      setNewName(""); setNewEmail(""); setNewPhone("");
      await load();
      if (d.user?.id) setAdvisorUserId(String(d.user.id));
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const grantAccess = async () => {
    if (!advisorUserId || !businessId) { setError("Pick an advisor and a farm."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: Number(advisorUserId), businessId, scopes, showCosts, canExport, endsOn: endsOn || null }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not grant access.");
      setNotice("Advisor access granted.");
      setShowGrant(false);
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const patchGrant = async (id: number, patch: any) => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/advisor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || "Could not update the grant.");
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const farmStaff = useMemo(
    () => users.filter((u) => ["GENERAL_MANAGER", "BRANCH_MANAGER", "SUPERVISOR", "WORKER"].includes(String(u.role)) && u.isActive !== false),
    [users],
  );

  return (
    <div className="space-y-4 p-3 sm:p-5" data-testid="advisory-console">
      <header className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-slate-900 to-slate-950 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Stethoscope className="h-5 w-5 text-cyan-300" />
          <h1 className="text-[15px] font-black text-white">Farm Advisory</h1>
          <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-slate-400">
            External resource persons
          </span>
          {meta.canManage && (
            <button
              type="button"
              onClick={() => setShowGrant((v) => !v)}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-black text-white hover:bg-cyan-500"
              data-testid="advisory-open-grant"
            >
              <Plus className="h-3.5 w-3.5" /> Advisor access
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="advisory-farm-picker">
          {businesses.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBusinessId(b.id)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold ${Number(businessId) === Number(b.id) ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
              data-testid={`advisory-farm-${b.id}`}
            >
              {b.name}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200" data-testid="advisory-error">{error}</div>}
      {notice && <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200" data-testid="advisory-notice">{notice}</div>}

      {/* ── Grant / invite panel ── */}
      {meta.canManage && showGrant && (
        <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4 space-y-4" data-testid="advisory-grant-panel">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/50 p-3">
              <h4 className="flex items-center gap-1.5 text-[12px] font-extrabold text-white"><UserPlus className="h-4 w-4 text-cyan-300" /> Invite a new advisor</h4>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name (e.g. Dr. Ama Mensah)" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11.5px] text-white" data-testid="advisory-new-name" />
              <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11.5px] text-white" data-testid="advisory-new-email" />
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (optional)" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11.5px] text-white" data-testid="advisory-new-phone" />
              <button type="button" disabled={busy} onClick={createAdvisorAccount} className="w-full rounded-lg bg-slate-700 px-3 py-2 text-[11px] font-black text-white hover:bg-slate-600 disabled:opacity-50" data-testid="advisory-create-advisor">
                Create advisor login
              </button>
              {createdPassword && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10.5px] text-amber-200" data-testid="advisory-created-password">
                  Temporary password: <b>{createdPassword}</b> — share it securely; the advisor should change it on first sign-in.
                </p>
              )}
            </div>

            <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/50 p-3">
              <h4 className="flex items-center gap-1.5 text-[12px] font-extrabold text-white"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Grant access to this farm</h4>
              <select value={advisorUserId} onChange={(e) => setAdvisorUserId(e.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-[11.5px] text-white" data-testid="advisory-pick-advisor">
                <option value="">Select advisor…</option>
                {advisors.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.email}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-1.5">
                {SCOPES.map((s) => (
                  <label key={s.key} className="flex items-start gap-1.5 rounded-lg bg-slate-900 px-2 py-1.5 text-[10px] font-bold text-slate-300">
                    <input
                      type="checkbox"
                      checked={scopes.includes(s.key)}
                      onChange={(e) => setScopes((p) => (e.target.checked ? [...p, s.key] : p.filter((x) => x !== s.key)))}
                      data-testid={`advisory-scope-${s.key}`}
                    />
                    <span>{s.label}<span className="block text-[8.5px] font-normal text-slate-500">{s.hint}</span></span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[10.5px] font-bold text-slate-300">
                  <input type="checkbox" checked={showCosts} onChange={(e) => setShowCosts(e.target.checked)} data-testid="advisory-show-costs" /> Show costs &amp; revenue
                </label>
                <label className="flex items-center gap-1.5 text-[10.5px] font-bold text-slate-300">
                  <input type="checkbox" checked={canExport} onChange={(e) => setCanExport(e.target.checked)} data-testid="advisory-can-export" /> Allow export
                </label>
                <label className="flex items-center gap-1.5 text-[10.5px] font-bold text-slate-300">
                  Ends
                  <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[10.5px] text-white" data-testid="advisory-ends-on" />
                </label>
              </div>
              <button type="button" disabled={busy} onClick={grantAccess} className="w-full rounded-lg bg-cyan-600 px-3 py-2 text-[11px] font-black text-white hover:bg-cyan-500 disabled:opacity-50" data-testid="advisory-grant-submit">
                {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Grant advisory access"}
              </button>
              <p className="text-[9.5px] text-slate-500">
                Advisors are read-only everywhere. Finance, payroll, staff records, customers, user management and deletion are never included.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── Current grants ── */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4" data-testid="advisory-grants">
        <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-white"><Lock className="h-4 w-4 text-cyan-300" /> Advisor access on this farm</h4>
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : farmGrants.length === 0 ? (
          <p className="text-[11px] text-slate-500" data-testid="advisory-grants-empty">No advisor has access to this farm.</p>
        ) : (
          <div className="space-y-2">
            {farmGrants.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/50 px-3 py-2" data-testid={`advisory-grant-${g.id}`}>
                <span className="text-[12px] font-bold text-white">{g.userName}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-black ${g.live ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700 text-slate-400"}`} data-testid={`advisory-grant-state-${g.id}`}>
                  {g.live ? "LIVE" : g.isActive ? "OUT OF WINDOW" : "REVOKED"}
                </span>
                <span className="text-[9.5px] font-bold text-slate-500">
                  {(g.scopes || []).length} scope(s) · costs {g.showCosts ? "visible" : "hidden"}
                  {g.endsOn ? ` · until ${g.endsOn}` : " · open-ended"}
                </span>
                {meta.canManage && (
                  <div className="ml-auto flex gap-1.5">
                    <button type="button" disabled={busy} onClick={() => patchGrant(g.id, { isActive: !g.isActive })} className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold ${g.isActive ? "border border-rose-500/40 bg-rose-500/10 text-rose-300" : "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300"}`} data-testid={`advisory-toggle-${g.id}`}>
                      {g.isActive ? <><PauseCircle className="h-3 w-3" /> Revoke</> : <><PlayCircle className="h-3 w-3" /> Restore</>}
                    </button>
                    <button type="button" disabled={busy} onClick={() => patchGrant(g.id, { showCosts: !g.showCosts })} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-bold text-slate-300" data-testid={`advisory-costs-${g.id}`}>
                      {g.showCosts ? "Hide costs" : "Show costs"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Digest + notes ── */}
      <AdvisoryDigestCard digest={data?.digest} />
      <AdvisoryNotesPanel
        businessId={businessId}
        businessName={businesses.find((b) => Number(b.id) === Number(businessId))?.name}
        currentUser={currentUser}
        flocks={data?.flocks || []}
        staff={farmStaff}
        canWrite={false}
        onChanged={loadFarm}
      />
    </div>
  );
}
