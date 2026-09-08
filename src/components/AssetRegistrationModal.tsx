"use client";

import React, { useEffect, useMemo, useState } from "react";
import { X, Wrench, Building2, MapPin, CheckCircle, ImagePlus, Clock, User, QrCode } from "lucide-react";
import { formatLocation } from "@/lib/ghanaLocations";
import QrScanModal from "./QrScanModal";
import { buildAssetQr } from "@/lib/qrRegistry";

interface AssetRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (created?: any) => void;
  /** QR content pre-attached by the module-level scanner (new registration). */
  initialQr?: string;
  businesses: any[];
  currentUser: any;
  /** When set (Branch Manager), the business + branch are locked to this id. */
  lockedBusinessId?: number | null;
}

/**
 * Asset Registration Modal.
 *
 * Enforces that every asset is linked to a Business AND a Branch before it
 * can be saved. When a business has a single branch (as with all 7 initial
 * businesses) the branch dropdown auto-selects that branch; if additional
 * branches exist under the same business category they are all listed.
 * The asset inherits the branch's standardized Ghana location automatically,
 * which flows through to business and branch reports and dashboards.
 */
export default function AssetRegistrationModal({
  isOpen,
  onClose,
  onSaved,
  initialQr = "",
  businesses,
  currentUser,
  lockedBusinessId = null,
}: AssetRegistrationModalProps) {
  const isLocked = lockedBusinessId != null;

  // Required linkage
  const [businessId, setBusinessId] = useState<string>("");
  const [branchCode, setBranchCode] = useState<string>("");

  // QR identity tag (camera-scanned or auto-generated over the asset code)
  const [assetQr, setAssetQr] = useState(initialQr || "");
  const [qrScanOpen, setQrScanOpen] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);

  // Modal stays mounted (isOpen-controlled) — absorb a scanner preset on open.
  useEffect(() => {
    if (isOpen && initialQr) setAssetQr(initialQr);
  }, [isOpen, initialQr]);

  /** Scanned code: attach only if brand-new — otherwise say who owns it. */
  const handleAssetQrScan = async (code: string) => {
    setQrBusy(true);
    try {
      const res = await fetch(`/api/enterprise?qr=${encodeURIComponent(code)}`);
      const d = await res.json().catch(() => null);
      if (res.ok && d?.found) {
        setErrorMsg(
          `This QR code is already registered to ${d.kind === "asset" ? "asset" : "stock item"} "${d.record?.name}". Every QR must be unique — remove the old record first.`
        );
      } else {
        setAssetQr(code);
        setErrorMsg("");
      }
    } catch {
      setErrorMsg("Registry lookup failed — try the scan again.");
    } finally {
      setQrBusy(false);
      setQrScanOpen(false);
    }
  };

  // Unique asset code
  const [assetCode, setAssetCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [codeStatus, setCodeStatus] = useState<
    "idle" | "checking" | "available" | "taken"
  >("idle");

  // Asset details
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assetType, setAssetType] = useState("MACHINERY");
  const [customAssetType, setCustomAssetType] = useState("");
  const [assetImages, setAssetImages] = useState<string[]>([]);
  const [recordedAtPreview, setRecordedAtPreview] = useState(new Date());
  const [purchasePrice, setPurchasePrice] = useState<string>("25000");
  const [currentValue, setCurrentValue] = useState<string>("22500");
  const [condition, setCondition] = useState("EXCELLENT");
  const [onSiteLocation, setOnSiteLocation] = useState("Main Yard");
  const [nextMaintenance, setNextMaintenance] = useState(
    new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0]
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Reset the form each time the modal is opened
  useEffect(() => {
    if (isOpen) {
      // Branch Managers are locked to their own branch
      setBusinessId(isLocked ? String(lockedBusinessId) : "");
      setBranchCode("");
      setAssetCode("");
      setCodeTouched(false);
      setCodeStatus("idle");
      setName("");
      setDescription("");
      setAssetType("MACHINERY");
      setCustomAssetType("");
      setAssetImages([]);
      setRecordedAtPreview(new Date());
      setPurchasePrice("25000");
      setCurrentValue("22500");
      setCondition("EXCELLENT");
      setOnSiteLocation("Main Yard");
      setNextMaintenance(
        new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0]
      );
      setErrorMsg("");
      setSuccessMsg("");
    }
  }, [isOpen]);

  // Auto-suggest a current value at 90% of purchase price when the user hasn't
  // touched the current value field.
  useEffect(() => {
    const p = Number(purchasePrice);
    if (!isNaN(p) && p > 0) {
      setCurrentValue(Math.round(p * 0.9).toString());
    }
  }, [purchasePrice]);

  // Compute branches available for the selected business. In the current data
  // model each business row IS its own branch, so we scope by category + region
  // to include any additional branches the owner may have added under the same
  // umbrella business.
  const selectedBusiness = useMemo(
    () => businesses.find((b) => String(b.id) === businessId),
    [businessId, businesses]
  );

  const branchOptions = useMemo(() => {
    if (!selectedBusiness) return [] as any[];
    // A locked (Branch Manager) session may only ever target its own branch.
    if (isLocked) return [selectedBusiness];
    return businesses.filter(
      (b) => b.category === selectedBusiness.category
    );
  }, [businesses, selectedBusiness, isLocked]);

  // When the business changes, auto-select the single matching branch if
  // there is only one, so the user isn't forced to click twice.
  useEffect(() => {
    if (!selectedBusiness) {
      setBranchCode("");
      return;
    }
    if (branchOptions.length === 1) {
      setBranchCode(branchOptions[0].code);
    } else if (
      branchCode &&
      !branchOptions.some((b) => b.code === branchCode)
    ) {
      setBranchCode("");
    }
  }, [selectedBusiness, branchOptions, branchCode]);

  const selectedBranch = branchOptions.find((b) => b.code === branchCode);

  // Auto-suggest the next sequential unique Asset Code whenever the branch
  // changes, unless the user has typed their own code.
  useEffect(() => {
    if (!isOpen || !branchCode || codeTouched) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/assets/next-code?branchCode=${encodeURIComponent(branchCode)}`
        );
        const data = await res.json();
        if (!cancelled && data.success && data.suggestion) {
          setAssetCode(data.suggestion);
          setCodeStatus("available");
        }
      } catch {
        /* suggestion is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, branchCode, codeTouched]);

  // Live uniqueness check for a manually entered Asset Code (debounced).
  useEffect(() => {
    if (!codeTouched) return;
    const code = assetCode.trim();
    if (!code) {
      setCodeStatus("idle");
      return;
    }
    setCodeStatus("checking");
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/assets/next-code?check=${encodeURIComponent(code)}`
        );
        const data = await res.json();
        setCodeStatus(data.available ? "available" : "taken");
      } catch {
        setCodeStatus("idle");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [assetCode, codeTouched]);

  const branchLocationLine = selectedBranch
    ? formatLocation(
        selectedBranch.region,
        selectedBranch.district,
        selectedBranch.town
      )
    : "Choose a branch to auto-fill location";

  const handleImageFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const readers = Array.from(files).map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        })
    );
    try {
      const images = await Promise.all(readers);
      setAssetImages((prev) => [...prev, ...images]);
    } catch {
      setErrorMsg("One or more asset images could not be read.");
    }
  };

  const finalAssetType =
    assetType === "OTHER" ? customAssetType.trim().toUpperCase() : assetType;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    // Client-side guardrails: Business + Branch are mandatory.
    if (!businessId) {
      setErrorMsg("Please select a Business.");
      return;
    }
    if (!branchCode) {
      setErrorMsg("Please select a Branch.");
      return;
    }
    if (!name.trim()) {
      setErrorMsg("Please enter the asset name.");
      return;
    }
    if (!assetCode.trim()) {
      setErrorMsg("Please enter a unique Asset Code.");
      return;
    }
    if (codeStatus === "taken") {
      setErrorMsg(
        `Asset Code "${assetCode.trim().toUpperCase()}" is already in use. Please choose another.`
      );
      return;
    }
    if (!finalAssetType) {
      setErrorMsg("Please select an asset type or enter a custom one.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/enterprise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: "asset",
          data: {
            assetCode: assetCode.trim().toUpperCase(),
            name: name.trim(),
            description: description.trim(),
            businessId: Number(businessId),
            branchCode,
            branchName: selectedBranch?.name,
            // Server-side scope enforcement for Branch Managers
            requestingUserRole: currentUser?.role,
            requestingUserBusinessId: currentUser?.assignedBusinessId,
            recorderName: currentUser?.name || "Unknown Recorder",
            requestedByName: currentUser?.name || "Unknown Recorder",
            assetImages,
            assetType: finalAssetType,
            purchasePriceGhs: Number(purchasePrice),
            currentValueGhs: Number(currentValue),
            condition,
            location: onSiteLocation,
            nextMaintenanceDate: nextMaintenance,
            registeredByUserId: currentUser?.id ?? null,
            // QR identity: the scanned/attached tag, or a canonical tag derived
            // from the final asset code (globally unique, server-enforced).
            qrCode: assetQr.trim() || buildAssetQr(branchCode, assetCode.trim().toUpperCase()),
            // Inherit standardized Ghana location from the branch
            region: selectedBranch?.region,
            district: selectedBranch?.district,
            town: selectedBranch?.town,
          },
        }),
      });

      const data = await res.json();
      if (data.success) {
        setSuccessMsg(
          `Asset registered to ${selectedBranch?.name || "branch"}.`
        );
        onSaved(data.item);
        // Close after a short beat so the user sees the confirmation
        setTimeout(() => onClose(), 900);
      } else {
        setErrorMsg(data.error || "Failed to register asset.");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Network error while registering asset.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2">
            <div className="w-9 h-9 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center">
              <Wrench className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Register Asset</h3>
              <p className="text-[11px] text-slate-400">
                Link to a Business and Branch to power reports & analytics
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {errorMsg && (
          <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-3 rounded-lg text-xs">
            {errorMsg}
          </div>
        )}
        {successMsg && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-3 rounded-lg text-xs flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Required linkage: Business → Branch */}
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-purple-300 uppercase tracking-wider">
              <Building2 className="w-4 h-4" />
              <span>Business & Branch (Required)</span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Business <span className="text-rose-400">*</span>
              </label>
              <select
                required
                value={businessId}
                disabled={isLocked}
                onChange={(e) => setBusinessId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500 disabled:opacity-60"
              >
                <option value="">Select business…</option>
                {(isLocked
                  ? businesses.filter((b) => b.id === lockedBusinessId)
                  : businesses
                ).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.category})
                  </option>
                ))}
              </select>
              {isLocked && (
                <p className="text-[10px] text-slate-500 mt-1">
                  Locked to your assigned branch
                </p>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Branch <span className="text-rose-400">*</span>
              </label>
              <select
                required
                value={branchCode}
                onChange={(e) => setBranchCode(e.target.value)}
                disabled={!businessId || branchOptions.length === 0}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500 disabled:opacity-50"
              >
                <option value="">
                  {businessId ? "Select branch…" : "Choose a business first"}
                </option>
                {branchOptions.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                <MapPin className="w-3 h-3 text-emerald-400" />
                <span>{branchLocationLine}</span>
              </div>
            </div>
          </div>

          {/* Unique Asset Code */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1">
              Asset Code <span className="text-rose-400">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={assetCode}
                onChange={(e) => {
                  setCodeTouched(true);
                  setAssetCode(e.target.value.toUpperCase());
                }}
                placeholder={
                  branchCode ? `${branchCode}-AST-0001` : "Select a branch first"
                }
                className={`flex-1 px-3 py-2 bg-slate-800 border rounded-lg text-white text-sm font-mono focus:outline-none ${
                  codeStatus === "taken"
                    ? "border-rose-500"
                    : codeStatus === "available"
                    ? "border-emerald-500/60"
                    : "border-slate-700 focus:border-purple-500"
                }`}
              />
              <button
                type="button"
                onClick={() => {
                  setCodeTouched(false);
                  setAssetCode("");
                }}
                disabled={!branchCode}
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-40 whitespace-nowrap"
                title="Regenerate the next sequential code for this branch"
              >
                Auto
              </button>
            </div>
            <p
              className={`text-[10px] mt-1 ${
                codeStatus === "taken"
                  ? "text-rose-400"
                  : codeStatus === "available"
                  ? "text-emerald-400"
                  : "text-slate-500"
              }`}
            >
              {codeStatus === "checking" && "Checking availability…"}
              {codeStatus === "available" && "✓ Code is unique and available"}
              {codeStatus === "taken" && "✗ This code is already in use"}
              {codeStatus === "idle" &&
                "Must be unique across the entire enterprise"}
            </p>
          </div>

          {/* QR identity — scan with the camera; auto-generated from the code on save */}
          <div className="bg-slate-800/50 border border-slate-700/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-slate-400">QR Identity Tag</label>
              <button
                type="button"
                onClick={() => setQrScanOpen(true)}
                data-testid="ast-qr-scan-open"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold hover:bg-cyan-600/40 transition"
              >
                <QrCode className="w-3.5 h-3.5" /> Scan QR
              </button>
            </div>
            {assetQr ? (
              <div className="flex items-center justify-between gap-2" data-testid="ast-qr-chip">
                <span className="font-mono text-[10px] text-cyan-200 break-all">{assetQr}</span>
                <button type="button" onClick={() => setAssetQr("")} className="text-slate-500 hover:text-rose-400 text-xs font-bold px-1" title="Remove attached QR">✕</button>
              </div>
            ) : (
              <p className="text-[10px] text-slate-500" data-testid="ast-qr-auto">
                No scan attached — a unique label QR is generated automatically when you save.
              </p>
            )}
          </div>

          {/* Automatic recorder + timestamp */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-slate-700/70 bg-slate-800/50 p-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <User className="w-4 h-4 text-emerald-400" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                  Asset Recorder
                </div>
                <div className="font-semibold text-slate-100">
                  {currentUser?.name || "Unknown Recorder"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Clock className="w-4 h-4 text-cyan-400" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                  Automatic Date & Time Stamp
                </div>
                <div className="font-mono text-slate-100">
                  {recordedAtPreview.toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          {/* Asset details */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1">
              Asset Name <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Deere Farm Tractor"
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1">
              Detailed Asset Description (Optional)
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explain usage, physical condition, service history, or key specifications."
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm resize-none h-24"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Asset Type
              </label>
              <select
                value={assetType}
                onChange={(e) => setAssetType(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              >
                <option value="MACHINERY">Machinery</option>
                <option value="VEHICLE">Vehicle</option>
                <option value="GENERATOR">Generator / Power</option>
                <option value="STRUCTURE">Structure / Building</option>
                <option value="TECH">Technology / IT</option>
                <option value="FARM_EQUIPMENT">Farm Equipment</option>
                <option value="KITCHEN_EQUIPMENT">Kitchen Equipment</option>
                <option value="SECURITY_DEVICE">Security / CCTV Device</option>
                <option value="OTHER">Create New Asset Type…</option>
              </select>
              {assetType === "OTHER" && (
                <input
                  type="text"
                  value={customAssetType}
                  onChange={(e) => setCustomAssetType(e.target.value)}
                  placeholder="Enter new asset type"
                  className="mt-2 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500"
                />
              )}
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Condition
              </label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              >
                <option value="EXCELLENT">Excellent</option>
                <option value="GOOD">Good</option>
                <option value="NEEDS_MAINTENANCE">Needs Maintenance</option>
                <option value="UNDER_REPAIR">Under Repair</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Purchase Value (GH₵)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchasePrice}
                onChange={(e) => setPurchasePrice(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Current Value (GH₵)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={currentValue}
                onChange={(e) => setCurrentValue(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                On-Site Placement
              </label>
              <input
                type="text"
                value={onSiteLocation}
                onChange={(e) => setOnSiteLocation(e.target.value)}
                placeholder="e.g. Bay A, Cold Room 2"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Next Maintenance
              </label>
              <input
                type="date"
                value={nextMaintenance}
                onChange={(e) => setNextMaintenance(e.target.value)}
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
              />
            </div>
          </div>

          {/* Asset image uploads */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <ImagePlus className="w-4 h-4 text-purple-400" />
              Upload Asset Images (one or more)
            </label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => handleImageFiles(e.target.files)}
              className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-purple-600 file:px-3 file:py-2 file:text-xs file:font-bold file:text-white hover:file:bg-purple-500"
            />
            {assetImages.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {assetImages.map((img, idx) => (
                  <div key={`${img.slice(0, 20)}-${idx}`} className="relative group">
                    <img
                      src={img}
                      alt={`Asset image ${idx + 1}`}
                      className="h-16 w-full object-cover rounded-lg border border-slate-700"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAssetImages((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="absolute -top-1 -right-1 bg-rose-600 text-white rounded-full w-5 h-5 text-[10px] opacity-90"
                      aria-label="Remove image"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-slate-500">
              {assetImages.length} image{assetImages.length === 1 ? "" : "s"} attached. Images are stored with the asset record for inspection and audit.
            </p>
          </div>

          <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
            >
              {isSubmitting ? "Registering…" : "Register Asset"}
            </button>
          </div>
        </form>
      </div>

      {/* Camera/manual QR scanner — attach a new tag, reject taken ones */}
      <QrScanModal
        open={qrScanOpen}
        onClose={() => setQrScanOpen(false)}
        onCode={handleAssetQrScan}
        busy={qrBusy}
        title="Scan Asset QR"
      />
    </div>
  );
}
