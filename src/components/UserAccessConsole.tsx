"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from "lucide-react";

const ROLES = ["GENERAL_MANAGER", "BRANCH_MANAGER", "ACCOUNTANT", "SUPERVISOR", "WORKER"];
const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  GENERAL_MANAGER: "General Manager",
  BRANCH_MANAGER: "Branch Manager",
  ACCOUNTANT: "Accountant",
  SUPERVISOR: "Supervisor",
  WORKER: "Worker",
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  businesses: any[];
  currentUser: any;
  onChanged: () => Promise<unknown> | void;
}

/**
 * OWNER users & access console: create logins, assign roles / businesses /
 * extra branch access, set permissions, reset passwords, deactivate or
 * delete accounts.
 */
export default function UserAccessConsole({ isOpen, onClose, businesses, currentUser, onChanged }: Props) {
  const isOwner = currentUser?.role === "OWNER";
  // OWNER-delegated manager: trusted to administer the users inside the
  // branches they themselves can access.
  const isDelegated =
    !isOwner && !!currentUser?.canManageUsers &&
    ["BRANCH_MANAGER", "GENERAL_MANAGER"].includes(currentUser?.role);
  const [users, setUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"list" | "create" | "edit">("list");
  const [editing, setEditing] = useState<any | null>(null);
  // create/edit form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("WORKER");
  const [assignedBusinessId, setAssignedBusinessId] = useState<number | "">("");
  const [password, setPassword] = useState("");
  const [canRecordSales, setCanRecordSales] = useState(true);
  const [canRecordExpenses, setCanRecordExpenses] = useState(false);
  const [canManageStock, setCanManageStock] = useState(false);
  const [canExportData, setCanExportData] = useState(false);
  const [canManageRecords, setCanManageRecords] = useState(false);
  const [canManageCctv, setCanManageCctv] = useState(false);
  const [canManageAuditors, setCanManageAuditors] = useState(false);
  const [canManageOnline, setCanManageOnline] = useState(false);
  const [canCreateBusiness, setCanCreateBusiness] = useState(false);
  const [canViewFinance, setCanViewFinance] = useState(false);
  const [canManageSupport, setCanManageSupport] = useState(false);
  const [extraAccess, setExtraAccess] = useState<number[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [canDelegateUsers, setCanDelegateUsers] = useState(false);

  const sortedBiz = useMemo(() => [...businesses].sort((a, b) => a.id - b.id), [businesses]);

  // The delegated manager's own accessible branches (derived from their row
  // in the loaded directory: primary assignment + explicit grants).
  const meRow = users.find((u) => u.id === currentUser?.id);
  const scopeIds = useMemo(
    () =>
      new Set<number>(
        [meRow?.assignedBusinessId, ...(meRow?.extraAccessIds || [])]
          .filter((x) => x != null)
          .map(Number)
      ),
    [meRow]
  );
  // Branch picks offered to a delegated caller are capped at their scope.
  const visibleBiz = isOwner ? sortedBiz : sortedBiz.filter((b) => scopeIds.has(b.id));
  const roleOptions = isOwner ? ROLES : ["BRANCH_MANAGER", "WORKER"];
  // A delegated manager may act on a row only if that user works inside the
  // branches they manage (and never on themselves or executives).
  const canManageRow = (u: any) =>
    isOwner ||
    (isDelegated &&
      u.id !== currentUser?.id &&
      ["WORKER", "BRANCH_MANAGER"].includes(u.role) &&
      u.assignedBusinessId != null &&
      scopeIds.has(Number(u.assignedBusinessId)));

  const loadUsers = async () => {
    try {
      const res = await fetch("/api/users");
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) setUsers(d.users);
      else setError(d?.error || "Failed to load users.");
    } catch (err: any) {
      setError(err?.message || "Network error.");
    }
  };

  useEffect(() => {
    if (isOpen) {
      setView("list");
      setEditing(null);
      setError("");
      setNotice("");
      loadUsers();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;
  if (!isOwner && !isDelegated) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm text-center space-y-3">
          <ShieldCheck className="w-8 h-8 text-rose-400 mx-auto" />
          <p className="text-sm text-slate-300">Only the OWNER (or a manager the OWNER has trusted with user management) can open Users & Access.</p>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold">Close</button>
        </div>
      </div>
    );
  }

  const bizName = (id: number | null | undefined) =>
    id == null ? "All businesses" : businesses.find((b) => b.id === id)?.name || `#${id}`;

  const openCreate = () => {
    setEditing(null);
    setName("");
    setEmail("");
    setRole("WORKER");
    setAssignedBusinessId(visibleBiz[0]?.id ?? "");
    setCanDelegateUsers(false);
    setPassword("");
    setCanRecordSales(true);
    setCanRecordExpenses(false);
    setCanManageStock(false);
    setCanExportData(false);
    setCanManageRecords(false);
    setCanManageCctv(false);
    setCanManageAuditors(false);
    setCanManageSupport(false);
    setExtraAccess([]);
    setIsActive(true);
    setError("");
    setNotice("");
    setView("create");
  };

  const openEdit = (u: any) => {
    if (!canManageRow(u)) return;
    setEditing(u);
    setCanDelegateUsers(Boolean(u.canManageUsers));
    setName(u.name);
    setEmail(u.email);
    setRole(u.role);
    setAssignedBusinessId(u.assignedBusinessId ?? "");
    setPassword("");
    setCanRecordSales(Boolean(u.canRecordSales));
    setCanRecordExpenses(Boolean(u.canRecordExpenses));
    setCanManageStock(Boolean(u.canManageStock));
    setCanExportData(Boolean(u.canExportData));
    setCanManageRecords(Boolean(u.canManageRecords));
    setCanManageCctv(Boolean(u.canManageCctv));
    setCanManageAuditors(Boolean(u.canManageAuditors));
    setCanManageOnline(Boolean(u.canManageOnline));
    setCanCreateBusiness(Boolean(u.canCreateBusiness));
    setCanViewFinance(Boolean(u.canViewFinance));
    setCanManageSupport(Boolean(u.canManageSupport));
    setExtraAccess(u.extraAccessIds || []);
    setIsActive(u.isActive !== false);
    setError("");
    setNotice("");
    setView("edit");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, email, role,
          assignedBusinessId: assignedBusinessId === "" ? null : assignedBusinessId,
          password: password || undefined,
          canRecordSales, canRecordExpenses, canManageStock, canExportData, canManageRecords,
          canManageCctv: isOwner ? canManageCctv : undefined,
          canManageAuditors: isOwner ? canManageAuditors : undefined,
          canManageOnline: isOwner ? canManageOnline : undefined,
          canCreateBusiness: isOwner ? canCreateBusiness : undefined,
          canViewFinance: isOwner ? canViewFinance : undefined,
          canManageSupport: isOwner ? canManageSupport : undefined,
          canManageUsers: isOwner ? canDelegateUsers : undefined,
          extraAccessIds: extraAccess,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await loadUsers();
        await onChanged();
        setNotice(
          `Account created for ${d.user.name} (${ROLE_LABEL[d.user.role] || d.user.role}). ` +
          `Initial password: ${d.initialPassword} — share it privately; it is shown only once.`
        );
        setView("list");
      } else {
        setError(d?.error || "Failed to create user.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: editing.id,
          name, email, role,
          assignedBusinessId: assignedBusinessId === "" ? null : assignedBusinessId,
          isActive,
          canRecordSales, canRecordExpenses, canManageStock, canExportData, canManageRecords,
          canManageCctv: isOwner ? canManageCctv : undefined,
          canManageAuditors: isOwner ? canManageAuditors : undefined,
          canManageOnline: isOwner ? canManageOnline : undefined,
          canCreateBusiness: isOwner ? canCreateBusiness : undefined,
          canViewFinance: isOwner ? canViewFinance : undefined,
          canManageSupport: isOwner ? canManageSupport : undefined,
          canManageUsers: isOwner ? canDelegateUsers : undefined,
          extraAccessIds: extraAccess,
          newPassword: isOwner && password ? password : undefined,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await loadUsers();
        await onChanged();
        setNotice(
          `"${d.user.name}" updated.` +
          (password ? " Password reset — all their old sessions were signed out." : "")
        );
        setView("list");
      } else {
        setError(d?.error || "Failed to update user.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (u: any) => {
    if (!window.confirm(`Delete account "${u.name}" (${u.email})? Their data records are kept, but the login is removed.`)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/users?userId=${u.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await loadUsers();
        await onChanged();
        setNotice(`Account "${u.name}" deleted. Their sessions were revoked immediately.`);
      } else {
        setError(d?.error || "Failed to delete user.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const Toggle = ({ label, value, onChange, testid, tint = "emerald" }: any) => (
    <label className="flex items-center justify-between text-xs text-slate-300 py-1 cursor-pointer">
      <span>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        data-testid={testid}
        className={`px-2.5 py-1 rounded-md text-[10px] font-black border transition ${
          value
            ? tint === "cyan"
              ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
              : tint === "teal"
              ? "bg-teal-500/20 text-teal-300 border-teal-500/40"
              : "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
            : "bg-slate-700/70 text-slate-400 border-slate-600"
        }`}
      >
        {value ? "ON" : "OFF"}
      </button>
    </label>
  );

  const formBody = (isEdit: boolean) => (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">Full name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            data-testid="user-form-name"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">Email (login) *</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            data-testid="user-form-email"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">Role *</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}
            data-testid="user-form-role"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm">
            {roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">
            Primary business / branch {role === "WORKER" ? "*" : ""}
          </label>
          <select
            value={assignedBusinessId}
            onChange={(e) => setAssignedBusinessId(e.target.value === "" ? "" : Number(e.target.value))}
            data-testid="user-form-business"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm"
          >
            {isOwner && <option value="">— All businesses (executive) —</option>}
            {visibleBiz.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
          </select>
        </div>
      </div>

      {(!isEdit || isOwner) && (
      <div>
        <label className="block text-xs font-semibold text-slate-400 mb-1">
          {isEdit ? "Reset password (leave blank to keep current)" : "Initial password (blank = auto-generate)"}
        </label>
        <div className="relative">
          <KeyRound className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={isEdit ? "New password…" : "e.g. Mina-Pass-24"}
            data-testid="user-form-password"
            className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white text-sm" />
        </div>
        {isEdit && password && (
          <p className="text-[10px] text-amber-400 mt-1">Resetting signs the user out everywhere immediately.</p>
        )}
      </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 bg-slate-800/40 border border-slate-700 rounded-xl p-3">
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">Permissions</div>
          <Toggle label="Record sales" value={canRecordSales} onChange={setCanRecordSales} testid="perm-sales" />
          <Toggle label="Record expenses" value={canRecordExpenses} onChange={setCanRecordExpenses} testid="perm-expenses" />
          <Toggle label="Manage stock" value={canManageStock} onChange={setCanManageStock} testid="perm-stock" />
          <Toggle label="Export data" value={canExportData} onChange={setCanExportData} testid="perm-export" />
          {isOwner && (
            <Toggle label="Manage & delete shared records" value={canManageRecords} onChange={setCanManageRecords} testid="perm-records" tint="cyan" />
          )}
          {isOwner && (
            <Toggle label="Manage CCTV cameras" value={canManageCctv} onChange={setCanManageCctv} testid="perm-cctv" tint="cyan" />
          )}
          {isOwner && (
            <Toggle
              label="Online storefront & delivery areas (switches, service areas, pickup points, help & MoMo)"
              value={canManageOnline}
              onChange={setCanManageOnline}
              testid="perm-online"
              tint="cyan"
            />
          )}
          {isOwner && (
            <Toggle
              label="New Branch/Unit (create business units)"
              value={canCreateBusiness}
              onChange={setCanCreateBusiness}
              testid="perm-create-business"
              tint="cyan"
            />
          )}
          {isOwner && (
            <Toggle
              label="Finance & Reports — enterprise users (view Finance & Reports, scoped to their units)"
              value={canViewFinance}
              onChange={setCanViewFinance}
              testid="perm-finance"
              tint="cyan"
            />
          )}
          {isOwner && (
            <Toggle
              label="Customer Support — storefront HELP (add/edit support contact, hours & location)"
              value={canManageSupport}
              onChange={setCanManageSupport}
              testid="perm-support-info"
              tint="cyan"
            />
          )}
          {isOwner && (role === "BRANCH_MANAGER" || role === "GENERAL_MANAGER") && (
            <Toggle label="Manage auditor access (Audit & Review)" value={canManageAuditors} onChange={setCanManageAuditors} testid="perm-auditors" tint="teal" />
          )}
          {isOwner && (role === "BRANCH_MANAGER" || role === "GENERAL_MANAGER") && (
            <Toggle
              label="Delegate user & access management"
              value={canDelegateUsers}
              onChange={setCanDelegateUsers}
              testid="perm-delegate"
              tint="cyan"
            />
          )}
        </div>
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">
            Extra business access (in addition to primary)
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 pr-1" data-testid="user-form-extra-access">
            {visibleBiz.map((b) => {
              const granted = extraAccess.includes(b.id);
              return (
                <label key={b.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={granted}
                    onChange={() =>
                      setExtraAccess((prev) =>
                        granted ? prev.filter((x) => x !== b.id) : [...prev, b.id]
                      )
                    }
                    data-testid={`access-grant-${b.code}`}
                    className="accent-cyan-500"
                  />
                  <span className="truncate">{b.name}</span>
                  <span className="text-[9px] text-slate-500">{b.code}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {isEdit && editing?.role !== "OWNER" && (
        <label className="flex items-center justify-between text-xs text-slate-300 cursor-pointer bg-slate-800/40 border border-slate-700 rounded-xl px-3 py-2">
          <span>Account active (deactivating blocks sign-in immediately)</span>
          <button type="button" onClick={() => setIsActive(!isActive)}
            data-testid="user-form-active"
            className={`px-2.5 py-1 rounded-md text-[10px] font-black border transition ${
              isActive
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "bg-rose-500/20 text-rose-300 border-rose-500/40"
            }`}>
            {isActive ? "ACTIVE" : "DEACTIVATED"}
          </button>
        </label>
      )}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92vh] overflow-y-auto" data-testid="user-access-console">
        <div className="sticky top-0 bg-slate-900/95 backdrop-blur px-5 py-4 border-b border-slate-800 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-black text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-cyan-400" />
              Users & Access
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {view === "list" && (isOwner
                ? "Create logins, assign roles, businesses and permissions"
                : "Manage the users in the branches assigned to you")}
              {view === "create" && "Create a new user account"}
              {view === "edit" && `Editing ${editing?.name}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {view !== "list" && (
              <button onClick={() => setView("list")}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold">
                <ArrowLeft className="w-3.5 h-3.5" /> All Users
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {notice && (
            <div data-testid="user-access-notice" className="bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 p-3 rounded-lg text-xs whitespace-pre-line">
              {notice}
            </div>
          )}
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/40 text-rose-300 p-3 rounded-lg text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {view === "list" && (
            <>
              <div className="flex justify-between items-center">
                <p className="text-xs text-slate-400">{users.length} user account(s)</p>
                <button onClick={openCreate} data-testid="user-create-open"
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg transition">
                  <Plus className="w-4 h-4" /> New User
                </button>
              </div>
              <div className="space-y-2">
                {[...users].sort((a, b) => a.id - b.id).map((u) => (
                  <div key={u.id} data-testid={`user-row-${u.id}`}
                    className="bg-slate-800/70 border border-slate-700 rounded-xl p-3.5 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center font-black text-cyan-300 text-sm shrink-0">
                      {u.name?.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-white">{u.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-slate-700 text-cyan-300">
                          {u.role}
                        </span>
                        {u.isActive === false && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40">
                            DEACTIVATED
                          </span>
                        )}
                        {!u.hasPassword && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            NO PASSWORD
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {u.email} · {bizName(u.assignedBusinessId)}
                        {(u.extraAccessIds?.length ?? 0) > 0 &&
                          ` · +${u.extraAccessIds.length} extra branch(es)`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {canManageRow(u) && (
                        <button onClick={() => openEdit(u)} data-testid={`user-edit-${u.id}`}
                          title="Edit / assign / reset"
                          className="p-2 rounded-lg bg-slate-700/70 hover:bg-indigo-500/30 text-slate-200 hover:text-indigo-300 transition">
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      {isOwner && u.role !== "OWNER" && (
                        <button onClick={() => handleDelete(u)} data-testid={`user-delete-${u.id}`}
                          title="Delete account"
                          className="p-2 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 transition">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {view === "create" && (
            <form onSubmit={handleCreate} className="space-y-4" data-testid="user-create-form">
              {formBody(false)}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setView("list")}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={busy} data-testid="user-create-submit"
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-40">
                  {busy ? "Creating…" : "Create Account"}
                </button>
              </div>
            </form>
          )}

          {view === "edit" && editing && (
            <form onSubmit={handleSaveEdit} className="space-y-4" data-testid="user-edit-form">
              {editing.role === "OWNER" && (
                <div className="bg-amber-500/10 border border-amber-500/40 text-amber-300 p-3 rounded-lg text-xs flex items-start gap-2">
                  <UserCheck className="w-4 h-4 shrink-0 mt-0.5" />
                  The OWNER account always keeps the OWNER role and stays active.
                </div>
              )}
              {formBody(true)}
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setView("list")}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={busy} data-testid="user-edit-save"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition disabled:opacity-40">
                  {busy ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
