"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  UserCheck, Wifi, WifiOff, RefreshCw, ShieldCheck, ShieldOff, ShieldX,
  LogOut, Ban, CheckCircle2, Clock4, CircleDot, Lock, ChevronDown, ChevronRight,
  MonitorSmartphone, Building2, Landmark,
} from "lucide-react";
import Avatar from "./Avatar";

/**
 * Signed-In Staff — the OWNER's (and OWNER-authorized user managers') live
 * board: who is signed in right NOW (photo, role, business, branch, sign-in
 * time, device), who is actually online vs idle/away, plus every account's
 * last login & logout. One-tap actions: Enable, Disable, Revoke access, or
 * force Sign-out — all enforced server-side against the existing Business /
 * Branch / Role / Permission model (delegated managers act only inside the
 * scope the OWNER granted them).
 *
 * The board renders as Organization ▸ Business groups (server-authorized):
 *   · Super Admin sees EVERY org as its own collapsible group (+ a
 *     drill-down selector and suspended-org styling).
 *   · An Owner sees their organization as the single group header with a
 *     business filter — other owners' staff never reach this browser.
 *   · Delegated managers see unlabeled branch buckets inside their granted
 *     scope. The flat, server-scoped staff list stays the authority; all
 *     grouping is display-only.
 */
export default function SignedInStaffPanel({ currentUser }: { currentUser: any }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<any>(null);
  const [filter, setFilter] = useState("ALL");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  // Phase B: grouping UI state
  const [collapsedOrgs, setCollapsedOrgs] = useState<Record<number, boolean>>({});
  const [collapsedBiz, setCollapsedBiz] = useState<Record<string, boolean>>({});
  const [orgFilter, setOrgFilter] = useState("ALL"); // Super-Admin drill-down
  const [orgOptions, setOrgOptions] = useState<any[]>([]); // persisting selector options
  const [bizFilter, setBizFilter] = useState("ALL"); // Owner business view

  const load = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const url = orgFilter !== "ALL" ? `/api/staff-access?organizationId=${encodeURIComponent(orgFilter)}` : "/api/staff-access";
      const r = await fetch(url);
      const d = await r.json();
      if (d.success) {
        setData(d);
        // Keep the full org list for the SA selector even when drilled 1-level.
        if (d.meta?.drillOrg == null && Array.isArray(d.meta?.groups) && d.meta.groups.length) {
          const list = d.meta.groups.map((g: any) => ({ orgId: g.orgId, orgName: g.orgName, orgStatus: g.orgStatus }));
          setOrgOptions((prev) => (list.length >= prev.length ? list : prev));
        }
      }
    } catch { /* next poll recovers */ } finally {
      setBusy(false);
    }
  }, [orgFilter]);

  useEffect(() => {
    load();
    const t = setInterval(() => { load(true); setNow(Date.now()); }, 15000);
    const onVis = () => { if (document.visibilityState === "visible") load(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const act = async (payload: any, keepOpen = false) => {
    setActionBusy(Number(payload.userId));
    setNotice("");
    try {
      const r = await fetch("/api/staff-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      setNotice(d.success ? `✔ ${d.message}` : `⚠ ${d.error || "Action failed"}`);
      if (d.success) await load(true);
    } catch (e: any) {
      setNotice(`⚠ ${e?.message || "Network error"}`);
    } finally {
      setActionBusy(null);
      if (!keepOpen) setConfirmRevoke(null);
    }
  };

  const meta = data?.meta || { canView: false, canManage: false };
  const staff: any[] = data?.staff || [];
  const groups: any[] = Array.isArray(meta.groups) ? meta.groups : [];
  const scopeType: string = meta.scopeType || "";

  const filtered = useMemo(() => staff.filter((s) => {
    if (bizFilter !== "ALL" && Number(bizFilter) !== Number(s.businessId ?? 0)) return false;
    if (filter === "SIGNED_IN") return s.signedInNow;
    if (filter === "ONLINE") return s.onlineNow;
    if (filter === "DISABLED") return s.accessStatus === "DISABLED";
    if (filter === "REVOKED") return s.accessStatus === "REVOKED";
    return true;
  }), [staff, filter, bizFilter]);
  const staffById = useMemo(() => new Map(filtered.map((s) => [Number(s.id), s])), [filtered]);

  const fmtDT = (t: any) => {
    if (!t) return "—";
    const d = new Date(t);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  };
  const ago = (t: any) => {
    if (!t) return "—";
    const s = Math.max(0, (now - new Date(t).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  if (data && !meta.canView) {
    return (
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-6" data-testid="sis-root">
        <div className="flex items-center gap-2 text-slate-300 text-xs" data-testid="sis-noaccess">
          <Lock className="w-4 h-4 text-amber-400" />
          Signed-In Staff visibility is reserved for the OWNER and user managers explicitly authorized by the OWNER.
        </div>
      </div>
    );
  }

  const Chip = ({ tid, label, value, tone, icon }: any) => (
    <div className="bg-slate-900/70 border border-slate-700/70 rounded-xl px-3 py-2 flex items-center gap-2" data-testid={tid}>
      {icon}
      <div>
        <div className="text-[9px] uppercase font-bold text-slate-500">{label}</div>
        <div className={`text-sm font-extrabold ${tone}`}>{value}</div>
      </div>
    </div>
  );

  const StatusChip = ({ s }: { s: any }) => {
    if (s.accessStatus === "REVOKED")
      return <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-extrabold" data-testid={`sis-status-${s.id}`}>REVOKED</span>;
    if (s.accessStatus === "DISABLED")
      return <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-extrabold" data-testid={`sis-status-${s.id}`}>DISABLED</span>;
    if (s.onlineNow)
      return <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-extrabold inline-flex items-center gap-1" data-testid={`sis-status-${s.id}`}><CircleDot className="w-2.5 h-2.5 animate-pulse" /> ONLINE</span>;
    if (s.signedInNow)
      return <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-extrabold" data-testid={`sis-status-${s.id}`}>SIGNED IN · IDLE</span>;
    return <span className="px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-400 border border-slate-600/50 text-[10px] font-bold" data-testid={`sis-status-${s.id}`}>SIGNED OUT</span>;
  };

  // Single staff row — SAME cells/testids as the original flat board, plus
  // sign-in provenance (device / first business opened) and branch chips.
  const renderRow = (s: any) => {
    const isSelf = s.id === currentUser?.id;
    const isOwnerRow = s.role === "OWNER";
    const locked = isSelf || isOwnerRow || actionBusy === s.id;
    return (
      <tr key={s.id} className="hover:bg-slate-700/40 transition" data-testid={`sis-row-${s.id}`}>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="relative shrink-0">
              <Avatar
                name={s.name}
                url={s.photoUrl}
                testid={`sis-photo-${s.id}`}
                imgClass="w-9 h-9 rounded-full object-cover border border-slate-600"
                fallbackClass="w-9 h-9 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center font-bold text-xs text-cyan-300"
              />
              {s.onlineNow && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-800" data-testid={`sis-online-${s.id}`} />}
            </div>
            <div>
              <div className="font-bold text-slate-100">{s.name} {isSelf && <span className="text-[9px] bg-slate-700 px-1 py-0.5 rounded text-cyan-400">(You)</span>}</div>
              <div className="text-[10px] text-slate-400">{s.email}</div>
              {scopeType === "SUPER_ADMIN" && s.organizationName && (
                <div className="text-[9px] text-indigo-300/90 whitespace-nowrap" data-testid={`sis-org-${s.id}`}>
                  {s.organizationName}{s.extraOrgCount ? ` · +${s.extraOrgCount} orgs` : ""}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-3">
          <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
            s.role === "OWNER" ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
            : s.role === "GENERAL_MANAGER" ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
            : s.role === "BRANCH_MANAGER" ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
            : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"}`}
            data-testid={`sis-role-${s.id}`}>
            {s.role}
          </span>
          {s.permissions.canManageUsers && !isOwnerRow && (
            <div className="text-[9px] text-violet-300 mt-0.5" title="OWNER-authorized user manager">owner-authorized manager</div>
          )}
        </td>
        <td className="px-3 py-3" data-testid={`sis-biz-${s.id}`}>
          <div className="text-slate-200 font-semibold max-w-[170px] truncate">{s.businessName}</div>
          <div className="text-[10px] text-slate-500">{s.businessCode} · {s.branch}{s.grantedBusinessIds.length && !s.grantedBranches?.length ? ` · +${s.grantedBusinessIds.length} granted` : ""}</div>
          {Array.isArray(s.grantedBranches) && s.grantedBranches.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5 max-w-[190px]" data-testid={`sis-branches-${s.id}`}>
              {s.grantedBranches.slice(0, 3).map((b: any) => (
                <span key={b.id} className="px-1.5 py-0.5 rounded bg-slate-700/70 border border-slate-600/60 text-slate-300 text-[9px] font-bold" title={b.name}>
                  {b.code || b.name}
                </span>
              ))}
              {s.grantedBranches.length > 3 && (
                <span className="text-[9px] text-slate-500" title={s.grantedBranches.map((b: any) => b.name).join(", ")}>+{s.grantedBranches.length - 3} more</span>
              )}
            </div>
          )}
        </td>
        <td className="px-3 py-3">
          <StatusChip s={s} />
          <div className="text-[9px] text-slate-500 mt-0.5">
            {s.onlineNow ? "active now" : s.signedInNow ? `idle · seen ${ago(s.lastSeenAt)}` : s.lastSeenAt ? `seen ${ago(s.lastSeenAt)}` : "never seen"}
          </div>
          {(s.deviceLabel || s.ipHash) && (
            <div
              className="text-[9px] text-slate-400 mt-0.5 inline-flex items-center gap-1"
              data-testid={`sis-device-${s.id}`}
              title={s.ipHash ? `hashed source: ${s.ipHash}` : undefined}
            >
              <MonitorSmartphone className="w-3 h-3 text-slate-500" />
              {s.deviceLabel || "device unknown"}
            </div>
          )}
        </td>
        <td className="px-3 py-3 whitespace-nowrap" data-testid={`sis-since-${s.id}`}>
          {s.signedInNow ? (
            <>
              <div className="text-emerald-300 font-bold">{fmtDT(s.currentSignInAt)}</div>
              <div className="text-[9px] text-slate-500">{ago(s.currentSignInAt)}{s.sessionCount > 1 ? ` · ${s.sessionCount} sessions` : ""}</div>
              {s.initialBusiness && (
                <div className="text-[9px] text-cyan-300/80 inline-flex items-center gap-1" data-testid={`sis-firstbiz-${s.id}`}>
                  <Building2 className="w-2.5 h-2.5" /> via {s.initialBusiness.code || s.initialBusiness.name}
                </div>
              )}
            </>
          ) : "—"}
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-slate-300" data-testid={`sis-login-${s.id}`}>
          <div className="flex items-center gap-1"><Clock4 className="w-3 h-3 text-slate-500" />{fmtDT(s.lastLoginAt)}</div>
        </td>
        <td className="px-3 py-3 whitespace-nowrap text-slate-300" data-testid={`sis-logout-${s.id}`}>
          {s.lastLogoutAt ? (
            <div className="flex items-center gap-1"><LogOut className="w-3 h-3 text-slate-500" />{fmtDT(s.lastLogoutAt)}</div>
          ) : "—"}
        </td>
        <td className="px-3 py-3 text-center" data-testid={`sis-access-${s.id}`}>
          {s.isActive ? (
            <span className="text-emerald-400 text-[10px] font-extrabold">ENABLED</span>
          ) : (
            <span className="text-rose-400 text-[10px] font-extrabold">{s.accessStatus}</span>
          )}
          {!s.hasPassword && <div className="text-[9px] text-amber-400">needs new password</div>}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1.5">
            {s.isActive ? (
              <button
                onClick={() => act({ action: "SET_ACCESS", userId: s.id, status: "DISABLED" })}
                disabled={locked}
                className="px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 text-[10px] font-extrabold disabled:opacity-30 inline-flex items-center gap-1"
                title={isOwnerRow ? "The OWNER account can never be disabled" : isSelf ? "You cannot disable yourself" : "Disable access — signs out everywhere and blocks sign-in (reversible)"}
                data-testid={`sis-disable-${s.id}`}
              >
                <Ban className="w-3 h-3" /> Disable
              </button>
            ) : (
              <button
                onClick={() => act({ action: "SET_ACCESS", userId: s.id, status: "ACTIVE" })}
                disabled={locked}
                className="px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-300 text-[10px] font-extrabold disabled:opacity-30 inline-flex items-center gap-1"
                title="Enable access again"
                data-testid={`sis-enable-${s.id}`}
              >
                <CheckCircle2 className="w-3 h-3" /> Enable
              </button>
            )}
            <button
              onClick={() => setConfirmRevoke(s)}
              disabled={locked || s.accessStatus === "REVOKED"}
              className="px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 text-[10px] font-extrabold disabled:opacity-30 inline-flex items-center gap-1"
              title="Revoke access entirely — signs out, clears credentials, needs owner re-admission"
              data-testid={`sis-revoke-${s.id}`}
            >
              <ShieldX className="w-3 h-3" /> Revoke
            </button>
            <button
              onClick={() => act({ action: "END_SESSION", userId: s.id })}
              disabled={locked || !s.signedInNow}
              className="px-2 py-1 rounded-lg bg-slate-700/60 hover:bg-slate-600 border border-slate-600 text-slate-300 text-[10px] font-extrabold disabled:opacity-30 inline-flex items-center gap-1"
              title="Force sign-out of all devices (access stays enabled)"
              data-testid={`sis-signout-${s.id}`}
            >
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </div>
        </td>
      </tr>
    );
  };

  const THEAD = (
    <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-700">
      <tr>
        <th className="px-4 py-3">Staff</th>
        <th className="px-3 py-3">Role</th>
        <th className="px-3 py-3">Business & Branch</th>
        <th className="px-3 py-3">Presence</th>
        <th className="px-3 py-3">Signed In Since</th>
        <th className="px-3 py-3">Last Login</th>
        <th className="px-3 py-3">Last Logout</th>
        <th className="px-3 py-3 text-center">Access</th>
        <th className="px-4 py-3 text-right">Actions</th>
      </tr>
    </thead>
  );

  const groupCounts = (c: any, tid: string) => (
    <span className="ml-auto flex items-center gap-3 text-[10px] font-extrabold" data-testid={tid}>
      <span className="text-slate-400">{c?.total ?? 0} staff</span>
      <span className="text-cyan-300 inline-flex items-center gap-1"><Wifi className="w-3 h-3" /> {c?.signedIn ?? 0} in</span>
      <span className="text-emerald-300 inline-flex items-center gap-1"><CircleDot className="w-3 h-3" /> {c?.online ?? 0} online</span>
    </span>
  );

  // ── Grouped board ────────────────────────────────────────────────────────
  // Every staff row is distributed to exactly one org ▸ business bucket by
  // the server. Buckets are collapsed/expanded client-side; filtering narrows
  // the flat list first, so empty buckets simply render no rows.
  const renderBoard = () => {
    if (!groups.length) {
      // Legacy fallback (pre-Phase-A server): plain flat table.
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[1080px]">
            {THEAD}
            <tbody className="divide-y divide-slate-700/60">{filtered.map(renderRow)}</tbody>
          </table>
        </div>
      );
    }
    return (
      <div className="divide-y divide-slate-700/60">
        {groups.map((g) => {
          const buckets = (g.businesses || []).map((b: any) => ({
            ...b,
            rows: (b.staffIds || []).map((id: number) => staffById.get(Number(id))).filter(Boolean),
          })).filter((b: any) => b.rows.length > 0 || filter === "ALL");
          if (!buckets.length) return null;
          const orgCollapsed = !!collapsedOrgs[Number(g.orgId)];
          const suspended = String(g.orgStatus || "").toUpperCase() !== "ACTIVE";
          const showOrgHeader = groups.length > 1 || scopeType !== "MANAGER_BRANCHES";
          return (
            <div key={g.orgId} data-testid={`sis-groupwrap-${g.orgId}`}>
              {showOrgHeader && (
                <button
                  type="button"
                  onClick={() => setCollapsedOrgs((c) => ({ ...c, [g.orgId]: !orgCollapsed }))}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-900/80 hover:bg-slate-900 text-left border-b border-slate-700/80"
                  data-testid={`sis-group-${g.orgId}`}
                >
                  {orgCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
                  <Landmark className={`w-3.5 h-3.5 ${suspended ? "text-rose-400" : "text-indigo-300"}`} />
                  <span className="text-[11px] font-extrabold text-slate-100">{g.orgName}</span>
                  {suspended && (
                    <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[9px] font-extrabold" data-testid={`sis-groupsusp-${g.orgId}`}>
                      ORG {String(g.orgStatus).toUpperCase()}
                    </span>
                  )}
                  {groupCounts(g.counts, `sis-groupcount-${g.orgId}`)}
                </button>
              )}
              {!orgCollapsed && buckets.map((b: any) => {
                const key = `${g.orgId}:${b.businessId}`;
                const bizCollapsed = !!collapsedBiz[key];
                const showBizHeader = buckets.length > 1 || b.businessId !== 0 || scopeType === "MANAGER_BRANCHES" || groups.length > 1;
                return (
                  <div key={key}>
                    {showBizHeader && (
                      <button
                        type="button"
                        onClick={() => setCollapsedBiz((c) => ({ ...c, [key]: !bizCollapsed }))}
                        className="w-full flex items-center gap-2 px-6 py-2 bg-slate-800/70 hover:bg-slate-800 text-left border-b border-slate-700/60"
                        data-testid={`sis-bizgroup-${b.businessId}`}
                      >
                        {bizCollapsed ? <ChevronRight className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                        <Building2 className="w-3 h-3 text-cyan-400/80" />
                        <span className="text-[10.5px] font-extrabold text-slate-200">{b.businessName}</span>
                        <span className="text-[9px] text-slate-500 font-bold">{b.businessCode}</span>
                        {groupCounts(b.counts, `sis-bizgroupcount-${b.businessId}`)}
                      </button>
                    )}
                    {!bizCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs min-w-[1080px]">
                          {THEAD}
                          <tbody className="divide-y divide-slate-700/60">{b.rows.map(renderRow)}</tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  // Owner business selector options (from grouped buckets, businessId > 0).
  const bizOptions = useMemo(() => {
    const opts: { id: number; name: string }[] = [];
    for (const g of groups) {
      for (const b of g.businesses || []) {
        if (Number(b.businessId) > 0) opts.push({ id: Number(b.businessId), name: b.businessName });
      }
    }
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, [groups]);

  return (
    <div className="space-y-4" data-testid="sis-root">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <UserCheck className="w-4 h-4 text-emerald-400" />
        <h4 className="text-sm font-extrabold text-white">Signed-In Staff — live presence & access control</h4>
        <span className="text-[10px] text-slate-500">auto-refreshes every 15s · actions apply instantly on every device</span>
        {scopeType === "SUPER_ADMIN" && (
          <span className="px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 text-[9px] font-extrabold" data-testid="sis-scope-sa">
            PLATFORM VIEW · {meta.organizationCount ?? groups.length} ORGS
          </span>
        )}
        <button onClick={() => load()} className="ml-auto p-1.5 rounded-lg hover:bg-slate-700 text-slate-400" data-testid="sis-refresh" title="Refresh now">
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Chips + filter */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Chip tid="sis-kpi-signedin" label="Signed In Now" value={meta.signedInCount ?? 0} tone="text-cyan-300" icon={<Wifi className="w-4 h-4 text-cyan-400" />} />
        <Chip tid="sis-kpi-online" label="Online Now" value={meta.onlineCount ?? 0} tone="text-emerald-300" icon={<CircleDot className="w-4 h-4 text-emerald-400" />} />
        <Chip tid="sis-kpi-disabled" label="Disabled" value={meta.disabledCount ?? 0} tone="text-amber-300" icon={<ShieldOff className="w-4 h-4 text-amber-400" />} />
        <Chip tid="sis-kpi-revoked" label="Revoked" value={meta.revokedCount ?? 0} tone="text-rose-300" icon={<ShieldX className="w-4 h-4 text-rose-400" />} />
        <div className="bg-slate-900/70 border border-slate-700/70 rounded-xl px-3 py-2">
          <div className="text-[9px] uppercase font-bold text-slate-500 mb-0.5">Show</div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full bg-transparent text-xs text-white font-bold focus:outline-none" data-testid="sis-filter">
            <option value="ALL">All staff</option>
            <option value="SIGNED_IN">Signed in now</option>
            <option value="ONLINE">Online now</option>
            <option value="DISABLED">Disabled</option>
            <option value="REVOKED">Revoked</option>
          </select>
        </div>
      </div>

      {/* Scope selectors (Phase B): SA drills to one org; Owner views one business */}
      {(scopeType === "SUPER_ADMIN" && orgOptions.length > 1) || (scopeType === "OWNER_ORG" && bizOptions.length > 1) ? (
        <div className="flex flex-wrap items-center gap-2 bg-slate-800/80 border border-slate-700/70 p-2.5 rounded-xl" data-testid="sis-scopebar">
          {scopeType === "SUPER_ADMIN" && orgOptions.length > 1 && (
            <div className="flex items-center gap-2">
              <Landmark className="w-3.5 h-3.5 text-indigo-300" />
              <select
                value={orgFilter}
                onChange={(e) => { setOrgFilter(e.target.value); setBizFilter("ALL"); }}
                className="bg-slate-900/70 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white font-bold focus:outline-none"
                data-testid="sis-orgfilter"
                title="Super Admin organization drill-down — narrows the whole board to one organization"
              >
                <option value="ALL">All organizations</option>
                {orgOptions.map((o) => (
                  <option key={o.orgId} value={String(o.orgId)}>
                    {o.orgName}{String(o.orgStatus).toUpperCase() !== "ACTIVE" ? ` (${String(o.orgStatus).toUpperCase()})` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {scopeType === "OWNER_ORG" && bizOptions.length > 1 && (
            <div className="flex items-center gap-2">
              <Building2 className="w-3.5 h-3.5 text-cyan-400" />
              <select
                value={bizFilter}
                onChange={(e) => setBizFilter(e.target.value)}
                className="bg-slate-900/70 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white font-bold focus:outline-none"
                data-testid="sis-bizfilter"
                title="View one business unit (rows still grouped underneath)"
              >
                <option value="ALL">All business units</option>
                {bizOptions.map((b) => (
                  <option key={b.id} value={String(b.id)}>{b.name}</option>
                ))}
              </select>
            </div>
          )}
          {meta.drillOrg != null && (
            <span className="text-[9px] text-indigo-300/80 font-bold" data-testid="sis-drillnote">
              Platform drill-down — only this organization's staff are shown (server-enforced).
            </span>
          )}
        </div>
      ) : null}

      {notice && <p className="text-[11px] text-teal-300" data-testid="sis-notice">{notice}</p>}

      {/* Board */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div data-testid="sis-table">
          {filtered.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-10" data-testid="sis-empty">No staff in this view.</p>
          ) : (
            renderBoard()
          )}
        </div>
      </div>

      <p className="text-[10px] text-slate-500 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-violet-400" />
        Access changes link straight into the Business / Branch / Role / Permission system: a disabled or revoked account is signed out everywhere instantly and cannot sign back in. Managers only act where the OWNER granted them user-management authority.
      </p>

      {/* Revoke double-confirm */}
      {confirmRevoke && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" data-testid="sis-revoke-modal">
          <div className="w-full max-w-sm bg-slate-900 border border-rose-500/40 rounded-2xl p-5 space-y-3 shadow-2xl">
            <div className="flex items-center gap-2">
              <ShieldX className="w-5 h-5 text-rose-400" />
              <h4 className="text-sm font-extrabold text-white">Revoke access for {confirmRevoke.name}?</h4>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              This signs them out of <b>every device immediately</b>, blocks sign-in and <b>clears their password</b>.
              To re-admit them later you must <b>Enable</b> the account AND set a new password (Users &amp; Access).
              <br /><br />Use <b>Disable</b> instead for a temporary, fully reversible block.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setConfirmRevoke(null)}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-bold"
                data-testid="sis-revoke-cancel"
              >
                Cancel
              </button>
              <button
                onClick={() => act({ action: "SET_ACCESS", userId: confirmRevoke.id, status: "REVOKED" })}
                className="py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-extrabold"
                data-testid="sis-revoke-confirm"
              >
                Revoke Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
