"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Building2, RefreshCw, Plus, Ban, CheckCircle2, CheckSquare, Square, Unlock, Trash2, ArchiveRestore } from "lucide-react";

type AllowedType = { key: string; label: string };

type Org = {
  id: number;
  name: string;
  slug: string;
  status: string;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  owners: { id: number; name: string; email: string; isActive: boolean }[];
  memberCount: number;
  businessCount: number;
  /** Allowed Business Types (Super-Admin-managed per Owner). */
  businessTypesRestricted: boolean;
  allowedBusinessTypes: AllowedType[];
};

/** SUPER ADMIN ONLY — Platform Owners & Organizations console.
 *  Provision new, fully-isolated Owner workspaces; suspend/reactivate them.
 *  Server-side every call is guarded by requireSuperAdmin(). */
export default function PlatformAdminPanel({ currentUser }: { currentUser: any }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", ownerName: "", ownerEmail: "", ownerPhone: "", contactPhone: "" });
  const [provisioned, setProvisioned] = useState<{ ownerEmail: string; initialPassword: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Allowed Business Types catalogue + per-org editor state.
  const [typeOptions, setTypeOptions] = useState<AllowedType[]>([]);
  const [typesOpenFor, setTypesOpenFor] = useState<number | null>(null);
  const [typeDraft, setTypeDraft] = useState<Set<string>>(new Set());
  const [typeNotice, setTypeNotice] = useState<string | null>(null);
  // Owner lifecycle: status filter + typed-confirm DELETE panel.
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "SUSPENDED" | "DELETED">("ALL");
  const [deleteFor, setDeleteFor] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/organizations", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setOrgs(data.organizations || []);
      setTypeOptions(data.businessTypeOptions || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser?.isSuperAdmin) load();
  }, [currentUser?.isSuperAdmin, load]);

  if (!currentUser?.isSuperAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-fuchsia-900/20 border border-fuchsia-500/30 rounded-2xl p-8 max-w-md text-center space-y-3">
          <h2 className="text-lg font-bold text-fuchsia-300">Platform Restricted</h2>
          <p className="text-sm text-slate-300">
            The Platform Owners console is reserved for the platform Super Admin.
          </p>
        </div>
      </div>
    );
  }

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setProvisioned({ ownerEmail: data.owner.email, initialPassword: data.initialPassword });
      setForm({ name: "", ownerName: "", ownerEmail: "", ownerPhone: "", contactPhone: "" });
      await load();
    } catch (e2: any) {
      setError(e2.message);
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (id: number, action: "SUSPEND" | "ACTIVATE") => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (action === "ACTIVATE" && statusFilter === "DELETED") setTypeNotice("Organization restored — the Owner's accounts, businesses, settings and allowed business types are exactly as before.");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  // DELETE an Owner organization: access fully revoked (accounts + sessions),
  // but every byte of their data, settings and business-type grants survives.
  const deleteOrg = async (o: Org) => {
    setBusyId(o.id);
    setError(null);
    setTypeNotice(null);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: o.id, action: "DELETE_ORGANIZATION", confirmName: deleteConfirm }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setTypeNotice(`${o.name} deleted: the Owner's access is revoked; ALL of their data (businesses, users, stock, money, settings) is preserved and restorable.`);
      setDeleteFor(null);
      setDeleteConfirm("");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  // ── Allowed Business Types management ────────────────────────────────────
  const openTypesEditor = (o: Org) => {
    setTypeNotice(null);
    setTypesOpenFor((cur) => (cur === o.id ? null : o.id));
    // restricted ⇒ tick exactly the granted set; unrestricted ⇒ pre-tick all
    // so the Super Admin can narrow it down in one pass.
    setTypeDraft(
      new Set(
        o.businessTypesRestricted
          ? o.allowedBusinessTypes.map((t) => t.key)
          : typeOptions.map((t) => t.key),
      ),
    );
  };

  const saveOrgTypes = async (o: Org, action: string, keys?: string[]) => {
    setBusyId(o.id);
    setError(null);
    setTypeNotice(null);
    try {
      const body: any = { id: o.id, action };
      if (keys) body.businessTypeKeys = keys;
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setTypeNotice(
        action === "UNRESTRICT_BUSINESS_TYPES"
          ? `${o.name}: restriction removed — the Owner may create every current and future business type.`
          : `${o.name}: allowed business types updated (${keys && keys.length ? keys.length : 0} granted). Existing businesses are untouched.`,
      );
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const inputCls =
    "w-full bg-slate-800/70 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-fuchsia-500/60";

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-fuchsia-300" /> Platform Owners &amp; Organizations
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Provision independent Owner workspaces. Each Owner receives a completely isolated organization — its own
            businesses, branches, users, customers, stock, money and alerts. Owners never see each other&apos;s data;
            you, as platform Super Admin, retain full access to everything.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && (
        <div className="bg-rose-900/20 border border-rose-500/40 rounded-xl px-4 py-3 text-sm text-rose-300">{error}</div>
      )}
      {typeNotice && (
        <div className="bg-emerald-900/20 border border-emerald-500/40 rounded-xl px-4 py-3 text-sm text-emerald-200">
          {typeNotice}
        </div>
      )}
      {provisioned && (
        <div className="bg-emerald-900/20 border border-emerald-500/40 rounded-xl px-4 py-3 text-sm text-emerald-200 space-y-1">
          <p className="font-bold">Owner provisioned successfully.</p>
          <p>
            Sign-in email: <span className="font-mono">{provisioned.ownerEmail}</span>
          </p>
          <p>
            One-time password: <span className="font-mono">{provisioned.initialPassword}</span>
          </p>
          <p className="text-xs text-emerald-300/80">
            This password is shown once — give it to the new Owner securely. They can change it after signing in.
          </p>
          <button onClick={() => setProvisioned(null)} className="mt-1 text-xs underline text-emerald-300">
            Dismiss
          </button>
        </div>
      )}

      {/* Provision form */}
      <form onSubmit={createOrg} className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Plus className="w-4 h-4 text-fuchsia-300" /> Provision New Owner
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Organization name (e.g. Accra Retail Group)"
            className={inputCls}
          />
          <input
            required
            value={form.ownerName}
            onChange={(e) => setForm({ ...form, ownerName: e.target.value })}
            placeholder="Owner full name"
            className={inputCls}
          />
          <input
            required
            type="email"
            value={form.ownerEmail}
            onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
            placeholder="Owner sign-in email (globally unique)"
            className={inputCls}
          />
          <input
            value={form.ownerPhone}
            onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })}
            placeholder="Owner phone (optional)"
            className={inputCls}
          />
          <input
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
            placeholder="Org contact phone (optional)"
            className={inputCls}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="text-xs font-bold bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg px-4 py-2 disabled:opacity-50"
        >
          {creating ? "Provisioning…" : "Provision Owner Workspace"}
        </button>
      </form>

      {/* Directory */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <th className="px-4 py-3">Organization</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Businesses</th>
              <th className="px-4 py-3">Business Types</th>
              <th className="px-4 py-3">
                <select
                  data-testid="org-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="bg-transparent text-[10px] font-bold uppercase tracking-wide text-slate-400 focus:outline-none cursor-pointer"
                >
                  <option className="bg-slate-900" value="ALL">Status: all</option>
                  <option className="bg-slate-900" value="ACTIVE">Active</option>
                  <option className="bg-slate-900" value="SUSPENDED">Suspended</option>
                  <option className="bg-slate-900" value="DELETED">Deleted</option>
                </select>
              </th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(statusFilter === "ALL" ? orgs : orgs.filter((o) => (o.status || "ACTIVE") === statusFilter)).map((o) => (
              <React.Fragment key={o.id}>
              <tr className={`border-b border-slate-800/60 last:border-0 ${o.status === "DELETED" ? "opacity-60" : ""}`}>
                <td className="px-4 py-3">
                  <div className="font-semibold text-slate-100">{o.name}</div>
                  <div className="text-xs text-slate-500">
                    #{o.id} · {o.slug}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {o.owners.length ? (
                    o.owners.map((w) => (
                      <div key={w.id} className="text-xs">
                        <span className="text-slate-200 font-medium">{w.name}</span>
                        <span className="text-slate-500"> · {w.email}</span>
                        {!w.isActive && <span className="ml-1 text-[10px] text-rose-400">(disabled)</span>}
                      </div>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-300">{o.memberCount}</td>
                <td className="px-4 py-3 text-slate-300">{o.businessCount}</td>
                <td className="px-4 py-3">
                  {o.businessTypesRestricted ? (
                    <div className="space-y-1">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {o.allowedBusinessTypes.length === 0 && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-rose-500/10 text-rose-300 border-rose-500/30">
                            NONE GRANTED
                          </span>
                        )}
                        {o.allowedBusinessTypes.map((t) => (
                          <span
                            key={t.key}
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-sky-500/10 text-sky-300 border-sky-500/30"
                          >
                            {t.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                      ALL TYPES
                    </span>
                  )}
                  {o.id !== 1 && (
                    <button
                      data-testid={`manage-types-${o.id}`}
                      onClick={() => openTypesEditor(o)}
                      className="mt-1 text-[11px] font-bold text-fuchsia-300 hover:text-fuchsia-200"
                    >
                      {typesOpenFor === o.id ? "Close" : "Manage types"}
                    </button>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded border ${
                      o.status === "ACTIVE"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : o.status === "DELETED"
                          ? "bg-slate-500/15 text-slate-400 border-slate-500/40"
                          : "bg-rose-500/15 text-rose-300 border-rose-500/30"
                    }`}
                  >
                    {o.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-3">
                  {o.id === 1 ? (
                    <span className="text-[10px] text-slate-600">main</span>
                  ) : o.status === "DELETED" ? (
                    <button
                      data-testid={`restore-org-${o.id}`}
                      onClick={() => setStatus(o.id, "ACTIVATE")}
                      disabled={busyId === o.id}
                      title="Bring the Owner back — all preserved data and access settings return unchanged"
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-sky-300 hover:text-sky-200 disabled:opacity-50"
                    >
                      <ArchiveRestore className="w-3.5 h-3.5" /> Restore
                    </button>
                  ) : (
                    <>
                      <button
                        data-testid={`suspend-org-${o.id}`}
                        onClick={() => setStatus(o.id, o.status === "ACTIVE" ? "SUSPEND" : "ACTIVATE")}
                        disabled={busyId === o.id}
                        title={
                          o.status === "ACTIVE"
                            ? "Temporarily lock every member out; data & settings fully preserved"
                            : "Reactivate — all data and access settings are back exactly as before"
                        }
                        className={`inline-flex items-center gap-1 text-[11px] font-bold disabled:opacity-50 ${
                          o.status === "ACTIVE"
                            ? "text-rose-300 hover:text-rose-200"
                            : "text-emerald-300 hover:text-emerald-200"
                        }`}
                      >
                        {o.status === "ACTIVE" ? (
                          <>
                            <Ban className="w-3.5 h-3.5" /> Suspend
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5" /> Reactivate
                          </>
                        )}
                      </button>
                      <button
                        data-testid={`delete-org-${o.id}`}
                        onClick={() => { setDeleteFor(deleteFor === o.id ? null : o.id); setDeleteConfirm(""); }}
                        disabled={busyId === o.id}
                        title="Permanently revoke the Owner's platform access — all data & settings preserved and restorable"
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-400 hover:text-rose-300 disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </>
                  )}
                  </div>
                </td>
              </tr>
              {deleteFor === o.id && (
                <tr className="bg-rose-950/20">
                  <td colSpan={7} className="px-4 py-4">
                    <div data-testid={`delete-confirm-${o.id}`} className="space-y-2 max-w-xl">
                      <div className="text-sm font-bold text-rose-200">
                        Delete Owner &quot;{o.name}&quot;?
                      </div>
                      <p className="text-[11px] text-slate-400">
                        This permanently revokes their platform access: every member
                        account is deactivated and all live sessions end.{" "}
                        <span className="text-slate-200 font-semibold">
                          Nothing is erased
                        </span>{" "}
                        — all businesses, users, customers, stock, money, ledgers,
                        settings and allowed business types remain intact and can be
                        brought back with <span className="text-sky-300 font-semibold">Restore</span>.
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          data-testid={`delete-confirm-input-${o.id}`}
                          value={deleteConfirm}
                          onChange={(e) => setDeleteConfirm(e.target.value)}
                          placeholder={`Type "${o.name}" to confirm`}
                          className="flex-1 bg-slate-800/70 border border-rose-500/40 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
                        />
                        <button
                          data-testid={`delete-confirm-btn-${o.id}`}
                          disabled={busyId === o.id || deleteConfirm.trim() !== o.name}
                          onClick={() => deleteOrg(o)}
                          className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-bold"
                        >
                          Confirm Delete
                        </button>
                        <button
                          onClick={() => { setDeleteFor(null); setDeleteConfirm(""); }}
                          className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              {typesOpenFor === o.id && (
                <tr className="bg-slate-900/50">
                  <td colSpan={7} className="px-4 py-4">
                    <div data-testid={`types-editor-${o.id}`} className="space-y-3">
                      <div>
                        <div className="text-sm font-bold text-slate-100">
                          Allowed Business Types — {o.name}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5 max-w-2xl">
                          Tick the business types this Owner is authorized to create and
                          operate, then Save. The Owner&apos;s existing businesses are{" "}
                          <span className="text-slate-300 font-semibold">never affected</span>{" "}
                          by a revocation — it only gates creating new units (enforced
                          server-side on every creation).
                        </p>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                        {typeOptions.map((t) => {
                          const on = typeDraft.has(t.key);
                          return (
                            <button
                              key={t.key}
                              type="button"
                              data-testid={`type-toggle-${o.id}-${t.key}`}
                              onClick={() =>
                                setTypeDraft((cur) => {
                                  const next = new Set(cur);
                                  if (next.has(t.key)) next.delete(t.key);
                                  else next.add(t.key);
                                  return next;
                                })
                              }
                              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition ${
                                on
                                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                                  : "bg-slate-800/60 border-slate-700 text-slate-400 opacity-80 hover:opacity-100"
                              }`}
                            >
                              {on ? (
                                <CheckSquare className="w-4 h-4 shrink-0" />
                              ) : (
                                <Square className="w-4 h-4 shrink-0" />
                              )}
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          data-testid={`save-types-${o.id}`}
                          disabled={busyId === o.id}
                          onClick={() => saveOrgTypes(o, "SET_BUSINESS_TYPES", [...typeDraft])}
                          className="px-4 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 text-white text-xs font-bold"
                        >
                          Save Allowed Types ({typeDraft.size})
                        </button>
                        <button
                          disabled={busyId === o.id}
                          onClick={() => saveOrgTypes(o, "UNRESTRICT_BUSINESS_TYPES")}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold border border-slate-700"
                        >
                          <Unlock className="w-3.5 h-3.5" /> Allow everything (remove restriction)
                        </button>
                        <span className="text-[10px] text-slate-500">
                          Saving always applies the restriction; use the latter to lift it.
                        </span>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
            {!loading && orgs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500 text-sm">
                  No organizations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
