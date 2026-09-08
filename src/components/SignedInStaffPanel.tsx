"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  UserCheck, Wifi, WifiOff, RefreshCw, ShieldCheck, ShieldOff, ShieldX,
  LogOut, Ban, CheckCircle2, Clock4, CircleDot, Lock,
} from "lucide-react";
import Avatar from "./Avatar";

/**
 * Signed-In Staff — the OWNER's (and OWNER-authorized user managers') live
 * board: who is signed in right NOW (photo, role, business, branch, sign-in
 * time), who is actually online vs idle/away, plus every account's last
 * login & logout. One-tap actions: Enable, Disable, Revoke access, or
 * force Sign-out — all enforced server-side against the existing Business /
 * Branch / Role / Permission model (delegated managers act only inside the
 * scope the OWNER granted them).
 */
export default function SignedInStaffPanel({ currentUser }: { currentUser: any }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<any>(null);
  const [filter, setFilter] = useState("ALL");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const r = await fetch("/api/staff-access");
      const d = await r.json();
      if (d.success) setData(d);
    } catch { /* next poll recovers */ } finally {
      setBusy(false);
    }
  }, []);

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

  const filtered = useMemo(() => staff.filter((s) => {
    if (filter === "SIGNED_IN") return s.signedInNow;
    if (filter === "ONLINE") return s.onlineNow;
    if (filter === "DISABLED") return s.accessStatus === "DISABLED";
    if (filter === "REVOKED") return s.accessStatus === "REVOKED";
    return true;
  }), [staff, filter]);

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

  return (
    <div className="space-y-4" data-testid="sis-root">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <UserCheck className="w-4 h-4 text-emerald-400" />
        <h4 className="text-sm font-extrabold text-white">Signed-In Staff — live presence & access control</h4>
        <span className="text-[10px] text-slate-500">auto-refreshes every 15s · actions apply instantly on every device</span>
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

      {notice && <p className="text-[11px] text-teal-300" data-testid="sis-notice">{notice}</p>}

      {/* Board */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto" data-testid="sis-table">
          {filtered.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-10" data-testid="sis-empty">No staff in this view.</p>
          ) : (
            <table className="w-full text-left text-xs min-w-[1080px]">
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
              <tbody className="divide-y divide-slate-700/60">
                {filtered.map((s) => {
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
                        <div className="text-[10px] text-slate-500">{s.businessCode} · {s.branch}{s.grantedBusinessIds.length ? ` · +${s.grantedBusinessIds.length} granted` : ""}</div>
                      </td>
                      <td className="px-3 py-3">
                        <StatusChip s={s} />
                        <div className="text-[9px] text-slate-500 mt-0.5">
                          {s.onlineNow ? "active now" : s.signedInNow ? `idle · seen ${ago(s.lastSeenAt)}` : s.lastSeenAt ? `seen ${ago(s.lastSeenAt)}` : "never seen"}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap" data-testid={`sis-since-${s.id}`}>
                        {s.signedInNow ? (
                          <>
                            <div className="text-emerald-300 font-bold">{fmtDT(s.currentSignInAt)}</div>
                            <div className="text-[9px] text-slate-500">{ago(s.currentSignInAt)}{s.sessionCount > 1 ? ` · ${s.sessionCount} sessions` : ""}</div>
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
                })}
              </tbody>
            </table>
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
