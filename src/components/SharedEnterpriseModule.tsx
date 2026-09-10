"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  Users,
  Truck,
  UserCheck,
  Wrench,
  Package,
  CreditCard,
  Plus,
  Search,
  Filter,
  CheckCircle,
  AlertTriangle,
  WifiOff,
  Pencil,
  Trash,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { businessManageIdsOf } from "@/lib/permissions";
import { addToOfflineQueue } from "@/lib/offlineSync";
import LocationSelector, { LocationValue, LocationBadge } from "./LocationSelector";
import { REGION_NAMES } from "@/lib/ghanaLocations";
import AssetRegistrationModal from "./AssetRegistrationModal";
import ConfirmActionModal from "./ConfirmActionModal";
import { classifyEntry, confirmMeta } from "@/lib/entryConfirm";
import QrScanModal from "./QrScanModal";
import QrRecordModal from "./QrRecordModal";
import PayrollCenter from "./PayrollCenter";
import { EmployeeRegistration, EmployeeProfile } from "./EmployeeCenter";
import { Landmark } from "lucide-react";
import { buildInventoryQr } from "@/lib/qrRegistry";
import { generateAssetDownload, downloadFile, generateDownloadId, AssetDownloadFilters } from "@/lib/assetDownload";
import { resolveLogo } from "@/lib/logos";
import { generateInventoryDownload, generateInventoryDownloadId, InventoryDownloadFilters } from "@/lib/inventoryDownload";
import { FileSpreadsheet, FileText, FileIcon, Download, SlidersHorizontal, X, QrCode, CheckCircle2 } from "lucide-react";

interface SharedEnterpriseModuleProps {
  moduleType: "CUSTOMERS" | "SUPPLIERS" | "EMPLOYEES" | "ASSETS" | "INVENTORY" | "TRANSACTIONS";
  customers: any[];
  suppliers: any[];
  employees: any[];
  assets: any[];
  inventory: any[];
  transactions: any[];
  businesses: any[];
  currentCurrency: CurrencyCode;
  isOnline: boolean;
  onRefreshData: () => void;
  currentUser?: any;
  /** When set (Branch Manager), every list is scoped to this business/branch. */
  lockedBusinessId?: number | null;
}

export default function SharedEnterpriseModule({
  moduleType,
  customers,
  suppliers,
  employees,
  assets,
  inventory,
  transactions,
  businesses,
  currentCurrency,
  isOnline,
  onRefreshData,
  currentUser,
  lockedBusinessId = null,
}: SharedEnterpriseModuleProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showEmpReg, setShowEmpReg] = useState(false); // Employee Registration modal
  const [empEdit, setEmpEdit] = useState<any | null>(null); // employee being edited in the full form
  const [empProfile, setEmpProfile] = useState<any | null>(null); // employee profile modal
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [assetAuditLogs, setAssetAuditLogs] = useState<any[]>([]);
  const [assetDownloadHistory, setAssetDownloadHistory] = useState<any[]>([]);
  const [assetActionBusy, setAssetActionBusy] = useState<number | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [showDownloadFilters, setShowDownloadFilters] = useState(false);
  const [dlFilterBusinessId, setDlFilterBusinessId] = useState<string>("ALL");
  const [dlFilterBranchCode, setDlFilterBranchCode] = useState<string>("ALL");
  const [dlFilterRegion, setDlFilterRegion] = useState<string>("ALL");
  const [dlFilterDistrict, setDlFilterDistrict] = useState<string>("");
  const [dlFilterAssetType, setDlFilterAssetType] = useState<string>("ALL");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Standardized Ghana location for new records + region filter for reporting
  const [location, setLocation] = useState<LocationValue>({
    region: "",
    district: "",
    town: "",
  });
  const [regionFilter, setRegionFilter] = useState("ALL");

  // General add form state
  const [name, setName] = useState("");
  const [typeOrCategory, setTypeOrCategory] = useState("GENERAL");
  const [phone, setPhone] = useState("+233 24 100 2000");
  const [email, setEmail] = useState("contact@domain.gh");
  const [amountGhs, setAmountGhs] = useState(5000);
  const [businessId, setBusinessId] = useState("1");
  const [roleOrType, setRoleOrType] = useState("Staff Member");
  const [paymentMethod, setPaymentMethod] = useState("MTN_MOMO");
  const [description, setDescription] = useState("Transaction payment via MTN MoMo");
  const [trxType, setTrxType] = useState("INCOME");

  // ─── Confirmation gate for Sale / Inventory / Asset final execution ───
  const [confirmAction, setConfirmAction] = useState<null | {
    title: string;
    message: string;
    details: { label: string; value: string }[];
    tone: any;
    confirmLabel: string;
    run: () => void;
  }>(null);

  // ─── INVENTORY add-form: business + branch/register, stock details & photos ───
  const [invBranch, setInvBranch] = useState("");
  const [invQty, setInvQty] = useState<number>(50);
  const [invUnit, setInvUnit] = useState("Units");
  const [invCost, setInvCost] = useState<number>(20);
  const [invPrice, setInvPrice] = useState<number>(35);
  const [invMin, setInvMin] = useState<number>(10);
  const [invPhotos, setInvPhotos] = useState<string[]>([]);
  const [invPhotoErr, setInvPhotoErr] = useState("");

  // ─── QR registry: camera scan → open existing record / guided registration ───
  const [invQr, setInvQr] = useState("");
  const [qrScanOpen, setQrScanOpen] = useState(false);
  const [showPayroll, setShowPayroll] = useState(false);

  // ─── Form completion UX: every successful save CLOSES the form, confirms
  // with a flash, and the next open starts from a clean slate. ───
  const [formFlash, setFormFlash] = useState("");
  const flashSaved = (msg: string) => {
    setFormFlash(msg);
    setTimeout(() => setFormFlash((f) => (f === msg ? "" : f)), 4500);
  };
  const resetSharedForm = () => {
    setName("");
    setTypeOrCategory("GENERAL");
    setPhone("+233 24 100 2000");
    setEmail("contact@domain.gh");
    setAmountGhs(5000);
    setRoleOrType("Staff Member");
    setPaymentMethod("MTN_MOMO");
    setDescription("Transaction payment via MTN MoMo");
    setTrxType("INCOME");
    setInvQty(50);
    setInvUnit("Units");
    setInvCost(20);
    setInvPrice(35);
    setInvMin(10);
    setInvPhotos([]);
    setInvPhotoErr("");
    setInvQr("");
    setQrError("");
    setLocation({ region: "", district: "", town: "" });
  };
  const [qrScanTarget, setQrScanTarget] = useState<"lookup" | "inventory-form">("lookup");
  const [qrBusy, setQrBusy] = useState(false);
  const [qrError, setQrError] = useState("");
  const [qrRecord, setQrRecord] = useState<{ kind: "inventory" | "asset"; record: any; justRegistered?: boolean; } | null>(null);
  const [assetQrPreset, setAssetQrPreset] = useState("");

  /** Keep the required Branch/Register field valid: default it to the owning
   *  business code whenever a flow opens the inventory form without one. */
  const ensureInvBranch = () => {
    if (moduleType !== "INVENTORY") return;
    const biz = businesses.find((b: any) => String(b.id) === String(businessId));
    if (!invBranch.trim() && biz?.code) setInvBranch(String(biz.code));
  };

  /** Scanned/typed code → registry lookup. Existing: open the record. New:
   *  attach to the active form (or open the right registration form). */
  const handleQrCode = async (code: string) => {
    setQrBusy(true);
    setQrError("");
    try {
      const res = await fetch(`/api/enterprise?qr=${encodeURIComponent(code)}`);
      const d = await res.json().catch(() => null);
      setQrScanOpen(false);
      if (res.ok && d?.found && d.record) {
        setQrRecord({ kind: d.kind === "asset" ? "asset" : "inventory", record: d.record });
        return;
      }
      if (qrScanTarget === "inventory-form") {
        ensureInvBranch();
        setInvQr(code);
      } else if (moduleType === "ASSETS") {
        setAssetQrPreset(code);
        setShowAssetModal(true);
      } else {
        resetSharedForm();
        setInvQr(code);
        ensureInvBranch();
        setShowModal(true);
      }
    } catch (e: any) {
      setQrError(e?.message || "Registry lookup failed — try again.");
    } finally {
      setQrBusy(false);
    }
  };

  /** Accepts uploaded images or camera captures (data URLs), 5MB max each. */
  const handleInvPhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file) => {
      if (file.size > 5 * 1024 * 1024) {
        setInvPhotoErr("Each photo must be under 5MB.");
        return;
      }
      setInvPhotoErr("");
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) setInvPhotos((prev) => [...prev, ev.target!.result as string]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };
  const removeInvPhoto = (idx: number) => setInvPhotos((prev) => prev.filter((_, i) => i !== idx));

  const isExecutiveUser =
    currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER";
  const isBranchManagerUser = currentUser?.role === "BRANCH_MANAGER";

  // ─── OWNER-controlled record management (Transactions, Suppliers, Employees) ───
  // The OWNER always can; managers only while the OWNER has granted the flag.
  const isOwnerUser = currentUser?.role === "OWNER";
  const canManageShared = isOwnerUser || currentUser?.canManageRecords === true;
  // Inventory & Stock: the OWNER always can manage/edit/delete; every other
  // user only while the OWNER has granted the delete-inventory permission.
  const canDeleteInv = isOwnerUser || currentUser?.canDeleteInventory === true;
  // Expenses (transactions with type === "EXPENSE"): the OWNER always can
  // edit/delete; every other user only while the OWNER has granted the
  // expense-management permission.
  const canManageExp = isOwnerUser || currentUser?.canManageExpenses === true;

  // ─── OWNER-delegated "Manage Business / Unit" power ─────────────────────
  // A user the OWNER granted a unit may manage/edit/delete THAT unit's records
  // with owner-equivalent power (strictly the granted unit). The OWNER manages
  // all units; the flags above still grant their original user-level powers.
  const managedBizIds = useMemo(
    () => new Set(businessManageIdsOf(currentUser)),
    [currentUser]
  );
  const bizOwnerLike = (bid?: number | null) =>
    isOwnerUser || (bid != null && managedBizIds.has(Number(bid)));
  const MANAGEABLE =
    moduleType === "TRANSACTIONS" ||
    moduleType === "SUPPLIERS" ||
    moduleType === "EMPLOYEES" ||
    moduleType === "INVENTORY";

  const [editingRecord, setEditingRecord] = useState<any | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<any | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordErr, setRecordErr] = useState("");
  const [deletionLogs, setDeletionLogs] = useState<any[]>([]);
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [accessUsers, setAccessUsers] = useState<any[]>([]);
  const [accessBusy, setAccessBusy] = useState<string | null>(null);

  const refreshDeletionLogs = useCallback(async () => {
    if (!MANAGEABLE) return;
    try {
      const r = await fetch(`/api/enterprise?deletionLogs=1&module=${moduleType}`);
      const d = await r.json();
      if (d.success) setDeletionLogs(d.logs || []);
    } catch {
      /* audit panel is informational */
    }
  }, [moduleType, MANAGEABLE]);

  useEffect(() => {
    setDeletionLogs([]);
    refreshDeletionLogs();
  }, [refreshDeletionLogs]);

  const recordLabel = (r: any) =>
    moduleType === "TRANSACTIONS"
      ? `${r.transactionNumber} — GH₵ ${r.amountGhs} (${r.category})`
      : moduleType === "SUPPLIERS"
      ? r.name
      : moduleType === "INVENTORY"
      ? `${r.name} (${r.sku})`
      : `${r.name} (${r.role})`;

  // Edit submit: PATCH to the module's endpoint — server re-checks permission.
  const submitRecordEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord) return;
    const kind =
      moduleType === "INVENTORY"
        ? classifyEntry("INVENTORY")
        : moduleType === "TRANSACTIONS" && editingRecord.type === "INCOME"
        ? classifyEntry("SALE")
        : null;
    if (kind) {
      const meta = confirmMeta(kind, { name: editingRecord.name, amountGhs: editingRecord.amountGhs });
      setConfirmAction({ ...meta, run: performRecordEdit });
    } else {
      performRecordEdit();
    }
  };

  const performRecordEdit = async () => {
    if (!editingRecord) return;
    setRecordBusy(true);
    setRecordErr("");
    try {
      const isTrx = moduleType === "TRANSACTIONS";
      const body: any = isTrx
        ? {
            id: editingRecord.id,
            actorUserId: currentUser?.id,
            data: {
              type: editingRecord.type,
              category: editingRecord.category,
              amountGhs: editingRecord.amountGhs,
              paymentMethod: editingRecord.paymentMethod,
              description: editingRecord.description,
            },
          }
        : moduleType === "SUPPLIERS"
        ? {
            entityType: "SUPPLIERS",
            id: editingRecord.id,
            actorUserId: currentUser?.id,
            data: {
              name: editingRecord.name,
              category: editingRecord.category,
              contactPerson: editingRecord.contactPerson,
              phone: editingRecord.phone,
              email: editingRecord.email,
              paymentTerms: editingRecord.paymentTerms,
            },
          }
        : moduleType === "INVENTORY"
        ? {
            entityType: "INVENTORY",
            id: editingRecord.id,
            actorUserId: currentUser?.id,
            data: {
              name: editingRecord.name,
              sku: editingRecord.sku,
              category: editingRecord.category,
              unit: editingRecord.unit,
              quantity: editingRecord.quantity,
              costPriceGhs: editingRecord.costPriceGhs,
              sellingPriceGhs: editingRecord.sellingPriceGhs,
              minStockThreshold: editingRecord.minStockThreshold,
              expiryDate: editingRecord.expiryDate,
              businessId: editingRecord.businessId,
            },
          }
        : {
            entityType: "EMPLOYEES",
            id: editingRecord.id,
            actorUserId: currentUser?.id,
            data: {
              name: editingRecord.name,
              role: editingRecord.role,
              phone: editingRecord.phone,
              status: editingRecord.status,
              salaryGhs: editingRecord.salaryGhs,
              businessId: editingRecord.businessId,
            },
          };
      const res = await fetch(isTrx ? "/api/transactions" : "/api/enterprise", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setEditingRecord(null);
        onRefreshData();
      } else {
        setRecordErr(d.error || "Edit failed.");
      }
    } catch (err: any) {
      setRecordErr(err.message || "Edit failed.");
    } finally {
      setRecordBusy(false);
    }
  };

  // Delete: mandatory reason + explicit confirmation; server audits & deletes.
  const confirmRecordDelete = async () => {
    if (!deletingRecord || deleteReason.trim().length < 3) return;
    setRecordBusy(true);
    setRecordErr("");
    try {
      const isTrx = moduleType === "TRANSACTIONS";
      const res = await fetch(isTrx ? "/api/transactions" : "/api/enterprise", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isTrx
            ? { id: deletingRecord.id, reason: deleteReason.trim(), actorUserId: currentUser?.id }
            : { entityType: moduleType, id: deletingRecord.id, reason: deleteReason.trim(), actorUserId: currentUser?.id }
        ),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setDeletingRecord(null);
        setDeleteReason("");
        onRefreshData();
        refreshDeletionLogs();
      } else {
        setRecordErr(d.error || "Delete failed.");
      }
    } catch (err: any) {
      setRecordErr(err.message || "Delete failed.");
    } finally {
      setRecordBusy(false);
    }
  };

  // OWNER access-control console: grant / revoke the module's management
  // flags. Transactions expose two independent flags — the shared-record flag
  // for income/investment/transfer rows and the expense-management flag for
  // expense rows. Inventory uses canDeleteInventory.
  const accessFields =
    moduleType === "INVENTORY"
      ? [{ key: "canDeleteInventory", label: "Manage, edit & delete inventory entries" }]
      : moduleType === "TRANSACTIONS"
      ? [
          { key: "canManageRecords", label: "Manage & delete transactions (income, investment, transfer)" },
          { key: "canManageExpenses", label: "Manage & delete expenses" },
        ]
      : [{ key: "canManageRecords", label: "Manage & delete records" }];

  const openAccessControl = async () => {
    setShowAccessModal(true);
    try {
      const r = await fetch("/api/users");
      const d = await r.json();
      if (d.success) setAccessUsers((d.users || []).filter((u: any) => u.role !== "OWNER"));
    } catch {
      /* non-critical */
    }
  };

  const toggleRecordAccess = async (u: any, field: string) => {
    setAccessBusy(`${field}:${u.id}`);
    try {
      const r = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: u.id,
          [field]: !u[field],
          requestingUserRole: currentUser?.role,
        }),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        setAccessUsers((prev) =>
          prev.map((x) => (x.id === u.id ? { ...x, [field]: d.user[field] } : x))
        );
        onRefreshData();
      }
    } catch {
      /* non-critical */
    } finally {
      setAccessBusy(null);
    }
  };

  // Actions cell shared by the three manageable tables. Expense transactions
  // (type === "EXPENSE") are gated by the OWNER-granted expense-management
  // permission; every other record uses the shared-record permission.
  const RecordActions = ({ r, prefix, onProfile }: { r: any; prefix: string; onProfile?: (r: any) => void }) => {
    const isExpense = r?.type === "EXPENSE";
    const permitted = (isExpense ? canManageExp : canManageShared) || bizOwnerLike(r?.businessId);
    const lockHint = isExpense
      ? "Only the OWNER, or a manager granted the expense-management permission by the OWNER, can manage or delete expenses"
      : "Only the OWNER, or a manager granted permission by the OWNER, can manage records";
    return (
      <td className="px-4 py-3.5 text-center">
        {permitted ? (
          <div className="flex items-center justify-center gap-1.5">
            {onProfile && (
              <button
                title="Open full record (profile, documents, history)"
                data-testid={`${prefix}-profile-${r.id}`}
                onClick={() => onProfile(r)}
                className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-teal-500/30 text-slate-200 hover:text-teal-300 transition"
              >
                <UserCheck className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              title="Edit record"
              data-testid={`${prefix}-edit-${r.id}`}
              onClick={() => { setEditingRecord({ ...r }); setRecordErr(""); }}
              className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-indigo-500/30 text-slate-200 hover:text-indigo-300 transition"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              title="Delete record (reason is recorded)"
              data-testid={`${prefix}-delete-${r.id}`}
              onClick={() => { setDeletingRecord(r); setDeleteReason(""); setRecordErr(""); }}
              className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 transition"
            >
              <Trash className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1.5">
            {onProfile && (
              <button
                title="Open full record (read-only)"
                data-testid={`${prefix}-profile-${r.id}`}
                onClick={() => onProfile(r)}
                className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-teal-500/30 text-slate-200 hover:text-teal-300 transition"
              >
                <UserCheck className="w-3.5 h-3.5" />
              </button>
            )}
            <span
              title={lockHint}
              className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-500 bg-slate-800 border border-slate-700 px-2 py-1 rounded"
            >
              <Lock className="w-3 h-3" /> LOCKED
            </span>
          </div>
        )}
      </td>
    );
  };

  const refreshAssetAuditLogs = async () => {
    if (moduleType !== "ASSETS") return;
    try {
      const res = await fetch("/api/assets/audit");
      const data = await res.json();
      if (data.success) setAssetAuditLogs(data.logs || []);
    } catch (err) {
      console.error("Failed to load asset audit logs", err);
    }
  };

  useEffect(() => {
    refreshAssetAuditLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleType, assets.length]);

  const refreshAssetDownloads = async () => {
    if (moduleType !== "ASSETS") return;
    try {
      const res = await fetch("/api/assets/download");
      const data = await res.json();
      if (data.success) setAssetDownloadHistory(data.downloads || []);
    } catch (err) {
      console.error("Failed to load download history", err);
    }
  };

  useEffect(() => {
    refreshAssetDownloads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleType]);

  // ── Unique asset types from the assets table (for the filter dropdown)
  const assetTypes = Array.from(
    new Set(assets.map((a: any) => a.assetType).filter(Boolean))
  ).sort();

  // ── Filtered assets for download (respects every filter the user set)
  const getFilteredDownloadAssets = (): any[] => {
    return assets.filter((a: any) => {
      if (dlFilterBusinessId !== "ALL" && a.businessId !== Number(dlFilterBusinessId)) return false;
      if (dlFilterBranchCode !== "ALL" && a.branchCode !== dlFilterBranchCode) return false;
      if (dlFilterRegion !== "ALL" && a.region !== dlFilterRegion) return false;
      if (
        dlFilterDistrict &&
        ![a.town, a.district, a.location]
          .filter(Boolean)
          .some((f: string) =>
            f.toLowerCase().includes(dlFilterDistrict.toLowerCase())
          )
      )
        return false;
        if (dlFilterAssetType !== "ALL" && a.assetType !== dlFilterAssetType) return false;
      return true;
    });
  };

  // Returns filtered inventory items for download preview/execute
  const getFilteredDownloadInventory = (): any[] => {
    return inventory.filter((i: any) => {
      if (dlFilterBusinessId !== "ALL" && i.businessId !== Number(dlFilterBusinessId)) return false;
      if (dlFilterBranchCode !== "ALL") {
        const biz = businesses.find((b: any) => b.code === dlFilterBranchCode);
        if (!biz || biz.id !== i.businessId) return false;
      }
      if (dlFilterRegion !== "ALL") {
        const biz = businesses.find((b: any) => b.id === i.businessId);
        if (!biz || biz.region !== dlFilterRegion) return false;
      }
      if (dlFilterDistrict) {
        const hay = [i.town, i.district].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(dlFilterDistrict.toLowerCase())) return false;
      }
      if (dlFilterAssetType !== "ALL" && i.category !== dlFilterAssetType) return false;
      return true;
    });
  };

  const resetDownloadFilters = () => {
    setDlFilterBusinessId("ALL");
    setDlFilterBranchCode("ALL");
    setDlFilterRegion("ALL");
    setDlFilterDistrict("");
    setDlFilterAssetType("ALL");
  };

  // Derive the business name / branch name labels for the filter metadata
  const dlFilterBusinessName =
    dlFilterBusinessId === "ALL"
      ? "All Businesses"
      : businesses.find((b: any) => String(b.id) === dlFilterBusinessId)?.name || "";
  const dlFilterBranchName =
    dlFilterBranchCode === "ALL"
      ? "All Branches"
      : businesses.find((b: any) => b.code === dlFilterBranchCode)?.name || dlFilterBranchCode;

  const handleAssetDownload = async (format: "EXCEL" | "PDF" | "CSV") => {
    if (moduleType !== "ASSETS" || !currentUser) return;

    // Permission check: Branch Manager requires executive approval
    if (currentUser.role === "BRANCH_MANAGER") {
      alert("Branch Managers require executive approval to download asset records. Please contact your Owner or General Manager.");
      return;
    }

    setDownloading(format);
    try {
      const downloadId = generateDownloadId();
      const filteredAssets = getFilteredDownloadAssets();
      const userBusiness = businesses.find((b: any) => b.id === currentUser.assignedBusinessId);

      if (filteredAssets.length === 0) {
        alert("No assets match the current filters. Please adjust your filters and try again.");
        setDownloading(null);
        return;
      }

      const filters: AssetDownloadFilters = {
        businessName: dlFilterBusinessName,
        branchCode: dlFilterBranchCode === "ALL" ? undefined : dlFilterBranchCode,
        branchName: dlFilterBranchCode === "ALL" ? undefined : dlFilterBranchName,
        region: dlFilterRegion === "ALL" ? undefined : dlFilterRegion,
        district: dlFilterDistrict || undefined,
        assetType: dlFilterAssetType === "ALL" ? undefined : dlFilterAssetType,
      };

      const result = await generateAssetDownload({
        downloadId,
        format,
        assets: filteredAssets,
        downloaderName: currentUser.name,
        downloaderRole: currentUser.role,
        downloaderBusinessId: currentUser.assignedBusinessId,
        downloaderBranchCode: userBusiness?.code,
        downloaderBranchName: userBusiness?.name,
        currency: currentCurrency,
        filters,
        // Correct-business logo: the filtered business (its branch override
        // when a branch is selected); company logo for all-business reports.
        logo: resolveLogo(
          dlFilterBusinessId === "ALL" ? null : businesses.find((b: any) => String(b.id) === String(dlFilterBusinessId)) || null,
          dlFilterBranchCode === "ALL" ? null : dlFilterBranchCode
        ),
      });

      // Record download in database
      const recordRes = await fetch("/api/assets/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          downloadId: result.downloadId,
          downloaderUserId: currentUser.id,
          downloaderName: result.qrCodePayload.downloaderName,
          downloaderRole: result.qrCodePayload.downloaderRole,
          downloaderBusinessId: result.qrCodePayload.businessId,
          downloaderBranchCode: result.qrCodePayload.branchCode,
          downloaderBranchName: result.qrCodePayload.branchName,
          format: result.qrCodePayload.format,
          recordCount: result.qrCodePayload.recordCount,
          qrCodeData: result.qrCodeData,
          qrCodePayload: result.qrCodePayload,
        }),
      });

      if (!recordRes.ok) throw new Error("Failed to record download");

      downloadFile(result.fileData, result.fileName);
      await refreshAssetDownloads();

      // Close filter panel after successful download
      setShowDownloadFilters(false);

      alert(
        `✓ Asset register downloaded successfully!\n\nDownload ID: ${downloadId}\nFormat: ${format}\nRecords: ${filteredAssets.length} (of ${assets.length} total)`
      );
    } catch (err: any) {
      console.error("Download failed:", err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloading(null);
    }
  };

  // ── Inventory download handler ──
  const handleInventoryDownload = async (format: "EXCEL" | "PDF" | "CSV") => {
    if (moduleType !== "INVENTORY" || !currentUser) return;

    if (currentUser.role === "BRANCH_MANAGER") {
      alert("Branch Managers require executive approval to download inventory records. Please contact your Owner or General Manager.");
      return;
    }

    const filteredInventory = getFilteredDownloadInventory();

    const bizName = dlFilterBusinessId === "ALL" ? "All Businesses" : businesses.find((b: any) => String(b.id) === dlFilterBusinessId)?.name || "";
    const branchName = dlFilterBranchCode === "ALL" ? "All Branches" : businesses.find((b: any) => b.code === dlFilterBranchCode)?.name || dlFilterBranchCode;

    const filters: InventoryDownloadFilters = {
      businessName: bizName !== "All Businesses" ? bizName : undefined,
      branchCode: dlFilterBranchCode === "ALL" ? undefined : dlFilterBranchCode,
      branchName: dlFilterBranchCode === "ALL" ? undefined : branchName,
      region: dlFilterRegion === "ALL" ? undefined : dlFilterRegion,
      district: dlFilterDistrict || undefined,
      inventoryType: dlFilterAssetType === "ALL" ? undefined : dlFilterAssetType,
    };

    setDownloading(format);
    try {
      const downloadId = generateInventoryDownloadId();
      const userBusiness = businesses.find((b: any) => b.id === currentUser.assignedBusinessId);

      const result = await generateInventoryDownload({
        downloadId,
        format,
        inventory: filteredInventory,
        businesses,
        downloaderName: currentUser.name,
        downloaderRole: currentUser.role,
        downloaderBusinessId: currentUser.assignedBusinessId,
        downloaderBranchCode: userBusiness?.code,
        downloaderBranchName: userBusiness?.name,
        currency: currentCurrency,
        filters,
        // Correct-business logo: the filtered business (its branch override
        // when a branch is selected); company logo for all-business reports.
        logo: resolveLogo(
          dlFilterBusinessId === "ALL" ? null : businesses.find((b: any) => String(b.id) === String(dlFilterBusinessId)) || null,
          dlFilterBranchCode === "ALL" ? null : dlFilterBranchCode
        ),
      });

      // Record download
      const recordRes = await fetch("/api/inventory/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          downloadId: result.downloadId,
          downloaderUserId: currentUser.id,
          downloaderName: currentUser.name,
          downloaderRole: currentUser.role,
          downloaderBusinessId: currentUser.assignedBusinessId,
          downloaderBranchCode: userBusiness?.code,
          downloaderBranchName: userBusiness?.name,
          format,
          recordCount: result.qrCodePayload.recordCount,
          qrCodeData: result.qrCodeData,
          qrCodePayload: result.qrCodePayload,
        }),
      });

      if (!recordRes.ok) throw new Error("Failed to record download");

      downloadFile(result.fileData, result.fileName);

      setShowDownloadFilters(false);
      alert(
        `✓ Inventory downloaded successfully!\n\nDownload ID: ${downloadId}\nFormat: ${format}\nRecords: ${filteredInventory.length} items`
      );
    } catch (err: any) {
      console.error("Inventory download failed:", err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setDownloading(null);
    }
  };

  const getModuleConfig = () => {
    switch (moduleType) {
      case "CUSTOMERS":
        return {
          title: "Enterprise Customers & CRM",
          subtitle: "Wholesale, retail, and corporate buyers shared across the 7 Ghanaian businesses.",
          icon: <Users className="w-6 h-6 text-emerald-400" />,
          buttonLabel: "Add New Customer",
        };
      case "SUPPLIERS":
        return {
          title: "Suppliers & Vendors Directory",
          subtitle: "Poultry feed suppliers, cement distributors, electronics importers, and payment terms.",
          icon: <Truck className="w-6 h-6 text-amber-400" />,
          buttonLabel: "Add Supplier",
        };
      case "EMPLOYEES":
        return {
          title: "Employees & Enterprise Payroll",
          subtitle: "Staff directory, branch assignments, salaries in GH₵, and role permissions.",
          icon: <UserCheck className="w-6 h-6 text-teal-400" />,
          buttonLabel: "Add Employee",
        };
      case "ASSETS":
        return {
          title: "Assets & Machinery Register",
          subtitle: "Tractors, block molding machines, river cages, solar arrays, and maintenance schedules.",
          icon: <Wrench className="w-6 h-6 text-purple-400" />,
          buttonLabel: "Register Asset",
        };
      case "INVENTORY":
        return {
          title: "Unified Inventory & Stock Master",
          subtitle: "Enterprise-wide item directory with low-stock alerts and QR labels.",
          icon: <Package className="w-6 h-6 text-cyan-400" />,
          buttonLabel: "Add Stock Item",
        };
      case "TRANSACTIONS":
      default:
        return {
          title: "Enterprise Financial Transactions",
          subtitle: "Multi-channel sales, supplier payments, payroll, and MoMo instant receipts.",
          icon: <CreditCard className="w-6 h-6 text-emerald-400" />,
          buttonLabel: "Log New Transaction",
        };
    }
  };

  const config = getModuleConfig();

  // Branch/register options for the INVENTORY form: the business's own code
  // plus any registers already used by its transactions.
  const invBranchOptions = useMemo(() => {
    const biz = businesses.find((b: any) => String(b.id) === String(businessId));
    const set = new Set<string>();
    if (biz?.code) set.add(String(biz.code));
    for (const t of transactions || []) {
      if (String(t.businessId) === String(businessId) && t.branchCode) set.add(String(t.branchCode));
    }
    return [...set];
  }, [businesses, businessId, transactions]);

  const handleInvBusinessChange = (id: string) => {
    setBusinessId(id);
    const biz = businesses.find((b: any) => String(b.id) === String(id));
    setInvBranch(biz?.code || "");
  };

  // Confirmation gate: Sale / Inventory / Asset entries confirm before saving.
  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    const kind =
      moduleType === "INVENTORY"
        ? classifyEntry("INVENTORY")
        : moduleType === "ASSETS"
        ? classifyEntry("ASSET")
        : moduleType === "TRANSACTIONS" && trxType === "INCOME"
        ? classifyEntry("SALE")
        : null;
    if (kind) {
      const meta = confirmMeta(
        kind,
        moduleType === "INVENTORY"
          ? { name, quantity: invQty }
          : moduleType === "ASSETS"
          ? { name }
          : { amountGhs, paymentMethod }
      );
      setConfirmAction({ ...meta, run: performAddItem });
    } else {
      performAddItem();
    }
  };

  const performAddItem = async () => {
    setIsSubmitting(true);

    if (moduleType === "TRANSACTIONS") {
      // Resolve branch info from the selected business
      const selectedBiz = businesses.find(
        (b: any) => String(b.id) === businessId
      );
      const payload = {
        businessId: Number(businessId),
        branchCode: selectedBiz?.code || null,
        branchName: selectedBiz?.name || null,
        type: trxType,
        category: typeOrCategory || "General Sales",
        amountGhs: Number(amountGhs) || 0,
        paymentMethod,
        description,
        recordedBy: currentUser?.name || "Command Center User",
        recordedByRole: currentUser?.role || null,
        recordedByUserId: currentUser?.id || null,
      };

      if (!isOnline) {
        addToOfflineQueue("TRANSACTION", payload);
        setIsSubmitting(false);
        setShowModal(false);
        resetSharedForm();
        flashSaved("Transaction queued offline — it posts automatically when you're back online.");
        onRefreshData();
        return;
      }

      try {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          onRefreshData();
          setShowModal(false);
          resetSharedForm();
          flashSaved("✓ Transaction saved — form closed. Add another anytime.");
        } else {
          setQrError("Save failed — please check the details and try again.");
        }
      } catch (err) {
        console.error("Error creating transaction:", err);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Other shared records
    let entityType = "customer";
    let data: any = { name, phone, email };

    if (moduleType === "SUPPLIERS") {
      entityType = "supplier";
      data = {
        name,
        category: typeOrCategory,
        contactPerson: name,
        phone,
        email,
        paymentTerms: "NET_30",
      };
    } else if (moduleType === "EMPLOYEES") {
      entityType = "employee";
      data = {
        name,
        role: roleOrType,
        businessId: Number(businessId),
        branch: "Accra Regional",
        salaryGhs: Number(amountGhs) || 3500,
        phone,
      };
    } else if (moduleType === "ASSETS") {
      entityType = "asset";
      data = {
        name,
        businessId: Number(businessId),
        assetType: typeOrCategory,
        purchasePriceGhs: Number(amountGhs) || 25000,
        currentValueGhs: Number(amountGhs) * 0.9,
        condition: "EXCELLENT",
        location: "Main Branch",
      };
    } else if (moduleType === "INVENTORY") {
      entityType = "inventory";
      const invBiz = businesses.find((b: any) => String(b.id) === String(businessId));
      // Every stock row carries a globally-unique QR identity: the scanned
      // code when attached, else an auto-generated GM360-INV tag over the item
      // code (generated here to the server pattern so the QR is deterministic).
      const invSku = `SKU-${Math.floor(10000 + Math.random() * 90000)}`;
      const qrValue = invQr || buildInventoryQr(invBiz?.code || "GM", invSku);
      data = {
        name,
        sku: invSku,
        qrCode: qrValue,
        registeredByName: currentUser?.name || null,
        registeredByUserId: currentUser?.id || null,
        businessId: Number(businessId),
        branchCode: invBranch.trim() || invBiz?.code || null,
        branchName: invBiz?.name || null,
        category: typeOrCategory,
        quantity: Number(invQty) || 0,
        unit: invUnit || "Units",
        costPriceGhs: Number(invCost) || 0,
        sellingPriceGhs: Number(invPrice) || 0,
        minStockThreshold: Number(invMin) || 10,
        photo: invPhotos[0] || null,
        photos: invPhotos,
      };
    }

    // Attach the standardized Ghana location to every enterprise record
    data = {
      ...data,
      region: location.region,
      district: location.district,
      town: location.town,
    };

    try {
      const res = await fetch("/api/enterprise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, data }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        onRefreshData();
        setShowModal(false);
        resetSharedForm();
        // Fresh registration → show the stored record with its printable QR label.
        if (entityType === "inventory" && body?.item) {
          setQrRecord({ kind: "inventory", record: body.item, justRegistered: true });
        }
        flashSaved(
          entityType === "inventory"
            ? "✓ Stock item saved — form closed. Scan its QR label to restock fast."
            : entityType === "asset"
            ? "✓ Asset saved — form closed."
            : entityType === "supplier"
            ? "✓ Supplier saved — form closed."
            : entityType === "employee"
            ? "✓ Employee saved — form closed."
            : "✓ Customer saved — form closed."
        );
      } else {
        // e.g. 409 duplicate QR — stay in the form and say why, plainly.
        setQrError(body?.error || "Save failed — please check the details and try again.");
      }
    } catch (err) {
      console.error("Error saving entity:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestAssetApproval = async (
    asset: any,
    requestedAction: "EDIT" | "TRANSFER" | "DELETE"
  ) => {
    const note = window.prompt(
      `Reason for ${requestedAction.toLowerCase()} request on ${asset.assetCode}:`,
      `Request permission to ${requestedAction.toLowerCase()} ${asset.name}`
    );
    if (note === null) return;
    setAssetActionBusy(asset.id);
    try {
      const res = await fetch("/api/assets/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: asset.id,
          requestedAction,
          requestedByUserId: currentUser?.id,
          requestedByName: currentUser?.name,
          requestedByRole: currentUser?.role,
          detailsJson: { reason: note, branchCode: asset.branchCode },
        }),
      });
      if (res.ok) {
        await refreshAssetAuditLogs();
      }
    } finally {
      setAssetActionBusy(null);
    }
  };

  const decideAssetApproval = async (auditId: number, decision: "APPROVED" | "REJECTED") => {
    setAssetActionBusy(auditId);
    try {
      const res = await fetch("/api/assets/audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditId,
          decision,
          approvedByUserId: currentUser?.id,
          approvedByName: currentUser?.name,
        }),
      });
      if (res.ok) await refreshAssetAuditLogs();
    } finally {
      setAssetActionBusy(null);
    }
  };

  const performAssetEdit = async (asset: any, numeric: number) => {
    setAssetActionBusy(asset.id);
    try {
      await fetch("/api/assets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: asset.id,
          actorUserId: currentUser?.id,
          actorName: currentUser?.name,
          actorRole: currentUser?.role,
          updates: { currentValueGhs: numeric },
        }),
      });
      onRefreshData();
      refreshAssetAuditLogs();
    } finally {
      setAssetActionBusy(null);
    }
  };

  const executiveAssetEdit = (asset: any) => {
    const nextValue = window.prompt(
      `New current value for ${asset.assetCode} (GH₵):`,
      String(asset.currentValueGhs || 0)
    );
    if (nextValue === null) return;
    const numeric = Number(nextValue);
    if (Number.isNaN(numeric) || numeric < 0) return;
    setConfirmAction({
      title: "Confirm Asset Edit",
      message: `You're about to update the current value of ${asset.assetCode} — ${asset.name}.`,
      details: [
        { label: "Asset", value: asset.name },
        { label: "Asset Code", value: asset.assetCode },
        { label: "New Current Value", value: `GH₵ ${numeric}` },
      ],
      tone: "purple",
      confirmLabel: "Confirm Edit",
      run: () => performAssetEdit(asset, numeric),
    });
  };

  const performAssetTransfer = async (asset: any, targetBiz: any) => {
    setAssetActionBusy(asset.id);
    try {
      await fetch("/api/assets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: asset.id,
          actorUserId: currentUser?.id,
          actorName: currentUser?.name,
          actorRole: currentUser?.role,
          updates: {
            businessId: targetBiz.id,
            branchCode: targetBiz.code,
            branchName: targetBiz.name,
          },
        }),
      });
      onRefreshData();
      refreshAssetAuditLogs();
    } finally {
      setAssetActionBusy(null);
    }
  };

  const executiveAssetTransfer = (asset: any) => {
    const targetCode = window.prompt(
      `Transfer ${asset.assetCode} to branch code:`,
      asset.branchCode
    );
    if (!targetCode) return;
    const targetBiz = businesses.find((b) => b.code === targetCode.trim().toUpperCase());
    if (!targetBiz) {
      window.alert("Branch code not found.");
      return;
    }
    setConfirmAction({
      title: "Confirm Asset Transfer",
      message: `You're about to transfer ${asset.assetCode} — ${asset.name} to ${targetBiz.name} (${targetBiz.code}).`,
      details: [
        { label: "Asset", value: asset.name },
        { label: "From Branch", value: asset.branchCode || "—" },
        { label: "To Branch", value: `${targetBiz.name} (${targetBiz.code})` },
      ],
      tone: "purple",
      confirmLabel: "Confirm Transfer",
      run: () => performAssetTransfer(asset, targetBiz),
    });
  };

  const performAssetDelete = async (asset: any) => {
    setAssetActionBusy(asset.id);
    try {
      await fetch(
        `/api/assets?assetId=${asset.id}&actorUserId=${currentUser?.id || ""}&actorName=${encodeURIComponent(
          currentUser?.name || "Executive"
        )}&actorRole=${currentUser?.role || ""}`,
        { method: "DELETE" }
      );
      onRefreshData();
      refreshAssetAuditLogs();
    } finally {
      setAssetActionBusy(null);
    }
  };

  const executiveAssetDelete = (asset: any) => {
    setConfirmAction({
      title: "Confirm Asset Deletion",
      message: `You're about to permanently delete ${asset.assetCode} — ${asset.name}. This cannot be undone.`,
      details: [
        { label: "Asset", value: asset.name },
        { label: "Asset Code", value: asset.assetCode },
      ],
      tone: "rose",
      confirmLabel: "Delete Asset",
      run: () => performAssetDelete(asset),
    });
  };

  const getBusinessName = (bId: number | null) => {
    if (!bId) return "All Businesses (Shared)";
    const f = businesses.find((b) => b.id === bId);
    return f ? f.name : `Unit #${bId}`;
  };

  // Shared search + standardized-region filtering used by every module list
  const applyFilters = (rows: any[]) => {
    const q = searchTerm.trim().toLowerCase();
    return rows.filter((r) => {
      // Branch Managers only ever see records belonging to their own branch.
      if (lockedBusinessId != null && r.businessId !== lockedBusinessId) {
        return false;
      }
      const matchesRegion =
        regionFilter === "ALL" ||
        r.region === regionFilter ||
        // fall back to the parent branch region when the record has none
        (!r.region &&
          businesses.find((b) => b.id === r.businessId)?.region === regionFilter);
      if (!matchesRegion) return false;
      if (!q) return true;
      return [
        r.name,
        r.description,
        r.phone,
        r.email,
        r.sku,
        r.assetCode,
        r.branchCode,
        r.category,
        r.role,
        r.town,
        r.district,
        r.region,
        r.transactionNumber,
      ]
        .filter(Boolean)
        .some((f: any) => String(f).toLowerCase().includes(q));
    });
  };

  const visibleCustomers = applyFilters(customers);
  const visibleSuppliers = applyFilters(suppliers);
  const visibleEmployees = applyFilters(employees);
  const visibleAssets = applyFilters(assets);
  const visibleInventory = applyFilters(inventory);
  const visibleTransactions = applyFilters(transactions);

  // Per-branch asset value roll-up so executives can see how the visible
  // assets contribute to each branch's total value in the current view.
  const assetSummaryByBranch = visibleAssets.reduce(
    (acc: Record<string, { branch: string; count: number; value: number }>, a: any) => {
      const branchKey =
        a.branchCode ||
        businesses.find((b) => b.id === a.businessId)?.code ||
        "UNASSIGNED";
      if (!acc[branchKey]) acc[branchKey] = { branch: branchKey, count: 0, value: 0 };
      acc[branchKey].count += 1;
      acc[branchKey].value += a.currentValueGhs || 0;
      return acc;
    },
    {}
  );
  const totalVisibleAssetValue = visibleAssets.reduce(
    (acc, a: any) => acc + (a.currentValueGhs || 0),
    0
  );

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto text-slate-100">
      {/* Header banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-700/80 shadow-2xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start space-x-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center shadow-lg shrink-0">
            {config.icon}
          </div>
          <div>
            <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
              CENTRALIZED ENTERPRISE SYSTEM
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mt-1 text-white">
              {config.title}
            </h2>
            <p className="text-xs sm:text-sm text-slate-300 mt-1">
              {config.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {(moduleType === "INVENTORY" || moduleType === "ASSETS") && (
            <button
              onClick={() => { setQrScanTarget("lookup"); setQrError(""); setQrScanOpen(true); }}
              data-testid="shared-qr-lookup"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow transition"
              title="Scan a QR label with the camera to open the item or asset record"
            >
              <QrCode className="w-4 h-4" /> Scan QR
            </button>
          )}
          <AiSectionGuide moduleKey="SHARED" section={moduleType} variant="header" />
          {MANAGEABLE && isOwnerUser && (
            <button
              onClick={openAccessControl}
              data-testid="record-access-btn"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow transition"
              title="Grant or remove record management/deletion permission for managers"
            >
              <ShieldCheck className="w-4 h-4" />
              Manage Access
            </button>
          )}
          {/* Download buttons — shared across ASSETS and INVENTORY modules, execs only */}
          {moduleType === "ASSETS" && (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDownloadFilters(!showDownloadFilters)}
                className={`flex items-center space-x-1.5 px-3 py-2.5 rounded-xl font-bold text-xs shadow-lg transition ${
                  showDownloadFilters
                    ? "bg-amber-600 hover:bg-amber-500 text-white"
                    : "bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                }`}
                title="Filter assets before downloading"
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">Filters</span>
              </button>
              <button
                onClick={() => handleAssetDownload("EXCEL")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered assets as Excel"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span className="hidden sm:inline">Excel</span>
              </button>
              <button
                onClick={() => handleAssetDownload("PDF")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered assets as PDF (with QR code)"
              >
                <FileText className="w-4 h-4" />
                <span className="hidden sm:inline">PDF</span>
              </button>
              <button
                onClick={() => handleAssetDownload("CSV")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-slate-600 hover:bg-slate-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered assets as CSV"
              >
                <FileIcon className="w-4 h-4" />
                <span className="hidden sm:inline">CSV</span>
              </button>
            </div>
          )}

          {/* Inventory download — execs only */}
          {moduleType === "INVENTORY" && (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDownloadFilters(!showDownloadFilters)}
                className={`flex items-center space-x-1.5 px-3 py-2.5 rounded-xl font-bold text-xs shadow-lg transition ${
                  showDownloadFilters
                    ? "bg-amber-600 hover:bg-amber-500 text-white"
                    : "bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600"
                }`}
                title="Filter inventory before downloading"
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span className="hidden sm:inline">Filters</span>
              </button>
              <button
                onClick={() => handleInventoryDownload("EXCEL")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered inventory as Excel"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span className="hidden sm:inline">Excel</span>
              </button>
              <button
                onClick={() => handleInventoryDownload("PDF")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered inventory as PDF (with QR code)"
              >
                <FileText className="w-4 h-4" />
                <span className="hidden sm:inline">PDF</span>
              </button>
              <button
                onClick={() => handleInventoryDownload("CSV")}
                disabled={downloading !== null}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-slate-600 hover:bg-slate-500 text-white font-bold text-xs shadow-lg transition disabled:opacity-50"
                title="Download filtered inventory as CSV"
              >
                <FileIcon className="w-4 h-4" />
                <span className="hidden sm:inline">CSV</span>
              </button>
            </div>
          )}
          {moduleType === "EMPLOYEES" && (
            <button
              onClick={() => setShowPayroll(true)}
              className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
              data-testid="emp-payroll-open"
            >
              <Landmark className="w-4 h-4" />
              <span>Payroll Center</span>
            </button>
          )}
          <button
            onClick={() => {
              // Assets use a dedicated modal that enforces Business + Branch linkage
              if (moduleType === "ASSETS") {
                setShowAssetModal(true);
              } else if (moduleType === "EMPLOYEES") {
                // Employees open the full Employee Registration (complete HR record)
                setEmpEdit(null);
                setShowEmpReg(true);
              } else {
                resetSharedForm();
                ensureInvBranch();
                setShowModal(true);
              }
            }}
            className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm shadow-lg transition"
            data-testid={moduleType === "EMPLOYEES" ? "employee-reg-open" : moduleType === "ASSETS" ? "asset-reg-open" : "shared-add-open"}
          >
            <Plus className="w-4 h-4" />
            <span>{config.buttonLabel}</span>
          </button>
        </div>
      </div>

      {/* Save-confirmation flash — the form closed itself after a completed
          save; this is the unmistakable receipt on the register page. */}
      {formFlash && (
        <div
          className="px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-2"
          data-testid="sem-form-flash"
          role="status"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {formFlash}
        </div>
      )}

      {/* ── Asset & Inventory Download Filter Panel ── */}
      {(moduleType === "ASSETS" || moduleType === "INVENTORY") && showDownloadFilters && (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") && (
        <div className="bg-gradient-to-r from-amber-900/20 via-amber-900/10 to-amber-900/20 border border-amber-500/30 rounded-2xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-amber-400" />
              <h3 className="text-base font-bold text-amber-200">
                Download Filters — Select what to export
              </h3>
            </div>
            <button
              onClick={() => setShowDownloadFilters(false)}
              className="p-1 rounded-lg hover:bg-amber-500/20 text-amber-300"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

            <p className="text-xs text-amber-100/70">
              Apply filters below to download only matching {moduleType === "ASSETS" ? "assets" : "inventory items"}. The PDF will include the applied filters in the header, alongside the unique Download ID, QR code, and your details.
            </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {/* Business filter */}
            <div>
              <label className="block text-[11px] font-semibold text-amber-200/80 mb-1">Business</label>
              <select
                value={dlFilterBusinessId}
                onChange={(e) => {
                  setDlFilterBusinessId(e.target.value);
                  setDlFilterBranchCode("ALL");
                }}
                className="w-full px-3 py-2 bg-slate-900 border border-amber-500/30 rounded-lg text-white text-xs focus:outline-none focus:border-amber-400"
              >
                <option value="ALL">All Businesses</option>
                {businesses.map((b: any) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>

            {/* Branch filter */}
            <div>
              <label className="block text-[11px] font-semibold text-amber-200/80 mb-1">Branch</label>
              <select
                value={dlFilterBranchCode}
                onChange={(e) => setDlFilterBranchCode(e.target.value)}
                disabled={dlFilterBusinessId === "ALL"}
                className="w-full px-3 py-2 bg-slate-900 border border-amber-500/30 rounded-lg text-white text-xs focus:outline-none focus:border-amber-400 disabled:opacity-40"
              >
                <option value="ALL">All Branches</option>
                {businesses
                  .filter(
                    (b: any) =>
                      dlFilterBusinessId === "ALL" ||
                      String(b.id) === dlFilterBusinessId
                  )
                  .map((b: any) => (
                    <option key={b.code} value={b.code}>{b.code} — {b.name}</option>
                  ))}
              </select>
            </div>

            {/* Region filter */}
            <div>
              <label className="block text-[11px] font-semibold text-amber-200/80 mb-1">Region</label>
              <select
                value={dlFilterRegion}
                onChange={(e) => setDlFilterRegion(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-amber-500/30 rounded-lg text-white text-xs focus:outline-none focus:border-amber-400"
              >
                <option value="ALL">All Regions</option>
                {REGION_NAMES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* District / Town filter */}
            <div>
              <label className="block text-[11px] font-semibold text-amber-200/80 mb-1">District / Town</label>
              <input
                type="text"
                value={dlFilterDistrict}
                onChange={(e) => setDlFilterDistrict(e.target.value)}
                placeholder="e.g. Tema, Osu, Nsawam…"
                className="w-full px-3 py-2 bg-slate-900 border border-amber-500/30 rounded-lg text-white text-xs placeholder-slate-500 focus:outline-none focus:border-amber-400"
              />
            </div>

            {/* Asset Type filter */}
            <div>
              <label className="block text-[11px] font-semibold text-amber-200/80 mb-1">Asset Type</label>
              <select
                value={dlFilterAssetType}
                onChange={(e) => setDlFilterAssetType(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-amber-500/30 rounded-lg text-white text-xs focus:outline-none focus:border-amber-400"
              >
                <option value="ALL">All Types</option>
                {assetTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-amber-500/20">
            <div className="text-xs text-amber-100/70">
              {moduleType === "ASSETS" ? (
                <>
                  <span className="font-bold text-amber-300">{getFilteredDownloadAssets().length}</span>
                  {" of "}{assets.length}{" assets match current filters"}
                </>
              ) : (
                <>
                  <span className="font-bold text-amber-300">{getFilteredDownloadInventory().length}</span>
                  {" of "}{inventory.length}{" inventory items match current filters"}
                </>
              )}
            </div>
            <button
              onClick={resetDownloadFilters}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-semibold border border-amber-500/30 transition"
            >
              Clear All Filters
            </button>
          </div>
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="flex items-center justify-between gap-4 bg-slate-800/90 border border-slate-700/80 p-3.5 rounded-xl">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search records by name, description, or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs sm:text-sm text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium whitespace-nowrap">
              Region:
            </span>
            <select
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value)}
              className="px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="ALL">All 16 Regions</option>
              {REGION_NAMES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs text-slate-400 hidden lg:block">
            Currency: <strong className="text-emerald-400">{currentCurrency}</strong>
          </div>
        </div>
      </div>

      {/* Asset approvals — Owner / General Manager can approve or reject Branch Manager requests */}
      {moduleType === "ASSETS" && isExecutiveUser && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">
                Asset Change Approval Queue
              </div>
              <div className="text-xs text-slate-400">
                Branch Manager edit, transfer, and deletion requests requiring executive approval.
              </div>
            </div>
            <button
              onClick={refreshAssetAuditLogs}
              className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-200"
            >
              Refresh
            </button>
          </div>
          <div className="space-y-2">
            {assetAuditLogs.filter((l) => l.status === "PENDING").map((log) => (
              <div
                key={log.id}
                className="p-3 rounded-xl bg-slate-900/70 border border-amber-500/20 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold border border-amber-500/30">
                      {log.action}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {log.assetCode}
                    </span>
                  </div>
                  <div className="text-xs text-slate-300 mt-1">
                    Requested by {log.requestedByName} ({log.requestedByRole})
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {log.detailsJson?.reason || "No reason provided"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => decideAssetApproval(log.id, "REJECTED")}
                    disabled={assetActionBusy === log.id}
                    className="px-3 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-white text-xs font-bold"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => decideAssetApproval(log.id, "APPROVED")}
                    disabled={assetActionBusy === log.id}
                    className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))}
            {assetAuditLogs.filter((l) => l.status === "PENDING").length === 0 && (
              <div className="text-xs text-slate-400 text-center py-2">
                No pending asset approvals.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Complete audit log — visible to Asset register users */}
      {moduleType === "ASSETS" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-cyan-300">
                Asset Audit Log
              </div>
              <div className="text-xs text-slate-400">
                Complete record of asset creation, edit/transfer/delete actions, requests and approvals.
              </div>
            </div>
            <span className="text-[11px] text-slate-400">
              {assetAuditLogs.length} log entries
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
            {assetAuditLogs.slice(0, 10).map((log) => (
              <div
                key={log.id}
                className="bg-slate-900/70 border border-slate-700 rounded-lg p-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-purple-300">{log.assetCode}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      log.status === "APPROVED" || log.status === "COMPLETED"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : log.status === "REJECTED"
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-amber-500/20 text-amber-300"
                    }`}
                  >
                    {log.status}
                  </span>
                </div>
                <div className="font-bold text-slate-200 mt-1">{log.action}</div>
                <div className="text-[11px] text-slate-400">
                  By {log.requestedByName || "System"} • {log.createdAt ? new Date(log.createdAt).toLocaleString() : "—"}
                </div>
                {log.approvedByName && (
                  <div className="text-[10px] text-cyan-300 mt-0.5">
                    Decision by {log.approvedByName}
                  </div>
                )}
              </div>
            ))}
            {assetAuditLogs.length === 0 && (
              <div className="col-span-full text-xs text-slate-400 text-center py-2">
                No audit log entries yet.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Asset Download History with QR Codes */}
      {moduleType === "ASSETS" && (currentUser?.role === "OWNER" || currentUser?.role === "GENERAL_MANAGER") && assetDownloadHistory.length > 0 && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-300">
                Asset Download History
              </div>
              <div className="text-xs text-slate-400">
                All asset register downloads with unique IDs and QR codes for audit trail.
              </div>
            </div>
            <span className="text-[11px] text-slate-400">
              {assetDownloadHistory.length} downloads
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-96 overflow-y-auto pr-1">
            {assetDownloadHistory.slice(0, 12).map((download) => (
              <div
                key={download.id}
                className="bg-slate-900/70 border border-slate-700 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[11px] text-indigo-300 truncate">
                      {download.downloadId}
                    </div>
                    <div className="font-bold text-slate-200 text-xs mt-0.5">
                      {download.format} Export
                    </div>
                  </div>
                  <div className="shrink-0">
                    {download.qrCodeData && (
                      <img
                        src={download.qrCodeData}
                        alt="QR Code"
                        className="w-16 h-16 border border-slate-600 rounded"
                      />
                    )}
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 space-y-0.5">
                  <div>By: <span className="text-slate-300">{download.downloaderName}</span></div>
                  <div>Role: <span className="text-slate-300">{download.downloaderRole}</span></div>
                  {download.downloaderBranchName && (
                    <div>Branch: <span className="text-slate-300">{download.downloaderBranchName}</span></div>
                  )}
                  <div>Records: <span className="text-slate-300">{download.recordCount}</span></div>
                  <div className="text-[9px]">
                    {download.createdAt ? new Date(download.createdAt).toLocaleString() : "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Asset-value roll-up strip — only shown on the ASSETS module */}
      {moduleType === "ASSETS" && (
        <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 shadow-lg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-purple-300">
                Asset Value Breakdown by Branch
              </div>
              <div className="text-xs text-slate-400">
                Auto-summed from registered assets — flows into business and branch dashboards.
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-400">Total Visible Asset Value</div>
              <div className="text-lg font-black text-emerald-400">
                {formatMoney(totalVisibleAssetValue, currentCurrency, true)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Object.values(assetSummaryByBranch).map((s: any) => {
              const parentBiz = businesses.find((b) => b.code === s.branch);
              return (
                <div
                  key={s.branch}
                  className="bg-slate-900/70 border border-slate-700 rounded-lg p-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 text-[10px] font-mono font-bold border border-purple-500/30">
                      {s.branch}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {s.count} {s.count === 1 ? "asset" : "assets"}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-extrabold text-emerald-400">
                    {formatMoney(s.value, currentCurrency, true)}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {parentBiz?.name || "Unassigned"}
                  </div>
                </div>
              );
            })}
            {Object.keys(assetSummaryByBranch).length === 0 && (
              <div className="col-span-full text-xs text-slate-400 text-center py-2">
                No assets match the current filters.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Table view for each module */}
      <div className="bg-slate-800/90 border border-slate-700/80 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          {moduleType === "CUSTOMERS" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Customer Name</th>
                  <th className="px-4 py-3">Client Type</th>
                  <th className="px-4 py-3">Phone & Email</th>
                  <th className="px-4 py-3">Location (Region · District · Town)</th>
                  <th className="px-4 py-3 text-right">Total Spent</th>
                  <th className="px-4 py-3 text-right">Loyalty Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleCustomers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-700/50">
                    <td className="px-4 py-3.5 font-bold text-slate-100">
                      {c.name}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">
                        {c.type}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      <div>{c.phone}</div>
                      <div className="text-[11px] text-slate-400">{c.email}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <LocationBadge
                        region={c.region}
                        district={c.district}
                        town={c.town}
                      />
                    </td>
                    <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                      {formatMoney(c.totalSpentGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold text-amber-300">
                      {c.loyaltyPoints} pts
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {moduleType === "SUPPLIERS" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Supplier Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Contact Person</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Payment Terms</th>
                  <th className="px-4 py-3 text-right">Total Supplied</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleSuppliers.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-700/50">
                    <td className="px-4 py-3.5 font-bold text-slate-100">
                      {s.name}
                    </td>
                    <td className="px-4 py-3.5 text-amber-300 font-medium">
                      {s.category}
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      <div>{s.contactPerson}</div>
                      <div className="text-[11px] text-slate-400">{s.phone}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <LocationBadge
                        region={s.region}
                        district={s.district}
                        town={s.town}
                      />
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[11px] font-mono">
                        {s.paymentTerms}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                      {formatMoney(s.totalSuppliedGhs, currentCurrency)}
                    </td>
                    <RecordActions r={s} prefix="supplier" />
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {moduleType === "EMPLOYEES" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Employee Name</th>
                  <th className="px-4 py-3">Role / Position</th>
                  <th className="px-4 py-3">Assigned Business</th>
                  <th className="px-4 py-3">Location (Region · District · Town)</th>
                    <th className="px-4 py-3 text-right">Monthly Salary</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-center">Actions</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleEmployees.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-700/50" data-testid={`employee-row-${emp.id}`}>
                    <td className="px-4 py-3.5 font-bold text-slate-100">
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 overflow-hidden flex items-center justify-center shrink-0" data-testid={`employee-photo-${emp.id}`}>
                          {emp.photo ? <img src={emp.photo} alt={emp.name} className="w-full h-full object-cover" /> : <UserCheck className="w-4 h-4 text-slate-600" />}
                        </span>
                        <span>
                          <div>{emp.name}</div>
                          <div className="text-[11px] text-slate-400 font-normal">
                            <span className="font-mono text-teal-300/90">{emp.employeeNo || "—"}</span> · {emp.phone}
                          </div>
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 font-semibold text-emerald-300">
                      {emp.role}
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">
                      {getBusinessName(emp.businessId)}
                    </td>
                    <td className="px-4 py-3.5">
                      <LocationBadge
                        region={emp.region}
                        district={emp.district}
                        town={emp.town}
                      />
                    </td>
                    <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                      {formatMoney(emp.salaryGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                        {emp.status}
                      </span>
                    </td>
                    <RecordActions r={emp} prefix="employee" onProfile={(e) => setEmpProfile(e)} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {moduleType === "ASSETS" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Asset Code</th>
                  <th className="px-4 py-3">Asset Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Business</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3 text-right">Purchase Value</th>
                  <th className="px-4 py-3 text-right">Current Value</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Recorder / Timestamp</th>
                  <th className="px-4 py-3 text-center">Images</th>
                  <th className="px-4 py-3 text-center">Condition</th>
                  <th className="px-4 py-3">Next Maintenance</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleAssets.map((ast) => {
                  const parentBiz = businesses.find(
                    (b) => b.id === ast.businessId
                  );
                  return (
                    <tr
                      key={ast.id}
                      className="hover:bg-slate-700/50 cursor-pointer"
                      data-testid={`asset-row-${ast.id}`}
                      title="Open record & QR label"
                      onClick={(e) => {
                        // Action buttons inside the row keep their own behaviour.
                        if ((e.target as HTMLElement).closest("button")) return;
                        setQrRecord({ kind: "asset", record: ast });
                      }}
                    >
                      <td className="px-4 py-3.5">
                        <span className="px-2 py-1 rounded bg-slate-900 border border-purple-500/40 text-purple-300 text-[11px] font-mono font-bold">
                          {ast.assetCode || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-bold text-slate-100">
                        <div>{ast.name}</div>
                        {ast.description && (
                          <div className="text-[11px] text-slate-400 truncate max-w-[260px]" title={ast.description}>
                            {ast.description}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-purple-300">
                        {ast.assetType}
                      </td>
                      <td className="px-4 py-3.5 text-slate-300">
                        {getBusinessName(ast.businessId)}
                        <div className="text-[10px] text-slate-500 font-mono">
                          {parentBiz?.category}
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px] font-mono font-bold border border-purple-500/30">
                          {ast.branchCode || parentBiz?.code || "—"}
                        </span>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {ast.branchName || parentBiz?.name}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right text-slate-400">
                        {formatMoney(
                          ast.purchasePriceGhs,
                          currentCurrency,
                          true
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                        {formatMoney(
                          ast.currentValueGhs,
                          currentCurrency,
                          true
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <LocationBadge
                          region={ast.region}
                          district={ast.district}
                          town={ast.town}
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="text-xs font-semibold text-slate-200">
                          {ast.recorderName || "—"}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {ast.recordedAt
                            ? new Date(ast.recordedAt).toLocaleString()
                            : "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-slate-300 font-bold">
                          {Array.isArray(ast.assetImages) ? ast.assetImages.length : 0}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            ast.condition === "EXCELLENT"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : ast.condition === "GOOD"
                              ? "bg-teal-500/20 text-teal-300"
                              : ast.condition === "NEEDS_MAINTENANCE"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-rose-500/20 text-rose-300"
                          }`}
                        >
                          {ast.condition}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-slate-300 font-mono text-xs">
                        {ast.nextMaintenanceDate}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex justify-end gap-1.5">
                          {isExecutiveUser || bizOwnerLike(ast.businessId) ? (
                            <>
                              <button
                                onClick={() => executiveAssetEdit(ast)}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500 hover:text-white text-[10px] font-bold"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => executiveAssetTransfer(ast)}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-amber-500/15 text-amber-300 hover:bg-amber-500 hover:text-slate-950 text-[10px] font-bold"
                              >
                                Transfer
                              </button>
                              <button
                                onClick={() => executiveAssetDelete(ast)}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-rose-500/15 text-rose-300 hover:bg-rose-500 hover:text-white text-[10px] font-bold"
                              >
                                Delete
                              </button>
                            </>
                          ) : isBranchManagerUser ? (
                            <>
                              <button
                                onClick={() => requestAssetApproval(ast, "EDIT")}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500 hover:text-white text-[10px] font-bold"
                              >
                                Request Edit
                              </button>
                              <button
                                onClick={() => requestAssetApproval(ast, "TRANSFER")}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-amber-500/15 text-amber-300 hover:bg-amber-500 hover:text-slate-950 text-[10px] font-bold"
                              >
                                Request Transfer
                              </button>
                              <button
                                onClick={() => requestAssetApproval(ast, "DELETE")}
                                disabled={assetActionBusy === ast.id}
                                className="px-2 py-1 rounded bg-rose-500/15 text-rose-300 hover:bg-rose-500 hover:text-white text-[10px] font-bold"
                              >
                                Request Delete
                              </button>
                            </>
                          ) : (
                            <span className="text-[10px] text-slate-500">No actions</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleAssets.length === 0 && (
                  <tr>
                    <td
                      colSpan={13}
                      className="px-4 py-10 text-center text-slate-400 text-sm"
                    >
                      No assets registered yet. Click{" "}
                      <strong className="text-purple-300">Register Asset</strong>{" "}
                      to link machinery, vehicles or equipment to a business
                      and branch.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {moduleType === "INVENTORY" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-3 py-3 text-center">Photo</th>
                  <th className="px-4 py-3">Item Code & Item Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Business & Branch</th>
                  <th className="px-4 py-3 text-right">Qty & Unit</th>
                  <th className="px-4 py-3 text-right">Cost Price</th>
                  <th className="px-4 py-3 text-right">Selling Price</th>
                  <th className="px-4 py-3 text-center">Stock Status</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleInventory.map((inv) => (
                  <tr
                    key={inv.id}
                    className="hover:bg-slate-700/50 cursor-pointer"
                    data-testid={`inv-row-${inv.id}`}
                    title="Open record & QR label"
                    onClick={() => setQrRecord({ kind: "inventory", record: inv })}
                  >
                    <td className="px-3 py-2.5 text-center">
                      {inv.photo ? (
                        <img
                          src={inv.photo}
                          alt={inv.name}
                          title={Array.isArray(inv.photos) && inv.photos.length > 1 ? `${inv.photos.length} photos` : inv.name}
                          data-testid={`inv-photo-${inv.id}`}
                          className="w-10 h-10 object-cover rounded-lg border border-slate-600 mx-auto"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg border border-slate-700 bg-slate-800 flex items-center justify-center mx-auto">
                          <Package className="w-4 h-4 text-slate-600" />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 font-bold text-slate-100">
                      <div>{inv.name}</div>
                      <div className="text-[11px] font-mono text-emerald-400">
                        {inv.sku}
                      </div>
                      {inv.qrCode && (
                        <div className="text-[9px] font-mono text-cyan-500/80 flex items-center gap-1 mt-0.5">
                          <QrCode className="w-2.5 h-2.5" /> QR
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">{inv.category}</td>
                    <td className="px-4 py-3.5 text-slate-300">
                      <div>{inv.branchName || getBusinessName(inv.businessId)}</div>
                      <div className="text-[10px] font-mono text-cyan-400">
                        {inv.branchCode || businesses.find((b: any) => b.id === inv.businessId)?.code || "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-bold text-white">
                      {inv.quantity?.toLocaleString()} {inv.unit}
                    </td>
                    <td className="px-4 py-3.5 text-right text-slate-400">
                      {formatMoney(inv.costPriceGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-extrabold text-emerald-400">
                      {formatMoney(inv.sellingPriceGhs, currentCurrency)}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          inv.status === "IN_STOCK"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-amber-500/20 text-amber-400"
                        }`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-center" onClick={(e) => e.stopPropagation()}>
                      {canDeleteInv || bizOwnerLike(inv.businessId) ? (
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            title="Edit item"
                            data-testid={`inv-edit-${inv.id}`}
                            onClick={() => { setEditingRecord({ ...inv }); setRecordErr(""); }}
                            className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-indigo-500/30 text-slate-200 hover:text-indigo-300 transition"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Delete item (reason is recorded)"
                            data-testid={`inv-delete-${inv.id}`}
                            onClick={() => { setDeletingRecord(inv); setDeleteReason(""); setRecordErr(""); }}
                            className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 transition"
                          >
                            <Trash className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span
                          title="Only the OWNER, or a manager granted the delete-inventory permission by the OWNER, can edit or delete stock items"
                          className="inline-flex items-center gap-1 text-[9px] font-bold text-slate-500 bg-slate-800 border border-slate-700 px-2 py-1 rounded"
                        >
                          <Lock className="w-3 h-3" /> LOCKED
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {moduleType === "TRANSACTIONS" && (
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold text-[11px] tracking-wider border-b border-slate-700">
                <tr>
                  <th className="px-4 py-3">Trx # / Date & Time</th>
                  <th className="px-4 py-3">Business / Branch</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Created By</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {visibleTransactions.map((t) => {
                  const trxBiz = businesses.find(
                    (b: any) => b.id === t.businessId
                  );
                  return (
                    <tr key={t.id} className="hover:bg-slate-700/50">
                      <td className="px-4 py-3.5">
                        <div className="font-mono text-emerald-400 font-bold">
                          {t.transactionNumber}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {t.createdAt
                            ? new Date(t.createdAt).toLocaleString()
                            : t.date}
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="text-xs font-bold text-slate-200">
                          {t.branchName || trxBiz?.name || getBusinessName(t.businessId)}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {t.branchCode || trxBiz?.code || "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-semibold text-slate-200">
                        {t.category}
                      </td>
                      <td className="px-4 py-3.5 text-slate-300 max-w-[200px] truncate">
                        {t.description}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="text-xs font-semibold text-slate-200">
                          {t.recordedBy || "—"}
                        </div>
                        {t.recordedByRole && (
                          <span className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold ${
                            t.recordedByRole === "OWNER"
                              ? "bg-purple-500/20 text-purple-300"
                              : t.recordedByRole === "GENERAL_MANAGER"
                              ? "bg-blue-500/20 text-blue-300"
                              : t.recordedByRole === "BRANCH_MANAGER"
                              ? "bg-cyan-500/20 text-cyan-300"
                              : "bg-emerald-500/20 text-emerald-300"
                          }`}>
                            {t.recordedByRole}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 text-[11px] font-bold">
                          {t.paymentMethod}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-3.5 text-right font-extrabold ${
                          t.type === "INCOME"
                            ? "text-emerald-400"
                            : "text-rose-400"
                        }`}
                      >
                        {t.type === "INCOME" ? "+" : "-"}{" "}
                        {formatMoney(t.amountGhs, currentCurrency)}
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          t.status === "COMPLETED"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-amber-500/20 text-amber-300"
                        }`}>
                          {t.status}
                        </span>
                      </td>
                      <RecordActions r={t} prefix="trx" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Deletion audit trail — every deleted record, with user, date, time & reason */}
      {MANAGEABLE && (
        <div
          data-testid="deletion-log"
          className="bg-slate-800/90 border border-slate-700/80 rounded-2xl p-5 shadow-xl"
        >
          <h3 className="text-base font-bold text-white flex items-center gap-2 mb-1">
            <Trash className="w-4 h-4 text-rose-400" />
            Deletion Audit Trail
          </h3>
          <p className="text-[11px] text-slate-400 mb-3">
            Every record removed from this module — permanently logged with the user, date, time and reason.
          </p>
          {deletionLogs.length === 0 ? (
            <p className="text-xs text-slate-500 py-3 text-center" data-testid="deletion-log-empty">
              No records have been deleted from this module.
            </p>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {deletionLogs.map((l) => (
                <div
                  key={l.id}
                  data-testid={`deletion-log-row-${l.id}`}
                  className="rounded-xl bg-slate-900/70 border border-rose-500/20 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-rose-300 truncate">{l.recordLabel}</div>
                      <div className="text-[11px] text-slate-300 mt-0.5">
                        Reason: <span className="text-slate-100">{l.reason}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[11px] font-semibold text-slate-200">
                        {l.deletedByName}{" "}
                        <span className="text-[9px] font-black text-slate-400 bg-slate-700/70 px-1.5 py-0.5 rounded">
                          {l.deletedByRole}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                        {l.createdAt ? new Date(l.createdAt).toLocaleString() : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modal for adding records — capped to the viewport and scrollable so
          long forms (Inventory registration) can be scrolled smoothly and
          submitted on phones instead of running off-screen. */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/75 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 sm:p-6 w-full max-w-md shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto overscroll-contain">
            <h3 className="text-lg font-bold text-white">
              {config.buttonLabel}
            </h3>

            <form onSubmit={handleAddItem} className="space-y-3 gm-form">
              {moduleType === "TRANSACTIONS" ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Target Business
                    </label>
                    <select
                      value={businessId}
                      onChange={(e) => setBusinessId(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      {businesses.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.branchLocation})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Type
                      </label>
                      <select
                        value={trxType}
                        onChange={(e) => setTrxType(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="INCOME">Income / Revenue</option>
                        <option value="EXPENSE">Expense</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Amount (GH₵)
                      </label>
                      <input
                        type="number"
                        value={amountGhs}
                        onChange={(e) => setAmountGhs(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Payment Method
                    </label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      <option value="MTN_MOMO">MTN Mobile Money (MoMo)</option>
                      <option value="TELECEL_CASH">Telecel Cash</option>
                      <option value="BANK_TRANSFER">Ecobank / GCB Bank Transfer</option>
                      <option value="POS_CARD">POS Hardware Checkout</option>
                      <option value="CASH">Cash Payment</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Description / Memo
                    </label>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>

                  {/* Auto-filled creator info (read-only) */}
                  <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 space-y-1">
                    <div className="text-[10px] font-bold uppercase text-slate-500 tracking-wider">Transaction Creator</div>
                    <div className="text-xs text-slate-200 font-semibold">
                      {currentUser?.name || "Unknown"}{" "}
                      <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        currentUser?.role === "OWNER"
                          ? "bg-purple-500/20 text-purple-300"
                          : currentUser?.role === "GENERAL_MANAGER"
                          ? "bg-blue-500/20 text-blue-300"
                          : "bg-cyan-500/20 text-cyan-300"
                      }`}>
                        {currentUser?.role || "Staff"}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      Branch: {businesses.find((b: any) => String(b.id) === businessId)?.name || "—"} ({businesses.find((b: any) => String(b.id) === businessId)?.code || "—"})
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Date & Time: {new Date().toLocaleString()}
                    </div>
                  </div>
                </>
              ) : moduleType === "INVENTORY" ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Item Name
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. 50kg Cement Bag, Maize Feed 25kg..."
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      data-testid="inv-name"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>

                  {/* Business + Branch/Register selection (required) */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Business
                      </label>
                      <select
                        value={businessId}
                        onChange={(e) => handleInvBusinessChange(e.target.value)}
                        data-testid="inv-business-select"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        {businesses.map((b: any) => (
                          <option key={b.id} value={b.id}>
                            {b.name} ({b.code})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">
                        Branch / Register
                      </label>
                      <input
                        type="text"
                        required
                        value={invBranch}
                        onChange={(e) => setInvBranch(e.target.value)}
                        list="inv-branch-list"
                        placeholder="e.g. WASH-01"
                        data-testid="inv-branch-input"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                      <datalist id="inv-branch-list">
                        {invBranchOptions.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                    </div>
                  </div>

                  {/* QR identity — scan with the camera; auto-generated on save if none */}
                  <div className="bg-slate-800/50 border border-slate-700/60 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-400">QR Identity Tag</label>
                      <button
                        type="button"
                        onClick={() => { setQrScanTarget("inventory-form"); setQrError(""); setQrScanOpen(true); }}
                        data-testid="inv-qr-scan-open"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold hover:bg-cyan-600/40 transition"
                      >
                        <QrCode className="w-3.5 h-3.5" /> Scan QR
                      </button>
                    </div>
                    {invQr ? (
                      <div className="flex items-center justify-between gap-2" data-testid="inv-qr-chip">
                        <span className="font-mono text-[10px] text-cyan-200 break-all">{invQr}</span>
                        <button type="button" onClick={() => setInvQr("")} className="text-slate-500 hover:text-rose-400 text-xs font-bold px-1" title="Remove attached QR">✕</button>
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-500" data-testid="inv-qr-auto">
                        No scan attached — a unique label QR is generated automatically when you save.
                      </p>
                    )}
                    {qrError && <p className="text-[10px] text-rose-400 font-semibold" data-testid="inv-qr-error">{qrError}</p>}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Category / Type
                    </label>
                    <input
                      type="text"
                      value={typeOrCategory}
                      onChange={(e) => setTypeOrCategory(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Quantity</label>
                      <input
                        type="number"
                        min={0}
                        value={invQty}
                        onChange={(e) => setInvQty(Number(e.target.value))}
                        data-testid="inv-qty"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Unit</label>
                      <select
                        value={invUnit}
                        onChange={(e) => setInvUnit(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        {["Units", "Bags", "Trays", "Kg", "Litres", "Tons", "Boxes", "Pieces", "Vehicles"].map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Min Stock Alert</label>
                      <input
                        type="number"
                        min={0}
                        value={invMin}
                        onChange={(e) => setInvMin(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Cost Price (GH₵)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={invCost}
                        onChange={(e) => setInvCost(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Selling Price (GH₵)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={invPrice}
                        onChange={(e) => setInvPrice(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      />
                    </div>
                  </div>

                  {/* Item photos — upload or camera */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-slate-400">Item Photos (optional)</label>
                      <span className="text-[10px] text-slate-500" data-testid="inv-photo-count">
                        {invPhotos.length} attached
                      </span>
                    </div>
                    {invPhotos.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2" data-testid="inv-photo-previews">
                        {invPhotos.map((img, idx) => (
                          <div key={idx} className="relative group w-16 h-16">
                            <img src={img} alt={`Item ${idx + 1}`} className="w-full h-full object-cover rounded-lg border border-slate-700" />
                            <button
                              type="button"
                              onClick={() => removeInvPhoto(idx)}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-600 text-white rounded-full text-xs flex items-center justify-center opacity-80 hover:opacity-100"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <label
                        data-testid="inv-photo-upload"
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition"
                      >
                        <Package className="w-4 h-4" />
                        Upload Photo
                        <input type="file" accept="image/*" multiple onChange={handleInvPhotoUpload} className="hidden" />
                      </label>
                      <label
                        data-testid="inv-photo-camera"
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-800 border border-slate-700 border-dashed rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 cursor-pointer transition"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
                        Take Photo
                        <input type="file" accept="image/*" capture="environment" onChange={handleInvPhotoUpload} className="hidden" />
                      </label>
                    </div>
                    {invPhotoErr && <p className="text-[10px] text-rose-400 mt-1">{invPhotoErr}</p>}
                  </div>

                  <div className="pt-2 border-t border-slate-800">
                    <LocationSelector
                      value={location}
                      onChange={setLocation}
                      compact
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Name / Title
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Shoprite Ghana, John Deere Tractor..."
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Category / Type
                    </label>
                    <input
                      type="text"
                      value={typeOrCategory}
                      onChange={(e) => setTypeOrCategory(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    />
                  </div>

                  <div className="pt-2 border-t border-slate-800">
                    <LocationSelector
                      value={location}
                      onChange={setLocation}
                      compact
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="shared-add-submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {isSubmitting ? "Saving..." : "Save Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Record edit modal (OWNER or OWNER-granted manager) ─── */}
      {editingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">
              Edit {moduleType === "TRANSACTIONS" ? "Transaction" : moduleType === "SUPPLIERS" ? "Supplier" : moduleType === "INVENTORY" ? "Stock Item" : "Employee"} —{" "}
              <span className="text-indigo-300">{recordLabel(editingRecord)}</span>
            </h3>
            <form onSubmit={submitRecordEdit} className="space-y-3" data-testid="record-edit-form">
              {recordErr && (
                <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">{recordErr}</div>
              )}
              {moduleType === "TRANSACTIONS" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Type</label>
                      <select
                        value={editingRecord.type}
                        onChange={(e) => setEditingRecord({ ...editingRecord, type: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="INCOME">Income / Revenue</option>
                        <option value="EXPENSE">Expense</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Amount (GH₵)</label>
                      <input type="number" step="0.01" value={editingRecord.amountGhs}
                        onChange={(e) => setEditingRecord({ ...editingRecord, amountGhs: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Category</label>
                    <input type="text" value={editingRecord.category || ""}
                      onChange={(e) => setEditingRecord({ ...editingRecord, category: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Payment Method</label>
                    <select
                      value={editingRecord.paymentMethod}
                      onChange={(e) => setEditingRecord({ ...editingRecord, paymentMethod: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      <option value="MTN_MOMO">MTN Mobile Money (MoMo)</option>
                      <option value="TELECEL_CASH">Telecel Cash</option>
                      <option value="BANK_TRANSFER">Ecobank / GCB Bank Transfer</option>
                      <option value="POS_CARD">POS Hardware Checkout</option>
                      <option value="CASH">Cash Payment</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Description / Memo</label>
                    <input type="text" data-testid="edit-trx-description" value={editingRecord.description || ""}
                      onChange={(e) => setEditingRecord({ ...editingRecord, description: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                  </div>
                </>
              ) : moduleType === "SUPPLIERS" ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Supplier Name</label>
                    <input type="text" data-testid="edit-supplier-name" value={editingRecord.name || ""}
                      onChange={(e) => setEditingRecord({ ...editingRecord, name: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Category</label>
                      <input type="text" value={editingRecord.category || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, category: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Contact Person</label>
                      <input type="text" value={editingRecord.contactPerson || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, contactPerson: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Phone</label>
                      <input type="text" value={editingRecord.phone || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, phone: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Email</label>
                      <input type="text" value={editingRecord.email || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, email: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Payment Terms</label>
                    <select
                      value={editingRecord.paymentTerms || "NET_30"}
                      onChange={(e) => setEditingRecord({ ...editingRecord, paymentTerms: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      <option value="NET_14">NET_14</option>
                      <option value="NET_30">NET_30</option>
                      <option value="CASH_ON_DELIVERY">CASH_ON_DELIVERY</option>
                      <option value="MOMO_INSTANT">MOMO_INSTANT</option>
                    </select>
                  </div>
                </>
              ) : moduleType === "INVENTORY" ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Item Name</label>
                    <input type="text" data-testid="edit-inventory-name" value={editingRecord.name || ""}
                      onChange={(e) => setEditingRecord({ ...editingRecord, name: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">SKU / Item Code</label>
                      <input type="text" value={editingRecord.sku || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, sku: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Category</label>
                      <input type="text" value={editingRecord.category || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, category: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Quantity on Hand</label>
                      <input type="number" step="0.01" min="0" data-testid="edit-inventory-qty" value={editingRecord.quantity}
                        onChange={(e) => setEditingRecord({ ...editingRecord, quantity: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Unit</label>
                      <input type="text" value={editingRecord.unit || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, unit: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Cost Price (GH₵)</label>
                      <input type="number" step="0.01" min="0" value={editingRecord.costPriceGhs}
                        onChange={(e) => setEditingRecord({ ...editingRecord, costPriceGhs: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Selling Price (GH₵)</label>
                      <input type="number" step="0.01" min="0" value={editingRecord.sellingPriceGhs}
                        onChange={(e) => setEditingRecord({ ...editingRecord, sellingPriceGhs: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Min. Stock Threshold</label>
                      <input type="number" step="0.01" min="0" value={editingRecord.minStockThreshold}
                        onChange={(e) => setEditingRecord({ ...editingRecord, minStockThreshold: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Expiry Date (optional)</label>
                      <input type="date" value={editingRecord.expiryDate || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, expiryDate: e.target.value || null })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Employee Name</label>
                    <input type="text" data-testid="edit-employee-name" value={editingRecord.name || ""}
                      onChange={(e) => setEditingRecord({ ...editingRecord, name: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Role / Position</label>
                      <input type="text" value={editingRecord.role || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, role: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Monthly Salary (GH₵)</label>
                      <input type="number" step="0.01" value={editingRecord.salaryGhs}
                        onChange={(e) => setEditingRecord({ ...editingRecord, salaryGhs: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Phone</label>
                      <input type="text" value={editingRecord.phone || ""}
                        onChange={(e) => setEditingRecord({ ...editingRecord, phone: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1">Status</label>
                      <select
                        value={editingRecord.status || "ACTIVE"}
                        onChange={(e) => setEditingRecord({ ...editingRecord, status: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="ON_LEAVE">ON_LEAVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Assigned Business</label>
                    <select
                      value={String(editingRecord.businessId)}
                      onChange={(e) => setEditingRecord({ ...editingRecord, businessId: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                    >
                      {businesses.map((b: any) => (
                        <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button type="button" onClick={() => setEditingRecord(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={recordBusy} data-testid="record-edit-save"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50">
                  {recordBusy ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Delete confirmation — mandatory reason, permanently audited ─── */}
      {deletingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-rose-500/40 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4" data-testid="delete-confirm-modal">
            <div className="flex items-center gap-2 text-rose-300 font-bold text-base">
              <AlertTriangle className="w-5 h-5" />
              Confirm permanent deletion
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              You are about to delete <b className="text-rose-300">{recordLabel(deletingRecord)}</b>.
              This cannot be undone. The deletion is permanently recorded with your
              user, the date &amp; time, and the reason you give below.
            </p>
            {recordErr && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">{recordErr}</div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">
                Reason for deletion <span className="text-rose-400">* (recorded in the audit trail)</span>
              </label>
              <textarea
                rows={2}
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g. Duplicate entry created in error…"
                data-testid="delete-reason-input"
                className="w-full px-3 py-2 bg-slate-800 border border-rose-500/40 rounded-lg text-white text-sm"
              />
            </div>
            <div className="flex justify-end space-x-3 pt-1 border-t border-slate-800">
              <button type="button" onClick={() => { setDeletingRecord(null); setDeleteReason(""); }}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold">
                Cancel
              </button>
              <button
                onClick={confirmRecordDelete}
                disabled={recordBusy || deleteReason.trim().length < 3}
                data-testid="delete-confirm-btn"
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {recordBusy ? "Deleting…" : "Delete Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── OWNER access-control console ─── */}
      {showAccessModal && isOwnerUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4" data-testid="record-access-modal">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-300" />
                <h3 className="text-lg font-bold text-white">Record Access Control</h3>
              </div>
              <button onClick={() => setShowAccessModal(false)} data-testid="access-modal-close" className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {moduleType === "INVENTORY" ? (
                <>You (the OWNER) can <b>always</b> add, edit and delete Inventory &amp; Stock entries.
                  Use the toggles to grant or remove the <b>delete-inventory</b> permission for selected
                  managers, letting them manage, edit and delete stock entries too. Every deletion is
                  logged with user, date, time and reason.</>
              ) : moduleType === "TRANSACTIONS" ? (
                <>You (the OWNER) can <b>always</b> add, edit and delete every transaction — including
                  expenses. Use the two toggles to grant or remove the shared-record power (income,
                  investment &amp; transfer) and the <b>expense-management</b> power separately. Every
                  deletion is logged with user, date, time and reason.</>
              ) : (
                <>You (the OWNER) can <b>always</b> add, edit and delete records in Suppliers &amp; Vendors
                  and Employees &amp; Payroll. Use the toggles to grant or remove the same power for
                  selected managers. Every deletion is logged with user, date, time and reason.</>
              )}
            </p>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {accessUsers.map((u) => (
                <div key={u.id} className="rounded-xl bg-slate-800/70 border border-slate-700 px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">{u.name}</div>
                      <div className="text-[10px] text-slate-400">
                        <span className="font-black text-cyan-300">{u.role}</span>
                        {u.assignedBusinessId ? ` · ${getBusinessName(u.assignedBusinessId)}` : " · All businesses"}
                      </div>
                    </div>
                  </div>
                  {accessFields.map((f) => (
                    <div key={f.key} className="flex items-center justify-between gap-3">
                      <span className="text-[10px] text-slate-400 leading-tight">{f.label}</span>
                      <button
                        onClick={() => toggleRecordAccess(u, f.key)}
                        disabled={accessBusy === `${f.key}:${u.id}`}
                        data-testid={`access-toggle-${f.key}-${u.id}`}
                        className={`shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-black transition ${
                          u[f.key]
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30"
                            : "bg-slate-700/70 text-slate-400 border border-slate-600 hover:bg-slate-600"
                        }`}
                      >
                        {accessBusy === `${f.key}:${u.id}` ? "…" : u[f.key] ? "CAN MANAGE & DELETE ✓" : "NO ACCESS"}
                      </button>
                    </div>
                  ))}
                </div>
              ))}
              {accessUsers.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-4">Loading users…</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Dedicated Asset Registration modal (Business + Branch required) */}
      <AssetRegistrationModal
        isOpen={showAssetModal}
        onClose={() => setShowAssetModal(false)}
        onSaved={(created: any) => {
          onRefreshData();
          setAssetQrPreset("");
          if (created?.qrCode) {
            setQrRecord({ kind: "asset", record: created, justRegistered: true });
          }
        }}
        initialQr={assetQrPreset}
        businesses={businesses}
        currentUser={currentUser}
        lockedBusinessId={lockedBusinessId}
      />

      {/* QR camera scanner + record/label viewer (inventory & assets) */}
      <QrScanModal
        open={qrScanOpen}
        onClose={() => setQrScanOpen(false)}
        onCode={handleQrCode}
        busy={qrBusy}
        error={qrError}
        title={moduleType === "ASSETS" ? "Scan Asset QR" : "Scan Item QR"}
      />
      {qrRecord && (
        <QrRecordModal
          open
          onClose={() => setQrRecord(null)}
          kind={qrRecord.kind}
          record={qrRecord.record}
          justRegistered={!!qrRecord.justRegistered}
          businesses={businesses}
        />
      )}

      {/* Payroll Command Center (Employees & Payroll module) */}
      {moduleType === "EMPLOYEES" && showPayroll && (
        <PayrollCenter
          currentUser={currentUser}
          businesses={businesses}
          employees={employees}
          onChanged={onRefreshData}
          onClose={() => setShowPayroll(false)}
        />
      )}

      {/* Employee Registration (full HR record) */}
      {moduleType === "EMPLOYEES" && showEmpReg && (
        <EmployeeRegistration
          currentUser={currentUser}
          businesses={businesses}
          initial={empEdit}
          onSaved={() => { setShowEmpReg(false); setEmpEdit(null); onRefreshData(); }}
          onClose={() => { setShowEmpReg(false); setEmpEdit(null); }}
        />
      )}

      {/* Employee Profile — record, documents & history */}
      {moduleType === "EMPLOYEES" && empProfile && (
        <EmployeeProfile
          currentUser={currentUser}
          businesses={businesses}
          employee={empProfile}
          onClose={() => setEmpProfile(null)}
          onEdit={(e) => { setEmpProfile(null); setEmpEdit(e); setShowEmpReg(true); }}
          onChanged={onRefreshData}
        />
      )}

      {/* Confirmation gate for Sale / Inventory / Asset final execution */}
      <ConfirmActionModal
        open={!!confirmAction}
        title={confirmAction?.title || ""}
        message={confirmAction?.message || ""}
        details={confirmAction?.details || []}
        tone={confirmAction?.tone || "rose"}
        confirmLabel={confirmAction?.confirmLabel}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const run = confirmAction?.run;
          setConfirmAction(null);
          run?.();
        }}
        testid="shared-confirm-entry"
      />
    </div>
  );
}
