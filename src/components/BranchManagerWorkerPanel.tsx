"use client";

import React, { useState, useEffect } from "react";
import {
  UserPlus,
  Users,
  UserCheck,
  UserX,
  Shield,
  CheckCircle,
  XCircle,
  ToggleLeft,
  ToggleRight,
  Trash2,
  RefreshCw,
  Plus,
  Eye,
  EyeOff,
} from "lucide-react";

interface BranchManagerWorkerPanelProps {
  currentUser: any;
  businessInfo: any;
  onRefreshData: () => void;
  // Entry point to the full Users & Access console — rendered only when the
  // OWNER has delegated user management to this manager.
  onOpenUserAccess?: () => void;
}

export default function BranchManagerWorkerPanel({
  currentUser,
  businessInfo,
  onRefreshData,
  onOpenUserAccess,
}: BranchManagerWorkerPanelProps) {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loadingWorkers, setLoadingWorkers] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState<any>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  // New worker form
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("+233 24 ");
  const [newCanRecordSales, setNewCanRecordSales] = useState(true);
  const [newCanRecordExpenses, setNewCanRecordExpenses] = useState(false);
  const [newCanManageStock, setNewCanManageStock] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Permission edit form
  const [permRecordSales, setPermRecordSales] = useState(true);
  const [permRecordExpenses, setPermRecordExpenses] = useState(false);
  const [permManageStock, setPermManageStock] = useState(false);
  const [isUpdatingPerms, setIsUpdatingPerms] = useState(false);

  const fetchWorkers = async () => {
    setLoadingWorkers(true);
    try {
      const res = await fetch(
        `/api/users/workers?businessId=${businessInfo?.id}`
      );
      const data = await res.json();
      if (data.success) {
        setWorkers(data.workers || []);
      }
    } catch (err) {
      console.error("Error fetching workers:", err);
    } finally {
      setLoadingWorkers(false);
    }
  };

  useEffect(() => {
    if (businessInfo?.id) {
      fetchWorkers();
    }
  }, [businessInfo?.id]);

  const handleCreateWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    setIsCreating(true);

    try {
      const res = await fetch("/api/users/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          phone: newPhone,
          assignedBusinessId: businessInfo?.id,
          createdByUserId: currentUser?.id,
          canRecordSales: newCanRecordSales,
          canRecordExpenses: newCanRecordExpenses,
          canManageStock: newCanManageStock,
        }),
      });

      if (res.ok) {
        setNewName("");
        setNewEmail("");
        setNewPhone("+233 24 ");
        setNewCanRecordSales(true);
        setNewCanRecordExpenses(false);
        setNewCanManageStock(false);
        setShowCreateModal(false);
        fetchWorkers();
        onRefreshData();
      }
    } catch (err) {
      console.error("Error creating worker:", err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleWorker = async (workerId: number) => {
    setActionBusy(workerId);
    try {
      const res = await fetch("/api/users/workers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerId, action: "TOGGLE_ENABLE" }),
      });
      if (res.ok) {
        fetchWorkers();
        onRefreshData();
      }
    } catch (err) {
      console.error("Error toggling worker:", err);
    } finally {
      setActionBusy(null);
    }
  };

  const handleDeleteWorker = async (workerId: number, workerName: string) => {
    if (!confirm(`Are you sure you want to permanently delete ${workerName}?`)) return;
    setActionBusy(workerId);
    try {
      const res = await fetch(`/api/users/workers?workerId=${workerId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchWorkers();
        onRefreshData();
      }
    } catch (err) {
      console.error("Error deleting worker:", err);
    } finally {
      setActionBusy(null);
    }
  };

  const openPermissionModal = (worker: any) => {
    setPermRecordSales(worker.canRecordSales);
    setPermRecordExpenses(worker.canRecordExpenses);
    setPermManageStock(worker.canManageStock);
    setShowPermissionModal(worker);
  };

  const handleUpdatePermissions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showPermissionModal) return;
    setIsUpdatingPerms(true);
    try {
      const res = await fetch("/api/users/workers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workerId: showPermissionModal.id,
          action: "UPDATE_PERMISSIONS",
          canRecordSales: permRecordSales,
          canRecordExpenses: permRecordExpenses,
          canManageStock: permManageStock,
        }),
      });
      if (res.ok) {
        setShowPermissionModal(null);
        fetchWorkers();
        onRefreshData();
      }
    } catch (err) {
      console.error("Error updating permissions:", err);
    } finally {
      setIsUpdatingPerms(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1400px] mx-auto text-slate-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-5 rounded-2xl border border-slate-700/80 shadow-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/20 border border-cyan-400/30 flex items-center justify-center text-cyan-300 shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold border border-cyan-500/30">
              WORKER MANAGEMENT
            </span>
            <h2 className="text-xl font-bold text-white mt-0.5">
              Sales Persons — {businessInfo?.name}
            </h2>
            <p className="text-xs text-slate-400">
              Create, assign permissions, enable/disable, and remove WORKER accounts in your branch
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {currentUser?.canManageUsers && onOpenUserAccess && (
            <button
              onClick={onOpenUserAccess}
              data-testid="open-user-access-bm"
              title="OWNER-delegated: create workers & branch managers, assign roles, branches and permissions"
              className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            >
              <Shield className="w-4 h-4" />
              <span>Users &amp; Access</span>
            </button>
          )}
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Sales Person</span>
          </button>
        </div>
      </div>

      {/* Workers Table */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white">
              Branch Workers ({workers.length})
            </h3>
            <p className="text-xs text-slate-400">
              Manage access, permissions, and status for all Sales Persons
            </p>
          </div>
          <button
            onClick={fetchWorkers}
            className="p-2 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition"
            title="Refresh workers list"
          >
            <RefreshCw className={`w-4 h-4 ${loadingWorkers ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
              <tr>
                <th className="px-4 py-3">Worker Name</th>
                <th className="px-4 py-3">Email & Phone</th>
                <th className="px-4 py-3 text-center">Can Sell</th>
                <th className="px-4 py-3 text-center">Can Expense</th>
                <th className="px-4 py-3 text-center">Can Manage Stock</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {workers.map((worker) => {
                const isEnabled = worker.isWorkerEnabled;
                const isBusy = actionBusy === worker.id;

                return (
                  <tr
                    key={worker.id}
                    className={`hover:bg-slate-700/50 transition ${
                      !isEnabled ? "opacity-60" : ""
                    }`}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center space-x-2.5">
                        <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center font-bold text-xs text-slate-300 shrink-0">
                          {worker.name.charAt(0)}
                        </div>
                        <div>
                          <div className="font-bold text-slate-100">{worker.name}</div>
                          <div className="text-[10px] text-slate-400">
                            Worker ID: #{worker.id}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      <div className="text-xs">{worker.email}</div>
                      <div className="text-[11px] text-slate-400">{worker.phone}</div>
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      {worker.canRecordSales ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400 inline" />
                      ) : (
                        <XCircle className="w-4 h-4 text-slate-600 inline" />
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      {worker.canRecordExpenses ? (
                        <CheckCircle className="w-4 h-4 text-amber-400 inline" />
                      ) : (
                        <XCircle className="w-4 h-4 text-slate-600 inline" />
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      {worker.canManageStock ? (
                        <CheckCircle className="w-4 h-4 text-cyan-400 inline" />
                      ) : (
                        <XCircle className="w-4 h-4 text-slate-600 inline" />
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                          isEnabled
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                        }`}
                      >
                        {isEnabled ? "ACTIVE" : "DISABLED"}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => handleToggleWorker(worker.id)}
                          disabled={isBusy}
                          className={`p-1.5 rounded-lg transition ${
                            isEnabled
                              ? "hover:bg-amber-500/20 text-amber-400"
                              : "hover:bg-emerald-500/20 text-emerald-400"
                          }`}
                          title={isEnabled ? "Disable Worker" : "Enable Worker"}
                        >
                          {isEnabled ? (
                            <ToggleRight className="w-4.5 h-4.5" />
                          ) : (
                            <ToggleLeft className="w-4.5 h-4.5" />
                          )}
                        </button>

                        <button
                          onClick={() => openPermissionModal(worker)}
                          className="p-1.5 rounded-lg hover:bg-cyan-500/20 text-cyan-400 transition"
                          title="Edit Permissions"
                        >
                          <Shield className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleDeleteWorker(worker.id, worker.name)}
                          disabled={isBusy}
                          className="p-1.5 rounded-lg hover:bg-rose-500/20 text-rose-400 transition"
                          title="Remove Worker"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {workers.length === 0 && !loadingWorkers && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                    <div className="space-y-2">
                      <UserPlus className="w-8 h-8 mx-auto text-slate-500" />
                      <p className="text-sm">No Sales Persons in this branch yet.</p>
                      <p className="text-xs">
                        Click "Add Sales Person" to create the first WORKER account.
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Worker Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <UserPlus className="w-5 h-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-white">Add Sales Person</h3>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white text-xl leading-none"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleCreateWorker} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Full Name *
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Adwoa Serwaa"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="worker@branch.gomina360.com"
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Phone Number
                </label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Permissions */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-2">
                  Initial Permissions
                </label>
                <div className="space-y-2 bg-slate-800/60 rounded-lg p-3 border border-slate-700/50">
                  <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                    <span>Can Record Sales</span>
                    <input
                      type="checkbox"
                      checked={newCanRecordSales}
                      onChange={(e) => setNewCanRecordSales(e.target.checked)}
                      className="accent-emerald-500 w-4 h-4"
                    />
                  </label>
                  <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                    <span>Can Record Daily Expenses</span>
                    <input
                      type="checkbox"
                      checked={newCanRecordExpenses}
                      onChange={(e) => setNewCanRecordExpenses(e.target.checked)}
                      className="accent-amber-500 w-4 h-4"
                    />
                  </label>
                  <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                    <span>Can Manage Stock Movements</span>
                    <input
                      type="checkbox"
                      checked={newCanManageStock}
                      onChange={(e) => setNewCanManageStock(e.target.checked)}
                      className="accent-cyan-500 w-4 h-4"
                    />
                  </label>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isCreating ? "Creating..." : "Create Worker Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Permissions Modal */}
      {showPermissionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <Shield className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold text-white">Edit Permissions</h3>
              </div>
              <button
                onClick={() => setShowPermissionModal(null)}
                className="text-slate-400 hover:text-white text-xl leading-none"
              >
                ×
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Setting permissions for:{" "}
              <strong className="text-slate-200">{showPermissionModal.name}</strong>
            </p>

            <form onSubmit={handleUpdatePermissions} className="space-y-3">
              <div className="space-y-2 bg-slate-800/60 rounded-lg p-3 border border-slate-700/50">
                <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                  <span>Can Record Sales</span>
                  <input
                    type="checkbox"
                    checked={permRecordSales}
                    onChange={(e) => setPermRecordSales(e.target.checked)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                  <span>Can Record Daily Expenses</span>
                  <input
                    type="checkbox"
                    checked={permRecordExpenses}
                    onChange={(e) => setPermRecordExpenses(e.target.checked)}
                    className="accent-amber-500 w-4 h-4"
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-slate-200 cursor-pointer">
                  <span>Can Manage Stock Movements</span>
                  <input
                    type="checkbox"
                    checked={permManageStock}
                    onChange={(e) => setPermManageStock(e.target.checked)}
                    className="accent-cyan-500 w-4 h-4"
                  />
                </label>
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowPermissionModal(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingPerms}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isUpdatingPerms ? "Saving..." : "Save Permissions"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
