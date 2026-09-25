"use client";

import React, { useEffect, useState } from "react";
import AdvisorSectionPicker from "./AdvisorSectionPicker";
import { farmModuleOfBusiness } from "@/lib/advisorSections";
import {
  Users,
  UserPlus,
  UserCheck,
  UserX,
  Shield,
  Key,
  Trash,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Building,
  Mail,
  Phone,
  ArrowLeftRight,
  Stethoscope,
  CalendarClock,
  ShieldCheck,
} from "lucide-react";
import { isFarmBusinessCategory } from "@/lib/businessTypeKeys";
import LocationSelector, { LocationValue, LocationBadge } from "./LocationSelector";
import { REGION_NAMES } from "@/lib/ghanaLocations";
import SignedInStaffPanel from "./SignedInStaffPanel";
import Avatar from "./Avatar";

interface EnterpriseUserPanelProps {
  currentUser: any;
  usersList: any[];
  businesses: any[];
  onRefreshData: () => void;
  /** Jump straight to the deep-management Farm Advisors console (ADVISOR tab). */
  onOpenFarmAdvisors?: () => void;
}

/** Farm Advisor grant rows are shared with the Farm Advisors console through
 *  ONE API (/api/advisor) — this panel never keeps a second copy of truth. */
interface AdvisorGrants {
  assignments: any[];
  advisors: any[];
  businesses: any[];
}

export default function EnterpriseUserPanel({
  currentUser,
  usersList,
  businesses,
  onRefreshData,
  onOpenFarmAdvisors,
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
  // Farm Advisor onboarding: the OWNER sets the advisor's initial password
  // by hand (external guest account — credentials are shared off-platform).
  const [newPassword, setNewPassword] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState<{ name: string; password: string; granted?: string } | null>(null);
  // Advisor onboarding: farm units picked at creation (granted right after
  // the account is created, through the SAME /api/advisor grants API).
  const [advUnits, setAdvUnits] = useState<Set<number>>(new Set());
  const [advExpiry, setAdvExpiry] = useState("");
  const [advScope, setAdvScope] = useState("");
  // Per-unit section visibility picked during registration: businessId →
  // section list (null = all — the default for untouched units).
  const [advSections, setAdvSections] = useState<Record<number, string[] | null>>({});
  // Live advisor grants for the users table + the access modal (OWNER/GM).
  const [advisorGrants, setAdvisorGrants] = useState<AdvisorGrants | null>(null);
  const [advisorAccessUser, setAdvisorAccessUser] = useState<any>(null);
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

  const mayManageAdvisors =
    currentUser?.role === "OWNER" ||
    currentUser?.role === "GENERAL_MANAGER" ||
    currentUser?.canManageUsers === true;

  const loadAdvisorGrants = async () => {
    if (!mayManageAdvisors) return;
    try {
      const res = await fetch("/api/advisor");
      const d = await res.json();
      if (res.ok && d.success) setAdvisorGrants(d);
    } catch {
      /* transient — rows simply show without grant detail until reload */
    }
  };

  useEffect(() => {
    loadAdvisorGrants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  /** All grants of one advisor, newest first. */
  const grantsOf = (userId: number) =>
    (advisorGrants?.assignments || [])
      .filter((a) => Number(a.userId) === Number(userId))
      .sort((a, b) => Number(b.id) - Number(a.id));

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
          // Advisors only: the OWNER-chosen initial password (server generates
          // a random one when blank and returns it exactly once).
          ...(newRole === "FARM_ADVISOR" ? { password: newPassword.trim() || undefined } : {}),
        }),
      });

      const data = await res.json();
      if (data.success) {
        // One-flow advisor onboarding: grant the picked farm units through
        // the SAME grants API the Farm Advisors console uses.
        let grantedSummary = "";
        if (newRole === "FARM_ADVISOR" && advUnits.size > 0) {
          try {
            const g = await fetch("/api/advisor", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                userId: data.user.id,
                businessIds: [...advUnits],
                validUntil: advExpiry || null,
                scopeNote: advScope || null,
                sectionsByBusiness: Object.fromEntries(
                  [...advUnits]
                    .filter((bid) => advSections[bid] !== undefined)
                    .map((bid) => [String(bid), advSections[bid]])
                ),
              }),
            });
            const gd = await g.json();
            grantedSummary = gd.success
              ? `Farm-unit access granted: ${gd.granted} unit${Number(gd.granted) === 1 ? "" : "s"}${advExpiry ? `, expires ${advExpiry}` : ""}.`
              : gd.error || "Units were not granted — manage access from the user's row.";
            loadAdvisorGrants();
          } catch {
            grantedSummary = "Units were not granted — manage access from the user's row.";
          }
        }
        if (newRole === "FARM_ADVISOR" && data.initialPassword) {
          setCreatedCredentials({ name: newName, password: String(data.initialPassword), granted: grantedSummary });
        }
        setNewName("");
        setNewEmail("");
        setNewPhone("+233 24 ");
        setNewRole("WORKER");
        setNewPassword("");
        setAdvUnits(new Set());
        setAdvSections({});
        setAdvUnits(new Set());
        setAdvExpiry("");
        setAdvScope("");
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
              Create, edit, toggle status, and transfer Branch Managers and Workers across all 7 business locations — and onboard read-only Farm Advisors with per-unit access, expiry and scope.
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
            <option value="FARM_ADVISOR">Farm Advisor</option>
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
                            : user.role === "FARM_ADVISOR"
                            ? "bg-teal-500/20 text-teal-300 border border-teal-500/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        }`}
                      >
                        {user.role === "FARM_ADVISOR" ? "FARM ADVISOR" : user.role}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      {user.role === "FARM_ADVISOR" ? (
                        (() => {
                          const gs = grantsOf(user.id);
                          const activeCount = gs.filter(
                            (a) => a.isActive !== false && (!a.validUntil || String(a.validUntil) >= today),
                          ).length;
                          return (
                            <div className="space-y-1" data-testid={`usr-advisor-units-${user.id}`}>
                              {gs.length === 0 ? (
                                <span className="text-[10px] text-slate-500 italic">No farm units granted</span>
                              ) : (
                                <>
                                  <div className="text-[10px] text-slate-400 font-semibold">
                                    {gs.length} unit{gs.length === 1 ? "" : "s"} · {activeCount} active
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {gs.slice(0, 4).map((a) => {
                                      const expired = a.validUntil && String(a.validUntil) < today;
                                      const state = a.isActive === false ? "REVOKED" : expired ? "EXPIRED" : "ACTIVE";
                                      const biz = businesses.find((b) => Number(b.id) === Number(a.businessId));
                                      return (
                                        <span
                                          key={a.id}
                                          title={`${biz?.name || ""} — ${state}${a.validUntil ? ` · expires ${a.validUntil}` : " · no expiry"}`}
                                          className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                            state === "ACTIVE"
                                              ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                              : state === "EXPIRED"
                                                ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                                                : "bg-slate-600/20 text-slate-400 border-slate-600/40"
                                          }`}
                                        >
                                          {biz?.code || `#${a.businessId}`}
                                        </span>
                                      );
                                    })}
                                    {gs.length > 4 && <span className="text-[9px] text-slate-500">+{gs.length - 4}</span>}
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <div className="flex items-center space-x-1">
                          <Building className="w-3.5 h-3.5 text-slate-400" />
                          <span className="truncate max-w-[200px]">{getBusinessName(user.assignedBusinessId)}</span>
                        </div>
                      )}
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
                      ) : user.role === "FARM_ADVISOR" ? (
                        <span className="text-[10px] font-bold text-teal-300" title="Read-only farm monitoring — advisor notes are their one write surface">
                          READ-ONLY · NOTES
                        </span>
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
                        {/* Farm Advisor: manage grants (same data as the Farm Advisors console) */}
                        {user.role === "FARM_ADVISOR" && mayManageAdvisors && (
                          <button
                            onClick={() => setAdvisorAccessUser(user)}
                            disabled={!advisorGrants}
                            className="p-1.5 rounded-lg hover:bg-teal-500/20 text-teal-400 transition disabled:opacity-30"
                            title="Manage Advisor Access (grant / renew / revoke)"
                            data-testid={`usr-advisor-manage-${user.id}`}
                          >
                            <Stethoscope className="w-4 h-4" />
                          </button>
                        )}

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
                          <Trash className="w-4 h-4" />
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
          <div className={`bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full ${newRole === "FARM_ADVISOR" ? "max-w-lg" : "max-w-md"} shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto`}>
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
                    <option value="FARM_ADVISOR">Farm Advisor (external, read-only)</option>
                  </select>
                  {newRole === "FARM_ADVISOR" && (
                    <p className="text-[10px] text-teal-300 mt-1 leading-snug">
                      External advisor — OWNER only, read-only by design (no branch, no management permissions). Grant their farm units below or later from <b>Farm Advisors</b> / their row in this table.
                    </p>
                  )}
                </div>
                {newRole !== "FARM_ADVISOR" && (
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
                )}
              </div>

              {/* ── Farm Advisor onboarding: password + unit access in one flow ──
                  Uses the SAME /api/advisor grants as the Farm Advisors console. */}
              {newRole === "FARM_ADVISOR" && (
                <div className="space-y-3 rounded-xl border border-teal-500/30 bg-teal-500/5 p-3.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-teal-300 uppercase tracking-wider">
                    <Stethoscope className="w-3.5 h-3.5" /> Advisor Access &amp; Settings
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Initial Password *</label>
                    <input
                      type="text"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="e.g. Advisor@2026"
                      data-testid="user-create-password"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Share it securely with the advisor — a random one is generated (and shown once) if left blank.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Farm units <span className="text-slate-500 font-medium normal-case">(farm types highlighted — tap to toggle)</span>
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5" data-testid="user-create-unit-chips">
                      {businesses.map((b) => {
                        const farm = isFarmBusinessCategory(b.category);
                        const on = advUnits.has(Number(b.id));
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() =>
                              setAdvUnits((prev) => {
                                const next = new Set(prev);
                                if (on) next.delete(Number(b.id));
                                else next.add(Number(b.id));
                                return next;
                              })
                            }
                            data-testid={`user-create-biz-${b.code}`}
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
                  {/* Per-unit visible sections — only farm units have a
                      catalog; default is ALL sections per unit. */}
                  {[...advUnits]
                    .map((bid) => businesses.find((b) => Number(b.id) === Number(bid)))
                    .filter((b) => !!b && farmModuleOfBusiness(b))
                    .length > 0 && (
                    <div className="space-y-2.5 rounded-lg border border-slate-700/60 bg-slate-800/40 p-2.5">
                      <div className="text-[10px] text-slate-400">
                        Section visibility per selected farm unit — uncheck what this advisor must <b>not</b> see (default: all).
                      </div>
                      {[...advUnits]
                        .map((bid) => businesses.find((b) => Number(b.id) === Number(bid)))
                        .filter((b) => !!b && farmModuleOfBusiness(b))
                        .map((b) => (
                          <AdvisorSectionPicker
                            key={b.id}
                            business={b}
                            value={advSections[Number(b.id)] ?? null}
                            onChange={(next) => setAdvSections((prev) => ({ ...prev, [Number(b.id)]: next }))}
                            compact
                            testidPrefix="usr-create-sec"
                          />
                        ))}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Access expires (optional)</label>
                      <input
                        type="date"
                        value={advExpiry}
                        min={today}
                        onChange={(e) => setAdvExpiry(e.target.value)}
                        data-testid="user-create-valid-until"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Scope note (optional)</label>
                      <input
                        type="text"
                        value={advScope}
                        onChange={(e) => setAdvScope(e.target.value)}
                        placeholder="e.g. Growth & health review"
                        data-testid="user-create-scope-note"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

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

              {newRole !== "FARM_ADVISOR" && (
              <div className="pt-2 border-t border-slate-800">
                <LocationSelector
                  value={newLocation}
                  onChange={setNewLocation}
                  compact
                  headingLabel="User Location (Ghana)"
                />
              </div>
              )}

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
                    <option value="FARM_ADVISOR">Farm Advisor (external, read-only)</option>
                    <option value="BRANCH_MANAGER">Branch Manager</option>
                    <option value="WORKER">Worker (Sales Person)</option>
                  </select>
                  {editRole === "FARM_ADVISOR" && (
                    <div className="mt-1.5 rounded-lg border border-teal-500/30 bg-teal-500/5 px-3 py-2 space-y-1.5">
                      <p className="text-[10px] text-teal-300 leading-snug">
                        External advisor — read-only by design. Their farm-unit access, expiry and scope live in the advisor grants system, not in this form.
                      </p>
                      {showEditModal?.role === "FARM_ADVISOR" && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowEditModal(null);
                            setAdvisorAccessUser(showEditModal);
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-[10px] font-bold"
                          data-testid="usr-edit-open-advisor-access"
                        >
                          <Stethoscope className="w-3.5 h-3.5" /> Manage Advisor Access
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    {editRole === "FARM_ADVISOR" ? "Branch (not applicable to advisors)" : "Assigned Branch (Transfer)"}
                  </label>
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

      {/* ── Advisor Access modal: grant / renew / expire / revoke — the SAME
            /api/advisor assignments the Farm Advisors console manages. ── */}
      {advisorAccessUser && (
        <AdvisorAccessModal
          user={advisorAccessUser}
          grants={advisorGrants}
          businesses={businesses}
          today={today}
          onReload={loadAdvisorGrants}
          onClose={() => setAdvisorAccessUser(null)}
          onOpenConsole={() => {
            setAdvisorAccessUser(null);
            onOpenFarmAdvisors?.();
          }}
        />
      )}

      {/* Advisor credentials — one-time reveal after account creation */}
      {createdCredentials && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-teal-500/40 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4 text-center">
            <Key className="w-12 h-12 text-teal-400 mx-auto" />
            <h3 className="text-lg font-bold text-white">Farm Advisor account created</h3>
            <p className="text-xs text-slate-300">
              Initial login for <strong className="text-white">{createdCredentials.name}</strong>:
            </p>
            <div className="rounded-xl bg-slate-800 border border-slate-700 px-4 py-3 font-mono text-sm text-teal-300 break-all" data-testid="user-created-password">
              {createdCredentials.password}
            </div>
            {createdCredentials.granted && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-3 py-2 text-[11px] font-semibold" data-testid="user-created-granted">
                {createdCredentials.granted}
              </div>
            )}
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Share it securely with the advisor — it is shown only once. The advisor signs in with their email and this password, then changes it from their profile settings.
            </p>
            <button
              type="button"
              onClick={() => setCreatedCredentials(null)}
              className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold"
            >
              Done
            </button>
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

/* ════════════════════════════════════════════════════════════════════════
   AdvisorAccessModal — per-advisor grant management inside Users & Access.
   Same data, same API, same states as the Farm Advisors console: this is a
   compact inline surface, NOT a second access system.
   ════════════════════════════════════════════════════════════════════════ */
function AdvisorAccessModal({
  user,
  grants,
  businesses,
  today,
  onReload,
  onClose,
  onOpenConsole,
}: {
  user: any;
  grants: AdvisorGrants | null;
  businesses: any[];
  today: string;
  onReload: () => void;
  onClose: () => void;
  onOpenConsole?: () => void;
}) {
  const mine = (grants?.assignments || [])
    .filter((a) => Number(a.userId) === Number(user.id))
    .sort((a, b) => Number(b.id) - Number(a.id));
  const grantedIds = new Set(mine.map((a) => Number(a.businessId)));

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [validUntil, setValidUntil] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [rowEdits, setRowEdits] = useState<Record<number, { validUntil: string; scopeNote: string; sections?: string[] | null }>>({});

  const rowState = (a: any) => {
    const expired = a.validUntil && String(a.validUntil) < today;
    if (a.isActive === false) return "REVOKED";
    if (expired) return "EXPIRED";
    return "ACTIVE";
  };

  const grant = async () => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: Number(user.id),
          businessIds: [...picked],
          validUntil: validUntil || null,
          scopeNote: scopeNote || null,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        setMsg(d.error || "Grant failed.");
        return;
      }
      setMsg(`Access granted to ${d.granted} unit(s)${d.reactivated ? `, ${d.reactivated} re-activated` : ""}.`);
      setPicked(new Set());
      setValidUntil("");
      setScopeNote("");
      await onReload();
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (assignmentId: number, body: Record<string, any>, note: string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/advisor", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId, ...body }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) {
        setMsg(d.error || "Update failed.");
        return;
      }
      setMsg(note);
      await onReload();
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-3 sm:p-4">
      <div className="bg-slate-900 border border-teal-500/40 rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto shadow-2xl" data-testid="usr-advisor-modal">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900 rounded-t-2xl">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-teal-500/15 border border-teal-500/30">
              <Stethoscope className="w-5 h-5 text-teal-300" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Advisor Access — {user.name}
                <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300 border border-teal-500/40">READ-ONLY</span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">{user.email} · grants, expiry and scope — identical to the Farm Advisors console</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none" aria-label="Close">×</button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {msg && (
            <div className={`text-xs rounded-lg px-3 py-2 border ${msg.match(/granted|re-activated|updated|extended|restored|revoked/i) ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" : "text-rose-300 bg-rose-500/10 border-rose-500/30"}`}>
              {msg}
            </div>
          )}

          {/* Current grants */}
          <section>
            <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> Current Grants ({mine.filter((a) => rowState(a) === "ACTIVE").length} active)
            </h4>
            {mine.length === 0 ? (
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-4 text-center text-xs text-slate-400">
                No farm units granted yet — grant the first ones below.
              </div>
            ) : (
              <div className="space-y-2">
                {mine.map((a) => {
                  const biz = businesses.find((b) => Number(b.id) === Number(a.businessId));
                  const state = rowState(a);
                  const edit = rowEdits[Number(a.id)] || {
                    validUntil: a.validUntil || "",
                    scopeNote: a.scopeNote || "",
                    sections: a.sections === undefined ? undefined : a.sections,
                  };
                  const sectionsDirty =
                    edit.sections !== undefined && JSON.stringify(edit.sections ?? null) !== JSON.stringify(a.sections ?? null);
                  const dirty = edit.validUntil !== (a.validUntil || "") || edit.scopeNote !== (a.scopeNote || "") || sectionsDirty;
                  return (
                    <div
                      key={a.id}
                      className={`rounded-xl border px-3.5 py-3 space-y-2 ${state === "ACTIVE" ? "border-slate-700/60 bg-slate-900/60" : "border-slate-800 bg-slate-900/40 opacity-80"}`}
                      data-testid={`usr-grant-row-${a.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-100">{biz?.name || `Unit #${a.businessId}`}</span>
                        <span className="text-[9px] font-mono text-slate-500">{biz?.code}</span>
                        <span
                          className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${
                            state === "ACTIVE"
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                              : state === "EXPIRED"
                                ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                                : "bg-slate-500/15 text-slate-300 border-slate-500/40"
                          }`}
                        >
                          {state}
                        </span>
                        <span className="ml-auto text-[9px] text-slate-500">granted by {a.grantedByName}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">Expires</label>
                          <input
                            type="date"
                            value={edit.validUntil}
                            min={today}
                            onChange={(e) => setRowEdits((r) => ({ ...r, [Number(a.id)]: { ...edit, validUntil: e.target.value } }))}
                            data-testid={`usr-grant-expiry-${a.id}`}
                            className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-[11px] focus:outline-none"
                          />
                          <p className="text-[9px] text-slate-500 mt-0.5">Empty = no expiry. Past dates expire the grant automatically.</p>
                        </div>
                        <div>
                          <label className="block text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">Scope note</label>
                          <input
                            type="text"
                            value={edit.scopeNote}
                            placeholder="e.g. Growth & health review only"
                            onChange={(e) => setRowEdits((r) => ({ ...r, [Number(a.id)]: { ...edit, scopeNote: e.target.value } }))}
                            data-testid={`usr-grant-scope-${a.id}`}
                            className="w-full px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-white text-[11px] focus:outline-none"
                          />
                        </div>
                      </div>
                      {biz && farmModuleOfBusiness(biz) && state === "ACTIVE" && (
                        <div className="rounded-lg border border-slate-700/50 bg-slate-800/40 px-2.5 py-2">
                          <AdvisorSectionPicker
                            business={biz}
                            value={edit.sections === undefined ? (a.sections ?? null) : edit.sections}
                            onChange={(next) => setRowEdits((r) => ({ ...r, [Number(a.id)]: { ...edit, sections: next } }))}
                            compact
                            testidPrefix="usr-grant-sec"
                          />
                        </div>
                      )}
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {dirty && (
                          <button
                            onClick={() =>
                              patch(
                                Number(a.id),
                                {
                                  validUntil: edit.validUntil || null,
                                  scopeNote: edit.scopeNote || null,
                                  ...(edit.sections !== undefined ? { sections: edit.sections } : {}),
                                },
                                "Grant updated — expiry/scope/sections saved.",
                              )
                            }
                            disabled={busy}
                            data-testid={`usr-grant-save-${a.id}`}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold disabled:opacity-40"
                          >
                            Save changes
                          </button>
                        )}
                        {state === "ACTIVE" ? (
                          <button
                            onClick={() => patch(Number(a.id), { isActive: false }, "Access revoked — the advisor lost this unit immediately.")}
                            disabled={busy}
                            data-testid={`usr-grant-revoke-${a.id}`}
                            className="px-2.5 py-1 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 text-[10px] font-bold disabled:opacity-40"
                          >
                            Revoke
                          </button>
                        ) : (
                          <button
                            onClick={() => patch(Number(a.id), { isActive: true, ...(edit.validUntil ? { validUntil: edit.validUntil } : {}) }, "Access re-activated.")}
                            disabled={busy}
                            data-testid={`usr-grant-reactivate-${a.id}`}
                            className="px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold disabled:opacity-40"
                          >
                            Re-activate{edit.validUntil ? ` (expires ${edit.validUntil})` : ""}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Grant more units */}
          <section className="rounded-xl border border-teal-500/30 bg-teal-500/5 p-3.5 space-y-3">
            <h4 className="text-[11px] font-black uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
              <CalendarClock className="w-3.5 h-3.5" /> Grant / Renew Access
            </h4>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Farm units <span className="text-slate-500 normal-case font-medium">(farm types highlighted; already-granted units marked)</span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5" data-testid="usr-grant-unit-chips">
                {businesses.map((b) => {
                  const farm = isFarmBusinessCategory(b.category);
                  const held = grantedIds.has(Number(b.id));
                  const on = picked.has(Number(b.id));
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (on) next.delete(Number(b.id));
                          else next.add(Number(b.id));
                          return next;
                        })
                      }
                      data-testid={`usr-grant-biz-${b.code}`}
                      className={`text-left px-2.5 py-2 rounded-lg border text-[11px] font-semibold transition ${
                        on
                          ? "bg-teal-500/20 border-teal-400/60 text-teal-200"
                          : held
                            ? "bg-slate-800/40 border-slate-700 text-slate-500"
                            : farm
                              ? "bg-slate-800/80 border-emerald-600/40 text-slate-200 hover:border-emerald-500/60"
                              : "bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-500"
                      }`}
                    >
                      <div className="truncate">{b.name}</div>
                      <div className="text-[9px] font-mono opacity-70">
                        {b.code}
                        {farm ? " · FARM" : ""}
                        {held ? " · HELD" : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Access expires (optional)</label>
                <input
                  type="date"
                  value={validUntil}
                  min={today}
                  onChange={(e) => setValidUntil(e.target.value)}
                  data-testid="usr-grant-new-expiry"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Scope note (optional)</label>
                <input
                  type="text"
                  value={scopeNote}
                  onChange={(e) => setScopeNote(e.target.value)}
                  placeholder="e.g. Growth & health review only"
                  data-testid="usr-grant-new-scope"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-xs focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={grant}
                disabled={busy || picked.size === 0}
                data-testid="usr-grant-new-submit"
                className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5"
              >
                <ShieldCheck className="w-3.5 h-3.5" /> {busy ? "Granting…" : `Grant access (${picked.size} unit${picked.size === 1 ? "" : "s"})`}
              </button>
            </div>
          </section>

          <p className="text-[10px] text-slate-500 leading-relaxed">
            Every change lands on the immutable audit trail (GRANT_ACCESS / UPDATE_GRANT / REVOKE_ACCESS). Advisors are read-only everywhere except their own notes.
            {onOpenConsole && (
              <button onClick={onOpenConsole} className="ml-1 text-teal-300 font-bold hover:text-teal-200" data-testid="usr-advisor-open-console">
                Open the Farm Advisors console →
              </button>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
