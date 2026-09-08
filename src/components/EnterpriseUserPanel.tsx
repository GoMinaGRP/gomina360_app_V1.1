"use client";

import React, { useState } from "react";
import {
  Users,
  UserPlus,
  UserCheck,
  UserX,
  Shield,
  Key,
  Trash2,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Building,
  Mail,
  Phone,
  ArrowLeftRight,
} from "lucide-react";
import LocationSelector, { LocationValue, LocationBadge } from "./LocationSelector";
import { REGION_NAMES } from "@/lib/ghanaLocations";
import SignedInStaffPanel from "./SignedInStaffPanel";
import Avatar from "./Avatar";

interface EnterpriseUserPanelProps {
  currentUser: any;
  usersList: any[];
  businesses: any[];
  onRefreshData: () => void;
}

export default function EnterpriseUserPanel({
  currentUser,
  usersList,
  businesses,
  onRefreshData,
}: EnterpriseUserPanelProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState<any>(null);
  const [showPasswordResetModal, setShowPasswordResetModal] = useState<any>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  // New user form state
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("+233 24 ");
  const [newRole, setNewRole] = useState("WORKER");
  const [newBusinessId, setNewBusinessId] = useState("");
  const [newCanRecordSales, setNewCanRecordSales] = useState(true);
  const [newCanRecordExpenses, setNewCanRecordExpenses] = useState(false);
  const [newCanManageStock, setNewCanManageStock] = useState(false);
  const [newCanExportData, setNewCanExportData] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [newLocation, setNewLocation] = useState<LocationValue>({
    region: "",
    district: "",
    town: "",
  });
  const [editLocation, setEditLocation] = useState<LocationValue>({
    region: "",
    district: "",
    town: "",
  });
  const [regionFilter, setRegionFilter] = useState("ALL");

  // Edit user form state
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editBusinessId, setEditBusinessId] = useState("");
  const [editCanRecordSales, setEditCanRecordSales] = useState(true);
  const [editCanRecordExpenses, setEditCanRecordExpenses] = useState(false);
  const [editCanManageStock, setEditCanManageStock] = useState(false);
  const [editCanExportData, setEditCanExportData] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Password reset state
  const [resetSuccess, setResetSuccess] = useState(false);

  // Sub-tabs for user directory vs pending approvals
  const [activeSubTab, setActiveSubTab] = useState<"ACCOUNTS" | "APPROVALS" | "PRESENCE">("ACCOUNTS");
  const [approvalsList, setApprovalsList] = useState<any[]>([
    {
      id: 101,
      branch: "Mina Akuafo Poultry Farm",
      type: "Expense Authorization",
      detail: "Request to purchase 5 tons of emergency maize concentrate (GH₵ 12,500)",
      requestedBy: "Emmanuel Osei (Branch Manager)",
      date: "Today, 10:45 AM",
      status: "PENDING",
    },
    {
      id: 102,
      branch: "Mina Concrete & Blocks",
      type: "Special Customer Discount",
      detail: "Authorize 8.5% wholesale discount for Consolidated Real Estate bulk paving block order",
      requestedBy: "Kofi Boahen (Branch Manager)",
      date: "Today, 09:15 AM",
      status: "PENDING",
    },
    {
      id: 103,
      branch: "Mina Volta Tilapia & Catfish",
      type: "Stock Write-off / Adjust",
      detail: "Log 80kg of fingerlings replacement after cage transfer quarantine",
      requestedBy: "Dr. Selorm Gbeho (Branch Manager)",
      date: "Yesterday",
      status: "APPROVED",
      actionedBy: "Kwame Mina",
    },
    {
      id: 104,
      branch: "Mina Heritage Kitchen",
      type: "Overtime Payroll",
      detail: "Authorize GH₵ 3,200 total overtime salary for weekend kitchen team",
      requestedBy: "Chef Esi Mensah (Branch Manager)",
      date: "2 days ago",
      status: "REJECTED",
      actionedBy: "Abena Serwaa",
    },
  ]);

  const handleActionApproval = (id: number, status: "APPROVED" | "REJECTED") => {
    setApprovalsList((prev) =>
      prev.map((app) =>
        app.id === id
          ? { ...app, status, actionedBy: currentUser?.name || "Executive" }
          : app
      )
    );
  };

  const getBusinessName = (bId: number | null) => {
    if (!bId) return "All Branches (Shared HQ)";
    const b = businesses.find((x) => x.id === bId);
    return b ? `${b.name} (${b.branchLocation})` : `Branch #${bId}`;
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    setIsCreating(true);
    setErrorMsg("");

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          phone: newPhone,
          role: newRole,
          assignedBusinessId: newBusinessId ? Number(newBusinessId) : null,
          region: newLocation.region,
          district: newLocation.district,
          town: newLocation.town,
          canRecordSales: newCanRecordSales,
          canRecordExpenses: newCanRecordExpenses,
          canManageStock: newCanManageStock,
          canExportData: newCanExportData,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setNewName("");
        setNewEmail("");
        setNewPhone("+233 24 ");
        setNewRole("WORKER");
        setNewBusinessId("");
        setShowCreateModal(false);
        onRefreshData();
      } else {
        setErrorMsg(data.error || "Failed to create user");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Network error");
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleUserActivation = async (user: any) => {
    // Cannot deactivate owner or themselves
    if (user.role === "OWNER") {
      alert("Unauthorized: The OWNER account cannot be deactivated.");
      return;
    }
    if (user.id === currentUser?.id) {
      alert("You cannot deactivate your own active session.");
      return;
    }

    setActionBusy(user.id);
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          requestingUserRole: currentUser?.role,
          isActive: !user.isActive,
        }),
      });
      if (res.ok) {
        onRefreshData();
      } else {
        const d = await res.json();
        alert(d.error || "Failed to update activation status.");
      }
    } catch (err) {
      console.error("Error deactivating user:", err);
    } finally {
      setActionBusy(null);
    }
  };

  const handleEditUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showEditModal) return;
    setIsEditing(true);

    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: showEditModal.id,
          requestingUserRole: currentUser?.role,
          name: editName,
          email: editEmail,
          phone: editPhone,
          role: editRole,
          assignedBusinessId: editBusinessId ? Number(editBusinessId) : null,
          region: editLocation.region,
          district: editLocation.district,
          town: editLocation.town,
          canRecordSales: editCanRecordSales,
          canRecordExpenses: editCanRecordExpenses,
          canManageStock: editCanManageStock,
          canExportData: editCanExportData,
        }),
      });

      const d = await res.json();
      if (d.success) {
        setShowEditModal(null);
        onRefreshData();
      } else {
        alert(d.error || "Failed to update user.");
      }
    } catch (err) {
      console.error("Error editing user:", err);
    } finally {
      setIsEditing(false);
    }
  };

  const handleDeleteUser = async (user: any) => {
    if (user.role === "OWNER") {
      alert("Critical Authorization Failure: The OWNER account can never be deleted.");
      return;
    }
    if (user.id === currentUser?.id) {
      alert("You cannot delete your own active account.");
      return;
    }

    if (!confirm(`Are you sure you want to permanently delete user account: ${user.name}?`)) {
      return;
    }

    setActionBusy(user.id);
    try {
      const res = await fetch(`/api/users?userId=${user.id}&requestingUserRole=${currentUser?.role}`, {
        method: "DELETE",
      });
      const d = await res.json();
      if (d.success) {
        onRefreshData();
      } else {
        alert(d.error || "Failed to delete user.");
      }
    } catch (err) {
      console.error("Error deleting user:", err);
    } finally {
      setActionBusy(null);
    }
  };

  const triggerPasswordReset = (user: any) => {
    if (currentUser?.role === "GENERAL_MANAGER" && user.role === "OWNER") {
      alert("Security Error: GENERAL_MANAGER is unauthorized to reset OWNER credentials.");
      return;
    }
    setShowPasswordResetModal(user);
    setResetSuccess(false);
  };

  const handlePasswordResetConfirm = () => {
    setResetSuccess(true);
    setTimeout(() => {
      setShowPasswordResetModal(null);
      setResetSuccess(false);
    }, 2500);
  };

  const openEditModal = (user: any) => {
    if (currentUser?.role === "GENERAL_MANAGER" && user.role === "OWNER") {
      alert("Security Error: GENERAL_MANAGER cannot modify OWNER permissions or credentials.");
      return;
    }
    setEditName(user.name);
    setEditEmail(user.email);
    setEditPhone(user.phone || "");
    setEditRole(user.role);
    setEditBusinessId(user.assignedBusinessId ? String(user.assignedBusinessId) : "");
    setEditCanRecordSales(user.canRecordSales !== false);
    setEditCanRecordExpenses(user.canRecordExpenses === true);
    setEditCanManageStock(user.canManageStock === true);
    setEditCanExportData(user.canExportData === true);
    setEditLocation({
      region: user.region || "",
      district: user.district || "",
      town: user.town || "",
    });
    setShowEditModal(user);
  };

  // Filter list
  const filteredUsers = usersList.filter((u) => {
    const matchesSearch =
      u.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.phone?.includes(searchTerm);

    const matchesRole = roleFilter === "ALL" || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1500px] mx-auto text-slate-100">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            <Users className="w-7 h-7 text-cyan-400" />
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">
              ENTERPRISE USERS & ASSIGNMENTS
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              Executive Directory & Access HQ
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              Create, edit, toggle status, and transfer Branch Managers and Workers across all 7 business locations.
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
        >
          <UserPlus className="w-4 h-4" />
          <span>Register New Account</span>
        </button>
      </div>

      {/* Warning regarding constraints */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 text-xs sm:text-sm text-slate-300 flex items-start space-x-3">
        <Shield className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
        <div>
          <strong className="text-blue-300 font-bold block mb-1">
            Enterprise Integrity & Security Protocol
          </strong>
          {currentUser?.role === "GENERAL_MANAGER" ? (
            <span>
              As a **GENERAL_MANAGER**, you possess administrative command over all **BRANCH_MANAGERS** and **WORKERS** across all branches. You can transfer them between branches and edit profiles. However, you *cannot* modify, deactivate, reset, or delete the **OWNER** account.
            </span>
          ) : (
            <span>
              As the **OWNER**, you have unrestricted override permissions over the entire GoMina 360 network, including GENERAL_MANAGERS, Branch Managers, and Workers.
            </span>
          )}
        </div>
      </div>

      {/* Sub-Navigation Switcher */}
      <div className="flex items-center space-x-1 bg-slate-800 p-1.5 rounded-xl border border-slate-700/60 w-fit">
        <button
          onClick={() => setActiveSubTab("ACCOUNTS")}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
            activeSubTab === "ACCOUNTS"
              ? "bg-cyan-600 text-white shadow"
              : "text-slate-300 hover:bg-slate-700/50"
          }`}
        >
          User Accounts & Transfers
        </button>
        <button
          onClick={() => setActiveSubTab("APPROVALS")}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center space-x-1.5 ${
            activeSubTab === "APPROVALS"
              ? "bg-cyan-600 text-white shadow"
              : "text-slate-300 hover:bg-slate-700/50"
          }`}
        >
          <span>Pending Approvals</span>
          <span className="bg-rose-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
            {approvalsList.filter((a) => a.status === "PENDING").length}
          </span>
        </button>
        <button
          onClick={() => setActiveSubTab("PRESENCE")}
          data-testid="usr-tab-presence"
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center space-x-1.5 ${
            activeSubTab === "PRESENCE"
              ? "bg-emerald-600 text-white shadow"
              : "text-slate-300 hover:bg-slate-700/50"
          }`}
        >
          <UserCheck className="w-3.5 h-3.5" />
          <span>Signed-In Staff</span>
        </button>
      </div>

      {activeSubTab === "ACCOUNTS" ? (
        <>
          {/* Filter / Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-slate-800/90 border border-slate-700/80 p-4 rounded-xl">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            placeholder="Search accounts by name, email, phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-4 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-xs text-slate-400 font-medium">Filter by Role:</span>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none"
          >
            <option value="ALL">All Roles</option>
            <option value="OWNER">Owner</option>
            <option value="GENERAL_MANAGER">General Manager</option>
            <option value="BRANCH_MANAGER">Branch Manager</option>
            <option value="WORKER">Worker (Sales Person)</option>
          </select>
        </div>
      </div>

      {/* Users List Table */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
              <tr>
                <th className="px-4 py-3">User & Contact</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Assigned Branch</th>
                <th className="px-4 py-3 text-center">Perms (Worker)</th>
                <th className="px-4 py-3 text-center">Account Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {filteredUsers.map((user) => {
                const isOwner = user.role === "OWNER";
                const isBusy = actionBusy === user.id;
                const isSelf = user.id === currentUser?.id;

                return (
                  <tr
                    key={user.id}
                    className={`hover:bg-slate-700/40 transition ${
                      !user.isActive ? "opacity-60 bg-rose-950/5" : ""
                    }`}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center space-x-3">
                        <Avatar
                          name={user.name}
                          url={user.avatarUrl}
                          testid={`usr-photo-${user.id}`}
                          imgClass="w-9 h-9 rounded-full object-cover border border-slate-600"
                          fallbackClass="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center font-bold text-xs text-cyan-300"
                        />
                        <div>
                          <div className="font-bold text-slate-100">
                            {user.name} {isSelf && <span className="text-[10px] bg-slate-700 px-1.5 py-0.5 rounded text-cyan-400">(You)</span>}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center space-x-2 mt-0.5">
                            <span className="flex items-center"><Mail className="w-3 h-3 mr-1" /> {user.email}</span>
                            <span>•</span>
                            <span className="flex items-center"><Phone className="w-3 h-3 mr-1" /> {user.phone}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                          user.role === "OWNER"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : user.role === "GENERAL_MANAGER"
                            ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                            : user.role === "BRANCH_MANAGER"
                            ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        }`}
                      >
                        {user.role}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      <div className="flex items-center space-x-1">
                        <Building className="w-3.5 h-3.5 text-slate-400" />
                        <span className="truncate max-w-[200px]">{getBusinessName(user.assignedBusinessId)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-center text-xs">
                      {(user.role === "WORKER" || user.role === "BRANCH_MANAGER") ? (
                        <div className="flex items-center justify-center space-x-1 text-[10px] font-semibold flex-wrap">
                          <span className={user.canRecordSales ? "text-emerald-400" : "text-slate-500"}>Sell</span>
                          <span>•</span>
                          <span className={user.canRecordExpenses ? "text-amber-400" : "text-slate-500"}>Exp</span>
                          <span>•</span>
                          <span className={user.canManageStock ? "text-cyan-400" : "text-slate-500"}>Stock</span>
                          <span>•</span>
                          <span className={user.canExportData ? "text-indigo-400" : "text-slate-500"}>Export</span>
                        </div>
                      ) : (
                        <span className="text-emerald-400 text-[10px] font-bold">Full</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <button
                        onClick={() => handleToggleUserActivation(user)}
                        disabled={isBusy || isOwner}
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border transition ${
                          user.isActive
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/30"
                            : "bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-emerald-500/20 hover:text-emerald-400 hover:border-emerald-500/30"
                        }`}
                        title={isOwner ? "Owner cannot be deactivated" : "Toggle Status"}
                      >
                        {user.isActive ? "ACTIVE" : "INACTIVE"}
                      </button>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end space-x-2">
                        {/* Edit profile & Transfer */}
                        <button
                          onClick={() => openEditModal(user)}
                          disabled={isOwner && currentUser?.role === "GENERAL_MANAGER"}
                          className="p-1.5 rounded-lg hover:bg-cyan-500/20 text-cyan-400 transition disabled:opacity-30"
                          title="Edit & Transfer User"
                        >
                          <ArrowLeftRight className="w-4 h-4" />
                        </button>

                        {/* Reset password */}
                        <button
                          onClick={() => triggerPasswordReset(user)}
                          disabled={isOwner && currentUser?.role === "GENERAL_MANAGER"}
                          className="p-1.5 rounded-lg hover:bg-amber-500/20 text-amber-400 transition disabled:opacity-30"
                          title="Reset Password"
                        >
                          <Key className="w-4 h-4" />
                        </button>

                        {/* Delete user */}
                        <button
                          onClick={() => handleDeleteUser(user)}
                          disabled={isOwner || isSelf || (isOwner && currentUser?.role === "GENERAL_MANAGER")}
                          className="p-1.5 rounded-lg hover:bg-rose-500/20 text-rose-400 transition disabled:opacity-30"
                          title="Delete User"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  ) : activeSubTab === "PRESENCE" ? (
    /* Signed-In Staff — live presence + enable/disable/revoke (OWNER and
       OWNER-authorized user managers; server-enforced, branch-scoped). */
    <SignedInStaffPanel currentUser={currentUser} />
  ) : (
    <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl space-y-4">
      <div className="flex items-center space-x-2 pb-3 border-b border-slate-700/70">
        <Shield className="w-5 h-5 text-cyan-400" />
        <h3 className="text-base font-bold text-white">Pending Higher Authorization & Action Requests</h3>
      </div>

      <div className="space-y-4">
        {approvalsList.map((app) => (
          <div
            key={app.id}
            className="p-4 rounded-xl border bg-slate-950/40 border-slate-700/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
          >
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <span className="px-2 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300 border border-slate-700">
                  {app.type}
                </span>
                <span className="text-[11px] text-slate-400 font-semibold">{app.branch}</span>
              </div>
              <p className="text-sm font-bold text-slate-100">{app.detail}</p>
              <div className="text-[11px] text-slate-400">
                Requested by <strong className="text-slate-300">{app.requestedBy}</strong> • {app.date}
              </div>
            </div>

            <div className="shrink-0 flex items-center space-x-2">
              {app.status === "PENDING" ? (
                <>
                  <button
                    onClick={() => handleActionApproval(app.id, "REJECTED")}
                    className="px-3 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white text-xs font-bold transition"
                  >
                    Reject Request
                  </button>
                  <button
                    onClick={() => handleActionApproval(app.id, "APPROVED")}
                    className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-md"
                  >
                    Approve Request
                  </button>
                </>
              ) : (
                <div className="text-right">
                  <span
                    className={`inline-block px-2.5 py-1 rounded text-xs font-bold ${
                      app.status === "APPROVED"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-rose-500/20 text-rose-400"
                    }`}
                  >
                    {app.status}
                  </span>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Actioned by {app.actionedBy}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )}

      {/* Create User / Register Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <UserPlus className="w-5 h-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-white">Register User Account</h3>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white text-xl">×</button>
            </div>

            {errorMsg && (
              <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-3 rounded-lg text-xs">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleCreateUser} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Email *</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Role *</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value="GENERAL_MANAGER">General Manager</option>
                    <option value="BRANCH_MANAGER">Branch Manager</option>
                    <option value="WORKER">Worker (Sales Person)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Branch / Business</label>
                  <select
                    value={newBusinessId}
                    onChange={(e) => setNewBusinessId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value="">None (HQ / Executive)</option>
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Phone Number</label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              {/* Detailed permissions for Workers and Branch Managers */}
              {(newRole === "WORKER" || newRole === "BRANCH_MANAGER") && (
                <div className="space-y-2 bg-slate-800/60 p-3 rounded-lg border border-slate-700/50">
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    {newRole === "WORKER" ? "Worker Permissions" : "Branch Manager Permissions"}
                  </div>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Record Sales</span>
                    <input type="checkbox" checked={newCanRecordSales} onChange={(e) => setNewCanRecordSales(e.target.checked)} className="accent-emerald-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Record Expenses</span>
                    <input type="checkbox" checked={newCanRecordExpenses} onChange={(e) => setNewCanRecordExpenses(e.target.checked)} className="accent-amber-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Manage Stock</span>
                    <input type="checkbox" checked={newCanManageStock} onChange={(e) => setNewCanManageStock(e.target.checked)} className="accent-cyan-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Export Data / Reports</span>
                    <input type="checkbox" checked={newCanExportData} onChange={(e) => setNewCanExportData(e.target.checked)} className="accent-indigo-500" />
                  </label>
                </div>
              )}

              <div className="pt-2 border-t border-slate-800">
                <LocationSelector
                  value={newLocation}
                  onChange={setNewLocation}
                  compact
                  headingLabel="User Location (Ghana)"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition"
                >
                  {isCreating ? "Saving..." : "Save Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal (Assign / Transfer / Permissions) */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <ArrowLeftRight className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold text-white">Edit & Transfer User</h3>
              </div>
              <button onClick={() => setShowEditModal(null)} className="text-slate-400 hover:text-white text-xl">×</button>
            </div>

            <form onSubmit={handleEditUserSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Role</label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value="GENERAL_MANAGER">General Manager</option>
                    <option value="BRANCH_MANAGER">Branch Manager</option>
                    <option value="WORKER">Worker (Sales Person)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Assigned Branch (Transfer)</label>
                  <select
                    value={editBusinessId}
                    onChange={(e) => setEditBusinessId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                  >
                    <option value="">None (HQ / Executive)</option>
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Phone Number</label>
                <input
                  type="text"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                />
              </div>

              {(editRole === "WORKER" || editRole === "BRANCH_MANAGER") && (
                <div className="space-y-2 bg-slate-800/60 p-3 rounded-lg border border-slate-700/50">
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    {editRole === "WORKER" ? "Worker Permissions" : "Branch Manager Permissions"}
                  </div>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Record Sales</span>
                    <input type="checkbox" checked={editCanRecordSales} onChange={(e) => setEditCanRecordSales(e.target.checked)} className="accent-emerald-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Record Expenses</span>
                    <input type="checkbox" checked={editCanRecordExpenses} onChange={(e) => setEditCanRecordExpenses(e.target.checked)} className="accent-amber-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Manage Stock</span>
                    <input type="checkbox" checked={editCanManageStock} onChange={(e) => setEditCanManageStock(e.target.checked)} className="accent-cyan-500" />
                  </label>
                  <label className="flex items-center justify-between text-xs cursor-pointer">
                    <span>Can Export Data / Reports</span>
                    <input type="checkbox" checked={editCanExportData} onChange={(e) => setEditCanExportData(e.target.checked)} className="accent-indigo-500" />
                  </label>
                </div>
              )}

              <div className="pt-2 border-t border-slate-800">
                <LocationSelector
                  value={editLocation}
                  onChange={setEditLocation}
                  compact
                  headingLabel="User Location (Ghana)"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowEditModal(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isEditing}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition"
                >
                  {isEditing ? "Saving..." : "Save Modifications"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Password Reset Modal */}
      {showPasswordResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4 text-center">
            <Key className="w-12 h-12 text-amber-400 mx-auto animate-bounce" />
            <h3 className="text-lg font-bold text-white">Reset Credentials</h3>
            <p className="text-xs text-slate-300">
              Confirm security reset for: <br />
              <strong className="text-white font-bold">{showPasswordResetModal.name}</strong> ({showPasswordResetModal.email})
            </p>

            {resetSuccess ? (
              <div className="bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 p-3 rounded-lg text-xs font-bold">
                Temporary access code generated and dispatched!
              </div>
            ) : (
              <p className="text-[11px] text-slate-400 leading-relaxed">
                This will trigger a temporary login credentials dispatch to their active contacts.
              </p>
            )}

            <div className="flex justify-center space-x-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowPasswordResetModal(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePasswordResetConfirm}
                disabled={resetSuccess}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-slate-950 text-xs font-bold shadow-md transition"
              >
                Yes, Dispatch Code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
