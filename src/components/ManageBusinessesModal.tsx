"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Copy,
  Crosshair,
  Download,
  Globe,
  Image as ImageIcon,
  MapPin,
  Pencil,
  Plus,
  Power,
  QrCode,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import LocationSelector, { LocationValue } from "./LocationSelector";
import { qrDataUrl } from "@/lib/qrRegistry";
import { googleMapsEmbed } from "@/lib/tracking";

/** Resize an uploaded image to a compact base64 data-URL (≤512px JPEG) —
 *  the same convention used for employee photos and document uploads. */
async function logoFileToDataUrl(file: File | Blob, max = 512): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale) || 1;
      const h = Math.round(img.height * scale) || 1;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

const CATEGORIES = [
  "Poultry Farm",
  "Block Factory",
  "Aquaculture",
  "Livestock",
  "Restaurant & Food",
  "Electronic Shop",
  "Car Wash",
  "Hardware Store",
  "Telecom & Digital Services",
];

const STATUSES = ["ACTIVE", "EXPANDING", "MAINTENANCE", "INACTIVE"];

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  EXPANDING: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  MAINTENANCE: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  INACTIVE: "bg-rose-500/15 text-rose-300 border-rose-500/40",
};

interface ManageBusinessesModalProps {
  isOpen: boolean;
  onClose: () => void;
  businesses: any[];
  currentUser: any;
  onChanged: () => void | Promise<unknown>;
  onAddNew: () => void;
  onDeleted?: (code: string) => void;
  /** Deep-link straight into a unit's Online Ordering panel (navbar entry). */
  initialOnlineBizId?: number | null;
}

type Mode = "list" | "edit" | "delete" | "reset" | "logos" | "online";

export default function ManageBusinessesModal({
  isOpen,
  onClose,
  businesses,
  currentUser,
  onChanged,
  onAddNew,
  onDeleted,
  initialOnlineBizId = null,
}: ManageBusinessesModalProps) {
  const isOwner = currentUser?.role === "OWNER";
  // Authorized staff: manager roles (and owner-delegated record managers) may
  // run Online Ordering & the service area for businesses they can access —
  // the businesses list itself is already access-scoped by the server, and
  // the PATCH API re-checks every save.
  const canManageOnline =
    isOwner ||
    currentUser?.role === "GENERAL_MANAGER" ||
    currentUser?.role === "BRANCH_MANAGER" ||
    !!currentUser?.canManageRecords;

  const [mode, setMode] = useState<Mode>("list");
  const [selected, setSelected] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Two-step arm for deactivate / reactivate
  const [armedCode, setArmedCode] = useState<string | null>(null);

  // Edit form state
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [location, setLocation] = useState<LocationValue>({
    region: "Greater Accra",
    district: "",
    town: "",
  });
  const [managerName, setManagerName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [initialCapitalGhs, setInitialCapitalGhs] = useState(0);
  const [monthlyTargetRevenueGhs, setMonthlyTargetRevenueGhs] = useState(0);
  const [status, setStatus] = useState("ACTIVE");

  // Delete-confirmation state
  const [deleteCounts, setDeleteCounts] = useState<any | null>(null);
  const [confirmText, setConfirmText] = useState("");

  // Reset-confirmation state
  const [resetCounts, setResetCounts] = useState<any | null>(null);
  const [resetMasters, setResetMasters] = useState(false);
  const [resetStaffUsers, setResetStaffUsers] = useState(false);

  // Logo-manager state (mode === "logos")
  const [logoBusy, setLogoBusy] = useState(false);
  const [companyLogo, setCompanyLogoState] = useState<string | null>(null);
  const [branchCode, setBranchCode] = useState("");
  const [branchLogoFile, setBranchLogoFile] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...businesses].sort((a, b) => a.id - b.id),
    [businesses]
  );

  useEffect(() => {
    if (isOpen) {
      setMode("list");
      setSelected(null);
      setError("");
      setNotice("");
      setArmedCode(null);
      setConfirmText("");
      setDeleteCounts(null);
      setResetCounts(null);
      setResetMasters(false);
      setResetStaffUsers(false);
    }
  }, [isOpen]);

  // ── Online ordering & service area (mode === "online") ──────────────────
  const [onlEnabled, setOnlEnabled] = useState(true);
  const [onlPickup, setOnlPickup] = useState(true);
  const [onlDelivery, setOnlDelivery] = useState(true);
  const [onlRadius, setOnlRadius] = useState(""); // "" = no geographic limit
  const [onlNote, setOnlNote] = useState("");
  const [onlDirty, setOnlDirty] = useState(false);
  const [onlQrOrder, setOnlQrOrder] = useState("");
  const [onlQrTrack, setOnlQrTrack] = useState("");
  const [onlCopied, setOnlCopied] = useState("");
  const [onlGpsBusy, setOnlGpsBusy] = useState(false);
  const [onlHelp, setOnlHelp] = useState(""); // customer help line (call/WhatsApp)
  const [onlMomo, setOnlMomo] = useState(""); // MoMo number customers pay to
  const [onlMomoName, setOnlMomoName] = useState(""); // MoMo payee name
  // Service areas / localities + pickup locations (own lists per unit)
  const [areas, setAreas] = useState<any[]>([]);
  const [pickups, setPickups] = useState<any[]>([]);
  const [listsBusy, setListsBusy] = useState(false);
  const emptyAreaForm = { id: 0, name: "", radius: "5", lat: "", lng: "", note: "" };
  const emptyPickForm = { id: 0, name: "", address: "", phone: "", instr: "", lat: "", lng: "" };
  const [areaForm, setAreaForm] = useState<any>({ ...emptyAreaForm });
  const [pickForm, setPickForm] = useState<any>({ ...emptyPickForm });

  const originOf = () =>
    typeof window !== "undefined" ? window.location.origin : "https://gomina360.app";

  const openOnline = (biz: any) => {
    setSelected(biz);
    setOnlEnabled(biz.onlineOrderingEnabled !== false);
    setOnlPickup(biz.pickupEnabled !== false);
    setOnlDelivery(biz.deliveryEnabled !== false);
    setOnlRadius(biz.serviceRadiusKm != null ? String(biz.serviceRadiusKm) : "");
    setOnlNote(biz.serviceNote || "");
    setOnlHelp(biz.customerHelpPhone || "");
    setOnlMomo(biz.momoNumber || "");
    setOnlMomoName(biz.momoName || "");
    setOnlDirty(false);
    setError("");
    setNotice("");
    setOnlCopied("");
    setAreaForm({ ...emptyAreaForm });
    setPickForm({ ...emptyPickForm });
    setMode("online");
    loadAreasPickups(biz.id);
    qrDataUrl(`${originOf()}/order?biz=${biz.id}`, 320).then(setOnlQrOrder).catch(() => setOnlQrOrder(""));
    qrDataUrl(`${originOf()}/track`, 320).then(setOnlQrTrack).catch(() => setOnlQrTrack(""));
  };

  // Deep-link (navbar "Online storefront & delivery areas"): open straight
  // into the requested unit's Online panel. Runs after the reset effect.
  useEffect(() => {
    if (isOpen && initialOnlineBizId) {
      const biz = businesses.find((b: any) => b.id === initialOnlineBizId);
      if (biz) openOnline(biz);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialOnlineBizId]);

  const saveOnline = async () => {
    if (!selected) return;
    let radius: number | null = null;
    if (onlRadius.trim() !== "") {
      const v = Number(onlRadius);
      if (!Number.isFinite(v) || v <= 0 || v > 1000) {
        setError("Service radius must be a number of kilometres between 0 and 1000 (leave empty for no limit).");
        return;
      }
      radius = Math.round(v * 100) / 100;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId: currentUser?.id ?? null,
          onlineOrderingEnabled: onlEnabled,
          pickupEnabled: onlPickup,
          deliveryEnabled: onlDelivery,
          serviceRadiusKm: radius,
          serviceNote: onlNote.trim() || null,
          customerHelpPhone: onlHelp.trim() || null,
          momoNumber: onlMomo.trim() || null,
          momoName: onlMomoName.trim() || null,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await onChanged();
        setSelected(d.business);
        setOnlDirty(false);
        setNotice(
          d.business.onlineOrderingEnabled === false
            ? `"${d.business.name}" switched OFF the customer storefront — hidden from /order and blocked at checkout until you switch it back on.`
            : `"${d.business.name}" online-ordering settings saved — the customer storefront reflects them immediately.`,
        );
      } else {
        setError(d?.error || "Failed to save online-ordering settings.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error while saving settings.");
    } finally {
      setBusy(false);
    }
  };

  // Anchor the branch's public Google-Maps pin from where the manager stands —
  // the same pin used for pickup maps and the service-area radius ring. Only
  // ever an explicit button press (silent capture would leak the manager's
  // location).
  const setBranchGpsFromHere = async () => {
    if (!selected || typeof navigator === "undefined" || !navigator.geolocation) return;
    setOnlGpsBusy(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await fetch(`/api/businesses/${selected.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              actorUserId: currentUser?.id ?? null,
              gpsLat: Number(pos.coords.latitude.toFixed(7)),
              gpsLng: Number(pos.coords.longitude.toFixed(7)),
            }),
          });
          const d = await res.json().catch(() => null);
          if (res.ok && d?.success) {
            await onChanged();
            setSelected(d.business);
            setNotice(`"${d.business.name}" branch pin anchored at ${d.business.gpsLat.toFixed(6)}, ${d.business.gpsLng.toFixed(6)} — pickup map & service-area ring now centre here.`);
          } else {
            setError(d?.error || "Could not save the branch pin.");
          }
        } catch (err: any) {
          setError(err?.message || "Network error while saving the branch pin.");
        } finally {
          setOnlGpsBusy(false);
        }
      },
      (err) => {
        setOnlGpsBusy(false);
        setError(err?.code === 1 ? "Location permission denied — allow it to anchor the branch pin." : "Could not get a GPS fix — move outside and try again.");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  // ── Service areas / localities + pickup locations CRUD (mode === "online")
  const loadAreasPickups = async (bizId: number) => {
    setListsBusy(true);
    try {
      const res = await fetch(`/api/service-areas?businessId=${bizId}`, { credentials: "include" });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setAreas(d.areas || []);
        setPickups(d.pickups || []);
      } else {
        setAreas([]);
        setPickups([]);
        if (d?.error) setError(d.error);
      }
    } catch {
      setAreas([]);
      setPickups([]);
    } finally {
      setListsBusy(false);
    }
  };

  const gpsInto = (setter: (lat: string, lng: string) => void) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setter(pos.coords.latitude.toFixed(7), pos.coords.longitude.toFixed(7)),
      () => setError("Could not get a GPS fix — drop the coordinates manually instead."),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  const saveArea = async () => {
    if (!selected) return;
    const editing = Number(areaForm.id) > 0;
    const body: any = {
      name: areaForm.name.trim(),
      note: areaForm.note.trim() || null,
      centerLat: areaForm.lat.trim() === "" ? null : Number(areaForm.lat),
      centerLng: areaForm.lng.trim() === "" ? null : Number(areaForm.lng),
      radiusKm: areaForm.radius.trim() === "" ? null : Number(areaForm.radius),
    };
    setListsBusy(true);
    setError("");
    try {
      const res = await fetch("/api/service-areas", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(editing ? { id: areaForm.id, ...body } : { businessId: selected.id, ...body }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setAreaForm({ ...emptyAreaForm });
        await loadAreasPickups(selected.id);
        setNotice(editing ? `Service area "${body.name}" updated.` : `Service area "${body.name}" added — customers inside it now see this branch first.`);
      } else {
        setError(d?.error || "Could not save the service area.");
      }
    } finally {
      setListsBusy(false);
    }
  };

  const toggleArea = async (row: any) => {
    if (!selected) return;
    setListsBusy(true);
    try {
      await fetch("/api/service-areas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: row.id, active: !row.active }),
      });
      await loadAreasPickups(selected.id);
    } finally {
      setListsBusy(false);
    }
  };

  const removeArea = async (row: any) => {
    if (!selected) return;
    setListsBusy(true);
    setError("");
    try {
      const res = await fetch("/api/service-areas", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: row.id }),
      });
      const d = await res.json().catch(() => null);
      if (!(res.ok && d?.success)) setError(d?.error || "Could not remove the service area.");
      await loadAreasPickups(selected.id);
    } finally {
      setListsBusy(false);
    }
  };

  const savePickup = async () => {
    if (!selected) return;
    const editing = Number(pickForm.id) > 0;
    const body: any = {
      name: pickForm.name.trim(),
      address: pickForm.address.trim() || null,
      contactPhone: pickForm.phone.trim() || null,
      instructions: pickForm.instr.trim() || null,
      lat: pickForm.lat.trim() === "" ? null : Number(pickForm.lat),
      lng: pickForm.lng.trim() === "" ? null : Number(pickForm.lng),
    };
    setListsBusy(true);
    setError("");
    try {
      const res = await fetch("/api/service-areas?kind=pickups", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(editing ? { id: pickForm.id, ...body } : { businessId: selected.id, ...body }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setPickForm({ ...emptyPickForm });
        await loadAreasPickups(selected.id);
        setNotice(editing ? `Pickup point "${body.name}" updated.` : `Pickup point "${body.name}" added — customers choose it at checkout.`);
      } else {
        setError(d?.error || "Could not save the pickup point.");
      }
    } finally {
      setListsBusy(false);
    }
  };

  const togglePickup = async (row: any) => {
    if (!selected) return;
    setListsBusy(true);
    try {
      await fetch("/api/service-areas?kind=pickups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: row.id, active: !row.active }),
      });
      await loadAreasPickups(selected.id);
    } finally {
      setListsBusy(false);
    }
  };

  const removePickup = async (row: any) => {
    if (!selected) return;
    setListsBusy(true);
    setError("");
    try {
      const res = await fetch("/api/service-areas?kind=pickups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: row.id }),
      });
      const d = await res.json().catch(() => null);
      if (!(res.ok && d?.success)) setError(d?.error || "Could not remove the pickup point.");
      await loadAreasPickups(selected.id);
    } finally {
      setListsBusy(false);
    }
  };

  if (!isOpen) return null;

  const openEdit = (biz: any) => {
    setSelected(biz);
    setName(biz.name || "");
    setCategory(CATEGORIES.includes(biz.category) ? biz.category : CATEGORIES[0]);
    setLocation({
      region: biz.region || "Greater Accra",
      district: biz.district || "",
      town: biz.town || "",
    });
    setManagerName(biz.managerName || "");
    setContactPhone(biz.contactPhone || "");
    setInitialCapitalGhs(Number(biz.initialCapitalGhs) || 0);
    setMonthlyTargetRevenueGhs(Number(biz.monthlyTargetRevenueGhs) || 0);
    setStatus((biz.status || "ACTIVE").toUpperCase());
    setError("");
    setNotice("");
    setMode("edit");
  };

  const openDelete = async (biz: any) => {
    setSelected(biz);
    setConfirmText("");
    setDeleteCounts(null);
    setError("");
    setNotice("");
    setMode("delete");
    try {
      const res = await fetch(`/api/businesses/${biz.id}`);
      const d = await res.json();
      if (res.ok && d?.success) setDeleteCounts(d.counts);
    } catch {
      /* counts are informational only */
    }
  };

  const openReset = async (biz: any) => {
    setSelected(biz);
    setConfirmText("");
    setResetCounts(null);
    setResetMasters(false);
    setResetStaffUsers(false);
    setError("");
    setNotice("");
    setMode("reset");
    try {
      const res = await fetch(`/api/businesses/${biz.id}`);
      const d = await res.json();
      if (res.ok && d?.success) setResetCounts(d.counts);
    } catch {
      /* counts are informational only */
    }
  };

  // ── Logo management ────────────────────────────────────────────────────
  // The OWNER (or a manager the OWNER approved via record-management
  // permission) can set: the GoMina company logo, each business's logo, and
  // per-branch overrides. Documents resolve branch → business → company.
  const openLogos = async (biz: any) => {
    setSelected(biz);
    setBranchCode(biz.code || "");
    setBranchLogoFile(null);
    setError("");
    setNotice("");
    setMode("logos");
    try {
      const res = await fetch("/api/logos");
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) setCompanyLogoState(d.companyLogo || null);
    } catch {
      /* informational only */
    }
  };

  const postLogo = async (payload: any): Promise<boolean> => {
    setLogoBusy(true);
    setError("");
    try {
      const res = await fetch("/api/logos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorUserId: currentUser?.id ?? null, ...payload }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) {
        setError(d?.error || "Failed to save the logo.");
        return false;
      }
      await onChanged(); // refresh bootstrap so every document resolves the new logo
      if (payload.action === "SET_COMPANY_LOGO") setCompanyLogoState(d.companyLogo ?? null);
      return true;
    } catch (err: any) {
      setError(err?.message || "Network error while saving the logo.");
      return false;
    } finally {
      setLogoBusy(false);
    }
  };

  const uploadCompanyLogo = async (file: File) => {
    const logo = await logoFileToDataUrl(file);
    if (await postLogo({ action: "SET_COMPANY_LOGO", logo })) {
      setNotice("GoMina company logo saved — it now appears on every document whose business/branch has no own logo.");
    }
  };

  const uploadBusinessLogo = async (bizId: number, bizName: string, file: File) => {
    const logo = await logoFileToDataUrl(file);
    if (await postLogo({ action: "SET_BUSINESS_LOGO", businessId: bizId, logo })) {
      setNotice(`"${bizName}" logo saved — it now heads this business's invoices, receipts, quotations, payslips and reports.`);
    }
  };

  const saveBranchLogo = async () => {
    const code = branchCode.trim().toUpperCase();
    if (!selected || !code || !branchLogoFile) return;
    if (await postLogo({ action: "SET_BRANCH_LOGO", businessId: selected.id, branchCode: code, logo: branchLogoFile })) {
      setNotice(`Branch ${code} logo saved — documents for branch ${code} now use this logo automatically.`);
      setBranchLogoFile(null);
    }
  };

  const removeBranchLogo = async (code: string) => {
    if (!selected) return;
    if (await postLogo({ action: "SET_BRANCH_LOGO", businessId: selected.id, branchCode: code, logo: null })) {
      setNotice(`Branch ${code} logo removed — that branch falls back to the business logo.`);
    }
  };

  const handleReset = async () => {
    if (!selected || confirmText.trim() !== selected.code) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${selected.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId: currentUser?.id ?? null,
          confirmCode: confirmText.trim(),
          resetMasterLists: resetMasters,
          resetUsers: resetStaffUsers,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await onChanged();
        setNotice(
          `"${d.reset.name}" (${d.reset.code}) reset to a NEW business state — ` +
            `${d.removedRecords} operational records cleared; starter stock kit and a zero-based dashboard re-seeded.` +
            (resetMasters ? " Master lists were reset to type defaults." : " Master lists preserved.") +
            (resetStaffUsers ? ` ${d.usersUnassigned} staff user(s) un-assigned.` : " Staff users kept.")
        );
        resetToList();
      } else {
        setError(d?.error || "Failed to reset the business.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error while resetting the business.");
    } finally {
      setBusy(false);
    }
  };

  const resetToList = () => {
    setMode("list");
    setSelected(null);
    setArmedCode(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId: currentUser?.id ?? null,
          name,
          category,
          region: location.region,
          district: location.district,
          town: location.town,
          managerName,
          contactPhone,
          initialCapitalGhs: Number(initialCapitalGhs),
          monthlyTargetRevenueGhs: Number(monthlyTargetRevenueGhs),
          status,
        }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await onChanged();
        const tc = d.typeChange;
        setNotice(
          tc
            ? `"${d.business.name}" updated — type changed to ${d.business.category}. New-type starter kit (${tc.kitItemsAdded} items) and checklists provisioned automatically across inventory, finance, dashboards & reports.`
            : `"${d.business.name}" updated — every dashboard, report and module now reflects the change.`
        );
        resetToList();
      } else {
        setError(d?.error || "Failed to update the business unit.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error while updating the unit.");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async (biz: any) => {
    // First click arms, second click confirms.
    if (armedCode !== biz.code) {
      setArmedCode(biz.code);
      return;
    }
    setArmedCode(null);
    const next = (biz.status || "ACTIVE").toUpperCase() === "INACTIVE" ? "ACTIVE" : "INACTIVE";
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${biz.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, actorUserId: currentUser?.id ?? null }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await onChanged();
        setNotice(
          next === "INACTIVE"
            ? `"${d.business.name}" deactivated — it is flagged INACTIVE everywhere (sidebar, dashboards, reports) but ALL data is preserved.`
            : `"${d.business.name}" re-activated and fully operational again.`
        );
      } else {
        setError(d?.error || "Failed to change status.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error while changing status.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || confirmText.trim() !== selected.code) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/businesses/${selected.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmCode: confirmText.trim(), actorUserId: currentUser?.id ?? null }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        await onChanged();
        onDeleted?.(selected.code);
        setNotice(
          `"${d.deleted.name}" (${d.deleted.code}) permanently deleted — ${d.removedRecords} related records removed; all dashboards and reports updated.`
        );
        resetToList();
      } else {
        setError(d?.error || "Failed to delete the business unit.");
      }
    } catch (err: any) {
      setError(err?.message || "Network error while deleting the unit.");
    } finally {
      setBusy(false);
    }
  };

  const countRow = (label: string, value: number) => (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-800/70 last:border-0">
      <span className="text-slate-300">{label}</span>
      <span className={`font-black ${value > 0 ? "text-rose-300" : "text-slate-500"}`}>
        {value}
      </span>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      data-testid="manage-biz-modal"
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-300 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">
                Manage Businesses & Branches
              </h3>
              <p className="text-xs text-slate-400">
                {mode === "list" &&
                  (isOwner
                    ? "Owner console — add, edit, relocate, change type, online ordering & service areas, deactivate or permanently delete any unit"
                    : "Manage online ordering, service areas & share links for your businesses")}
                {mode === "edit" && `Editing ${selected?.name} (${selected?.code})`}
                {mode === "delete" && `Confirm permanent deletion of ${selected?.name}`}
                {mode === "reset" && `Reset ${selected?.name} to a new business state`}
                {mode === "logos" && `Company & business logos — ${selected?.name} (${selected?.code})`}
                {mode === "online" &&
                  `Online ordering, service area & share links — ${selected?.name} (${selected?.code})`}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {mode !== "list" && (
              <button
                onClick={resetToList}
                className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>All Units</span>
              </button>
            )}
            <button
              onClick={onClose}
              data-testid="manage-biz-close"
              className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-4">
          {!isOwner && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded-lg text-xs">
              Only the OWNER can change business units. You are viewing this console read-only.
            </div>
          )}
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs">
              {error}
            </div>
          )}
          {notice && (
            <div
              className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 p-2.5 rounded-lg text-xs"
              data-testid="manage-biz-notice"
            >
              {notice}
            </div>
          )}

          {/* ============ LIST MODE ============ */}
          {mode === "list" && (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-400">
                  <span className="font-black text-white">{sorted.length}</span> enterprise units
                  under management
                </div>
                {isOwner && (
                  <button
                    onClick={() => {
                      onClose();
                      onAddNew();
                    }}
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Branch / Unit</span>
                  </button>
                )}
              </div>

              <div className="space-y-2">
                {sorted.map((biz) => {
                  const inactive = (biz.status || "").toUpperCase() === "INACTIVE";
                  const armed = armedCode === biz.code;
                  return (
                    <div
                      key={biz.code}
                      data-testid={`manage-biz-row-${biz.code}`}
                      className={`rounded-xl border p-3.5 transition ${
                        inactive
                          ? "bg-slate-900/40 border-rose-500/25"
                          : "bg-slate-800/60 border-slate-700"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start space-x-3 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                              inactive
                                ? "bg-rose-500/15 text-rose-300"
                                : "bg-emerald-500/15 text-emerald-300"
                            }`}
                          >
                            <Building2 className="w-5 h-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`font-bold text-sm truncate ${
                                  inactive ? "text-slate-400 line-through" : "text-white"
                                }`}
                              >
                                {biz.name}
                              </span>
                              <span className="text-[10px] font-black bg-slate-700/70 text-slate-300 px-1.5 py-0.5 rounded border border-slate-600">
                                {biz.code}
                              </span>
                              <span
                                data-testid={`manage-status-${biz.code}`}
                                className={`text-[10px] font-black px-1.5 py-0.5 rounded border ${
                                  STATUS_STYLE[(biz.status || "ACTIVE").toUpperCase()] ||
                                  STATUS_STYLE.ACTIVE
                                }`}
                              >
                                {(biz.status || "ACTIVE").toUpperCase()}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                              <span>{biz.category}</span>
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {biz.branchLocation}
                                {biz.region ? ` • ${biz.region}` : ""}
                              </span>
                              <span>Manager: {biz.managerName}</span>
                            </div>
                          </div>
                        </div>

                        {isOwner && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => openOnline(biz)}
                              data-testid={`manage-biz-online-${biz.code}`}
                              title="Online ordering, service area & share QR/links"
                              className={`p-2 rounded-lg transition ${
                                biz.onlineOrderingEnabled === false
                                  ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
                                  : "bg-slate-700/70 hover:bg-emerald-500/30 text-slate-200 hover:text-emerald-300"
                              }`}
                            >
                              <Globe className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openEdit(biz)}
                              data-testid={`manage-biz-edit-${biz.code}`}
                              title="Edit / rename / relocate / change type"
                              className="p-2 rounded-lg bg-slate-700/70 hover:bg-indigo-500/30 text-slate-200 hover:text-indigo-300 transition"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openLogos(biz)}
                              data-testid={`manage-biz-logos-${biz.code}`}
                              title="Company & business logos — shown on invoices, receipts, quotations, payslips, reports & PDFs"
                              className="p-2 rounded-lg bg-slate-700/70 hover:bg-fuchsia-500/30 text-slate-200 hover:text-fuchsia-300 transition"
                            >
                              <ImageIcon className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(biz)}
                              disabled={busy}
                              data-testid={`manage-biz-deactivate-${biz.code}`}
                              title={inactive ? "Re-activate unit" : "Deactivate unit"}
                              className={`px-2 py-2 rounded-lg text-[10px] font-black transition flex items-center gap-1 ${
                                armed
                                  ? "bg-amber-500/30 text-amber-200 border border-amber-400/50"
                                  : inactive
                                  ? "bg-slate-700/70 hover:bg-emerald-500/30 text-slate-200 hover:text-emerald-300"
                                  : "bg-slate-700/70 hover:bg-amber-500/30 text-slate-200 hover:text-amber-300"
                              }`}
                            >
                              <Power className="w-4 h-4" />
                              {armed
                                ? inactive
                                  ? "Confirm Re-activate"
                                  : "Confirm Deactivate"
                                : inactive
                                ? "Re-activate"
                                : "Deactivate"}
                            </button>
                            <button
                              onClick={() => openReset(biz)}
                              data-testid={`manage-biz-reset-${biz.code}`}
                              title="Reset to new business state — clears all operational records"
                              className="p-2 rounded-lg bg-slate-700/70 hover:bg-cyan-500/30 text-slate-200 hover:text-cyan-300 transition"
                            >
                              <RotateCcw className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openDelete(biz)}
                              data-testid={`manage-biz-delete-${biz.code}`}
                              title="Permanently delete unit"
                              className="p-2 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 transition"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                        {/* Authorized staff (GM / BM / record managers): ONLY the
                            online-ordering & service-area panel — every save is
                            re-checked server-side against their business access. */}
                        {!isOwner && canManageOnline && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => openOnline(biz)}
                              data-testid={`manage-biz-online-${biz.code}`}
                              title="Online ordering, service area & share QR/links"
                              className={`flex items-center gap-1 px-2.5 py-2 rounded-lg text-[10px] font-black transition ${
                                biz.onlineOrderingEnabled === false
                                  ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
                                  : "bg-slate-700/70 hover:bg-emerald-500/30 text-slate-200 hover:text-emerald-300"
                              }`}
                            >
                              <Globe className="w-4 h-4" />
                              <span className="hidden sm:inline">Online</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ============ ONLINE ORDERING & SERVICE AREA MODE ============ */}
          {mode === "online" && selected && (() => {
            const bizRow = sorted.find((b) => b.id === selected.id) || selected;
            const orderUrl = `${originOf()}/order?biz=${bizRow.id}`;
            const trackUrl = `${originOf()}/track`;
            const storefrontOff = bizRow.onlineOrderingEnabled === false;

            const SwitchRow = ({ label, desc, on, onFlip, tid }: any) => (
              <button
                type="button"
                onClick={() => { onFlip(!on); setOnlDirty(true); }}
                className={`w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl border text-left transition ${
                  on ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-800/80 border-slate-700"
                }`}
                data-testid={tid}
              >
                <span>
                  <span className="block text-[12px] font-extrabold text-white">{label}</span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">{desc}</span>
                </span>
                <span
                  className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition ${
                    on ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                  style={{ height: 22 }}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                      on ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </span>
              </button>
            );

            const copy = async (key: string, text: string) => {
              try {
                await navigator.clipboard.writeText(text);
              } catch { /* clipboard can be unavailable — the URL field is selectable */ }
              setOnlCopied(key);
              setTimeout(() => setOnlCopied((c) => (c === key ? "" : c)), 1500);
            };

            return (
              <div className="space-y-4" data-testid="mb-onl-root">
                {storefrontOff && (
                  <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3.5 py-2.5 text-[11px] text-rose-200" data-testid="mb-onl-offbanner">
                    This unit is <b>OFF</b> the customer storefront: it does not appear on /order and checkout is
                    refused until you switch online ordering back on. In-store sales are unaffected.
                  </div>
                )}

                {/* Storefront switches */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <SwitchRow
                    label="Online ordering"
                    desc="Show on the public customer storefront"
                    on={onlEnabled}
                    onFlip={setOnlEnabled}
                    tid="mb-onl-toggle-enabled"
                  />
                  <SwitchRow
                    label="Pickup"
                    desc="Customers collect at this branch"
                    on={onlPickup}
                    onFlip={setOnlPickup}
                    tid="mb-onl-toggle-pickup"
                  />
                  <SwitchRow
                    label="Delivery"
                    desc="Courier to a customer-pinned point"
                    on={onlDelivery}
                    onFlip={setOnlDelivery}
                    tid="mb-onl-toggle-delivery"
                  />
                </div>

                {/* Service area */}
                <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5 space-y-3">
                  <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-emerald-300" /> Service area (Google Maps)
                  </h4>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Customers sharing their location on the storefront only see branches that deliver to them.
                    Set how far you deliver from the branch pin — leave empty to deliver everywhere. Orders pinned
                    beyond the radius are refused automatically; pickup always works.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Delivery radius (km) — empty = no limit
                      </span>
                      <input
                        value={onlRadius}
                        onChange={(e) => { setOnlRadius(e.target.value); setOnlDirty(true); }}
                        inputMode="decimal"
                        placeholder="e.g. 15"
                        className="mt-1 w-full px-3 py-2.5 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 rounded-xl text-sm text-white outline-none"
                        data-testid="mb-onl-radius"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Customer-visible service note
                      </span>
                      <input
                        value={onlNote}
                        onChange={(e) => { setOnlNote(e.target.value); setOnlDirty(true); }}
                        maxLength={160}
                        placeholder='e.g. "Free delivery within Spintex"'
                        className="mt-1 w-full px-3 py-2.5 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 rounded-xl text-sm text-white outline-none"
                        data-testid="mb-onl-note"
                      />
                    </label>
                  </div>

                  {/* Branch pin */}
                  <div className="rounded-xl bg-slate-900/70 border border-slate-700/80 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Branch map pin</div>
                      {bizRow.gpsLat != null && bizRow.gpsLng != null ? (
                        <div className="text-[11px] text-emerald-300 font-mono mt-0.5" data-testid="mb-onl-gps-state">
                          {Number(bizRow.gpsLat).toFixed(6)}, {Number(bizRow.gpsLng).toFixed(6)} — pickup map &
                          radius ring centre here
                        </div>
                      ) : (
                        <div className="text-[11px] text-amber-300 mt-0.5" data-testid="mb-onl-gps-state">
                          Not set — the radius filter and customer pickup map need this pin. Stand at the branch
                          and anchor it now.
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={setBranchGpsFromHere}
                      disabled={onlGpsBusy}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-bold shrink-0"
                      data-testid="mb-onl-gps-set"
                    >
                      <Crosshair className={`w-3.5 h-3.5 ${onlGpsBusy ? "animate-spin" : ""}`} />
                      {onlGpsBusy ? "Anchoring…" : "Anchor at my location"}
                    </button>
                  </div>
                  {bizRow.gpsLat != null && bizRow.gpsLng != null && (
                    <iframe
                      key={`${bizRow.gpsLat},${bizRow.gpsLng}`}
                      title="Branch pin — Google Maps"
                      src={googleMapsEmbed(bizRow.gpsLat, bizRow.gpsLng, 14)}
                      className="w-full h-[160px] rounded-xl bg-slate-800 border border-slate-700"
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      data-testid="mb-onl-map"
                    />
                  )}
                </section>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={saveOnline}
                    disabled={busy}
                    className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-black shadow-lg transition"
                    data-testid="mb-onl-save"
                  >
                    {busy ? "Saving…" : "Save online-ordering settings"}
                  </button>
                  {onlDirty && (
                    <span className="text-[10px] font-bold text-amber-300" data-testid="mb-onl-dirty">
                      Unsaved changes
                    </span>
                  )}
                </div>

                {/* Customer help & MoMo payment numbers */}
                <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5 space-y-3" data-testid="mb-onl-contacts">
                  <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-amber-300" /> Customer help & MoMo payment
                  </h4>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Shown to customers straight after they place an order and on their tracking page — the
                    business telephone appears right under <em>Payment — “Awaiting payment confirmation”</em> as
                    the number to call for payment assistance or delivery support; the MoMo number is where to pay.
                    Saved together with the settings above.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Business telephone — payment assistance &amp; delivery support (call / WhatsApp)</span>
                      <input
                        value={onlHelp}
                        onChange={(e) => { setOnlHelp(e.target.value); setOnlDirty(true); }}
                        maxLength={24}
                        placeholder="e.g. 024 100 2000"
                        className="mt-1 w-full px-3 py-2.5 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 rounded-xl text-sm text-white outline-none"
                        data-testid="mb-onl-help"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">MoMo number</span>
                      <input
                        value={onlMomo}
                        onChange={(e) => { setOnlMomo(e.target.value); setOnlDirty(true); }}
                        maxLength={24}
                        placeholder="e.g. 059 411 2233"
                        className="mt-1 w-full px-3 py-2.5 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 rounded-xl text-sm text-white outline-none"
                        data-testid="mb-onl-momo"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">MoMo payee name</span>
                      <input
                        value={onlMomoName}
                        onChange={(e) => { setOnlMomoName(e.target.value); setOnlDirty(true); }}
                        maxLength={60}
                        placeholder="e.g. Mina Akuafo Poultry"
                        className="mt-1 w-full px-3 py-2.5 bg-slate-900 border border-slate-700 focus:border-emerald-500/60 rounded-xl text-sm text-white outline-none"
                        data-testid="mb-onl-momoname"
                      />
                    </label>
                  </div>
                </section>

                {/* Service areas / localities — this unit's own list */}
                <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5 space-y-3" data-testid="mb-areas">
                  <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-cyan-300" /> Service areas / localities
                    <span className="text-[9px] font-bold text-slate-500 normal-case" data-testid="mb-areas-count">({areas.length})</span>
                  </h4>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    The places THIS branch delivers to — every branch keeps its own list. Add a map centre +
                    radius and only customers inside see this branch as serving them; name-only areas are shown
                    to customers as information. Inactive areas neither show nor serve.
                  </p>
                  <div className="space-y-2" data-testid="mb-area-list">
                    {areas.length === 0 && (
                      <p className="text-[11px] text-slate-500 italic" data-testid="mb-area-empty">No named areas yet — the branch-radius rule above applies everywhere it covers.</p>
                    )}
                    {areas.map((a) => (
                      <div key={a.id} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${a.active ? "border-slate-700 bg-slate-900/70" : "border-slate-800 bg-slate-900/40 opacity-60"}`} data-testid={`mb-area-row-${a.id}`}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-bold text-white truncate">{a.name}</span>
                          <span className="block text-[10px] text-slate-400 truncate">
                            {a.centerLat != null ? `${Number(a.centerLat).toFixed(5)}, ${Number(a.centerLng).toFixed(5)} · ${a.radiusKm} km` : "name only (no map zone)"}{a.note ? ` — ${a.note}` : ""}
                          </span>
                        </span>
                        <button type="button" onClick={() => setAreaForm({ id: a.id, name: a.name, radius: a.radiusKm != null ? String(a.radiusKm) : "", lat: a.centerLat != null ? String(a.centerLat) : "", lng: a.centerLng != null ? String(a.centerLng) : "", note: a.note || "" })} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-200" data-testid={`mb-area-edit-${a.id}`}>Edit</button>
                        <button type="button" onClick={() => toggleArea(a)} className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${a.active ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-600 text-slate-400"}`} data-testid={`mb-area-toggle-${a.id}`}>{a.active ? "Active" : "Off"}</button>
                        <button type="button" onClick={() => removeArea(a)} className="px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/40 text-[10px] font-bold text-rose-300" data-testid={`mb-area-del-${a.id}`}>Remove</button>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl bg-slate-900/70 border border-slate-700/80 p-3 space-y-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {Number(areaForm.id) > 0 ? "Edit service area" : "Add a service area"}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input value={areaForm.name} onChange={(e) => setAreaForm((f: any) => ({ ...f, name: e.target.value }))} maxLength={60} placeholder='Area / locality name — e.g. "Osu"' className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-cyan-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-area-add-name" />
                      <input value={areaForm.radius} onChange={(e) => setAreaForm((f: any) => ({ ...f, radius: e.target.value }))} inputMode="decimal" placeholder="Radius km (needs map point)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-cyan-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-area-add-radius" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input value={areaForm.lat} onChange={(e) => setAreaForm((f: any) => ({ ...f, lat: e.target.value }))} inputMode="decimal" placeholder="Centre latitude (optional)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-cyan-500/60 rounded-lg text-[12px] text-white outline-none font-mono" data-testid="mb-area-add-lat" />
                      <input value={areaForm.lng} onChange={(e) => setAreaForm((f: any) => ({ ...f, lng: e.target.value }))} inputMode="decimal" placeholder="Centre longitude (optional)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-cyan-500/60 rounded-lg text-[12px] text-white outline-none font-mono" data-testid="mb-area-add-lng" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={bizRow.gpsLat == null} onClick={() => setAreaForm((f: any) => ({ ...f, lat: String(bizRow.gpsLat), lng: String(bizRow.gpsLng) }))} className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 disabled:opacity-40 text-[10px] font-bold text-slate-200" data-testid="mb-area-gps-branch">Use branch pin</button>
                      <button type="button" onClick={() => gpsInto((lat, lng) => setAreaForm((f: any) => ({ ...f, lat, lng })))} className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-200" data-testid="mb-area-gps-here">Use my location</button>
                      <input value={areaForm.note} onChange={(e) => setAreaForm((f: any) => ({ ...f, note: e.target.value }))} maxLength={160} placeholder='Note — e.g. "Same-day before 2pm"' className="flex-1 min-w-[160px] px-3 py-1.5 bg-slate-900 border border-slate-700 focus:border-cyan-500/60 rounded-lg text-[12px] text-white outline-none" data-testid="mb-area-add-note" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={saveArea} disabled={listsBusy} className="px-3.5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-[11px] font-black" data-testid="mb-area-add-btn">
                        {Number(areaForm.id) > 0 ? "Save area" : "Add area"}
                      </button>
                      {Number(areaForm.id) > 0 && (
                        <button type="button" onClick={() => setAreaForm({ ...emptyAreaForm })} className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-600 text-[11px] font-bold text-slate-300" data-testid="mb-area-cancel">Cancel edit</button>
                      )}
                    </div>
                  </div>
                </section>

                {/* Pickup locations — customers choose at checkout */}
                <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5 space-y-3" data-testid="mb-pickups">
                  <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-fuchsia-300" /> Pickup locations
                    <span className="text-[9px] font-bold text-slate-500 normal-case" data-testid="mb-pick-count">({pickups.length})</span>
                  </h4>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Where customers collect PICKUP orders. With no points listed, pickup defaults to the branch
                    itself; with one or more active points, customers pick one at checkout and it is saved on
                    their order & tracking. Removing a point never rewrites past orders (they keep a snapshot).
                  </p>
                  <div className="space-y-2" data-testid="mb-pick-list">
                    {pickups.length === 0 && (
                      <p className="text-[11px] text-slate-500 italic" data-testid="mb-pick-empty">No pickup points — customers collect at the branch (branch pin above).</p>
                    )}
                    {pickups.map((pl) => (
                      <div key={pl.id} className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${pl.active ? "border-slate-700 bg-slate-900/70" : "border-slate-800 bg-slate-900/40 opacity-60"}`} data-testid={`mb-pick-row-${pl.id}`}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-bold text-white truncate">{pl.name}</span>
                          <span className="block text-[10px] text-slate-400 truncate">
                            {pl.address || "—"}{pl.lat != null ? ` · ${Number(pl.lat).toFixed(5)}, ${Number(pl.lng).toFixed(5)}` : ""}{pl.contactPhone ? ` · ${pl.contactPhone}` : ""}
                          </span>
                        </span>
                        <button type="button" onClick={() => setPickForm({ id: pl.id, name: pl.name, address: pl.address || "", phone: pl.contactPhone || "", instr: pl.instructions || "", lat: pl.lat != null ? String(pl.lat) : "", lng: pl.lng != null ? String(pl.lng) : "" })} className="px-2 py-1 rounded-lg bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-200" data-testid={`mb-pick-edit-${pl.id}`}>Edit</button>
                        <button type="button" onClick={() => togglePickup(pl)} className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${pl.active ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-600 text-slate-400"}`} data-testid={`mb-pick-toggle-${pl.id}`}>{pl.active ? "Active" : "Off"}</button>
                        <button type="button" onClick={() => removePickup(pl)} className="px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/40 text-[10px] font-bold text-rose-300" data-testid={`mb-pick-del-${pl.id}`}>Remove</button>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl bg-slate-900/70 border border-slate-700/80 p-3 space-y-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {Number(pickForm.id) > 0 ? "Edit pickup point" : "Add a pickup point"}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input value={pickForm.name} onChange={(e) => setPickForm((f: any) => ({ ...f, name: e.target.value }))} maxLength={60} placeholder='Name — e.g. "Spintex Depot"' className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-pick-add-name" />
                      <input value={pickForm.address} onChange={(e) => setPickForm((f: any) => ({ ...f, address: e.target.value }))} maxLength={200} placeholder="Address / directions" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-pick-add-addr" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input value={pickForm.phone} onChange={(e) => setPickForm((f: any) => ({ ...f, phone: e.target.value }))} maxLength={24} placeholder="Contact phone (optional)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-pick-add-phone" />
                      <input value={pickForm.instr} onChange={(e) => setPickForm((f: any) => ({ ...f, instr: e.target.value }))} maxLength={240} placeholder='Instructions — e.g. "Ask for the blue gate"' className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-sm text-white outline-none" data-testid="mb-pick-add-instr" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input value={pickForm.lat} onChange={(e) => setPickForm((f: any) => ({ ...f, lat: e.target.value }))} inputMode="decimal" placeholder="Latitude (optional)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-[12px] text-white outline-none font-mono" data-testid="mb-pick-add-lat" />
                      <input value={pickForm.lng} onChange={(e) => setPickForm((f: any) => ({ ...f, lng: e.target.value }))} inputMode="decimal" placeholder="Longitude (optional)" className="px-3 py-2 bg-slate-900 border border-slate-700 focus:border-fuchsia-500/60 rounded-lg text-[12px] text-white outline-none font-mono" data-testid="mb-pick-add-lng" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={bizRow.gpsLat == null} onClick={() => setPickForm((f: any) => ({ ...f, lat: String(bizRow.gpsLat), lng: String(bizRow.gpsLng) }))} className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 disabled:opacity-40 text-[10px] font-bold text-slate-200" data-testid="mb-pick-gps-branch">Use branch pin</button>
                      <button type="button" onClick={() => gpsInto((lat, lng) => setPickForm((f: any) => ({ ...f, lat, lng })))} className="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-[10px] font-bold text-slate-200" data-testid="mb-pick-gps-here">Use my location</button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={savePickup} disabled={listsBusy} className="px-3.5 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 text-white text-[11px] font-black" data-testid="mb-pick-add-btn">
                        {Number(pickForm.id) > 0 ? "Save point" : "Add point"}
                      </button>
                      {Number(pickForm.id) > 0 && (
                        <button type="button" onClick={() => setPickForm({ ...emptyPickForm })} className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-600 text-[11px] font-bold text-slate-300" data-testid="mb-pick-cancel">Cancel edit</button>
                      )}
                    </div>
                  </div>
                </section>

                {/* Shareable links + QR codes */}
                <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3.5 space-y-3">
                  <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <QrCode className="w-3.5 h-3.5 text-fuchsia-300" /> Customer order & tracking links
                  </h4>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Print the QR at the counter, on flyers or WhatsApp status — scanning opens this unit's ordering
                    page (or the tracking page) with no sign-in. The order link pre-selects this business.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Order */}
                    <div className="rounded-xl bg-slate-900/70 border border-slate-700/80 p-3 space-y-2">
                      <div className="text-[11px] font-extrabold text-emerald-300">Order from {bizRow.name}</div>
                      <input
                        readOnly
                        value={orderUrl}
                        onFocus={(e) => e.target.select()}
                        className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300 outline-none"
                        data-testid="mb-onl-order-url"
                      />
                      <div className="flex items-center gap-2">
                        {onlQrOrder ? (
                          <img
                            src={onlQrOrder}
                            alt="QR code — order page"
                            width={104}
                            height={104}
                            className="rounded-lg border border-slate-600 bg-white p-1.5"
                            data-testid="mb-onl-qr-order"
                          />
                        ) : (
                          <div className="w-[104px] h-[104px] rounded-lg border border-dashed border-slate-600 flex items-center justify-center text-[9px] text-slate-500" data-testid="mb-onl-qr-order-loading">
                            Building QR…
                          </div>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <button
                            type="button"
                            onClick={() => copy("order", orderUrl)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px] font-bold"
                            data-testid="mb-onl-copy-order"
                          >
                            <Copy className="w-3 h-3" /> {onlCopied === "order" ? "Copied!" : "Copy link"}
                          </button>
                          {onlQrOrder && (
                            <a
                              href={onlQrOrder}
                              download={`gomina-order-${bizRow.code}.png`}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px] font-bold"
                              data-testid="mb-onl-qr-order-dl"
                            >
                              <Download className="w-3 h-3" /> Download QR
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Track */}
                    <div className="rounded-xl bg-slate-900/70 border border-slate-700/80 p-3 space-y-2">
                      <div className="text-[11px] font-extrabold text-cyan-300">Track any order</div>
                      <input
                        readOnly
                        value={trackUrl}
                        onFocus={(e) => e.target.select()}
                        className="w-full px-2.5 py-2 bg-slate-800 border border-slate-700 rounded-lg text-[10px] font-mono text-slate-300 outline-none"
                        data-testid="mb-onl-track-url"
                      />
                      <div className="flex items-center gap-2">
                        {onlQrTrack ? (
                          <img
                            src={onlQrTrack}
                            alt="QR code — tracking page"
                            width={104}
                            height={104}
                            className="rounded-lg border border-slate-600 bg-white p-1.5"
                            data-testid="mb-onl-qr-track"
                          />
                        ) : (
                          <div className="w-[104px] h-[104px] rounded-lg border border-dashed border-slate-600 flex items-center justify-center text-[9px] text-slate-500" data-testid="mb-onl-qr-track-loading">
                            Building QR…
                          </div>
                        )}
                        <div className="flex flex-col gap-1.5">
                          <button
                            type="button"
                            onClick={() => copy("track", trackUrl)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px] font-bold"
                            data-testid="mb-onl-copy-track"
                          >
                            <Copy className="w-3 h-3" /> {onlCopied === "track" ? "Copied!" : "Copy link"}
                          </button>
                          {onlQrTrack && (
                            <a
                              href={onlQrTrack}
                              download={`gomina-track.png`}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px] font-bold"
                              data-testid="mb-onl-qr-track-dl"
                            >
                              <Download className="w-3 h-3" /> Download QR
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            );
          })()}

          {/* ============ LOGOS MODE ============ */}
          {mode === "logos" && selected && (() => {
            const bizRow = sorted.find((b) => b.id === selected.id) || selected;
            const branchMap = (bizRow.branchLogos as any) || {};
            const branchEntries = Object.keys(branchMap).filter((k) => branchMap[k]);
            return (
              <div className="space-y-4" data-testid="bizlogo-mgr">
                <div className="rounded-xl bg-fuchsia-500/10 border border-fuchsia-500/25 p-3 text-[11px] text-fuchsia-200/90 leading-relaxed">
                  Logos are saved centrally once and used <b>everywhere automatically</b> — invoices,
                  receipts, quotations, payslips, reports, statements and all downloadable PDFs.
                  Resolution per document: <b>branch logo → business logo → GoMina company logo</b>.
                </div>

                {/* ── Company (group) logo ── */}
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-14 h-14 rounded-xl bg-white flex items-center justify-center shrink-0 overflow-hidden">
                        {companyLogo ? (
                          <img src={companyLogo} alt="GoMina company logo" className="max-h-12 max-w-12 object-contain" data-testid="bizlogo-company-preview" />
                        ) : (
                          <Building2 className="w-6 h-6 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-white">GoMina Company Logo</p>
                        <p className="text-[11px] text-slate-400">Group-level fallback — used when a business/branch has no own logo, and on group-wide reports.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <label className={`px-2.5 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-bold cursor-pointer ${logoBusy ? "opacity-50 pointer-events-none" : ""}`}>
                        {companyLogo ? "Replace" : "Upload"}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          data-testid="bizlogo-company-upload"
                          disabled={logoBusy}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) await uploadCompanyLogo(f);
                          }}
                        />
                      </label>
                      {companyLogo && (
                        <button
                          onClick={async () => {
                            if (await postLogo({ action: "SET_COMPANY_LOGO", logo: null })) setNotice("Company logo removed.");
                          }}
                          disabled={logoBusy}
                          data-testid="bizlogo-company-remove"
                          className="px-2.5 py-1.5 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 text-[11px] font-bold"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Business logo ── */}
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-14 h-14 rounded-xl bg-white flex items-center justify-center shrink-0 overflow-hidden">
                        {bizRow.logo ? (
                          <img src={bizRow.logo} alt={`${bizRow.name} logo`} className="max-h-12 max-w-12 object-contain" data-testid={`bizlogo-preview-${bizRow.id}`} />
                        ) : (
                          <Building2 className="w-6 h-6 text-slate-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-sm text-white">{bizRow.name} — Business Logo</p>
                        <p className="text-[11px] text-slate-400">Heads this business's invoices, receipts, quotations, payslips, reports & PDFs (unless a branch override exists).</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <label className={`px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold cursor-pointer ${logoBusy ? "opacity-50 pointer-events-none" : ""}`}>
                        {bizRow.logo ? "Replace" : "Upload"}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          data-testid={`bizlogo-upload-${bizRow.id}`}
                          disabled={logoBusy}
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            e.target.value = "";
                            if (f) await uploadBusinessLogo(bizRow.id, bizRow.name, f);
                          }}
                        />
                      </label>
                      {bizRow.logo && (
                        <button
                          onClick={async () => {
                            if (await postLogo({ action: "SET_BUSINESS_LOGO", businessId: bizRow.id, logo: null })) {
                              setNotice(`"${bizRow.name}" logo removed — its documents fall back to the GoMina company logo.`);
                            }
                          }}
                          disabled={logoBusy}
                          data-testid={`bizlogo-remove-${bizRow.id}`}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-200 hover:text-rose-300 text-[11px] font-bold"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Branch logo overrides ── */}
                <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3.5 space-y-3">
                  <div>
                    <p className="font-bold text-sm text-white">Branch Logo Overrides — {bizRow.name}</p>
                    <p className="text-[11px] text-slate-400">Give a specific branch its own logo. Its documents then use the branch logo instead of the business logo.</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      value={branchCode}
                      onChange={(e) => setBranchCode(e.target.value.toUpperCase())}
                      placeholder="BRANCH-CODE"
                      data-testid={`bizlogo-branch-code-${bizRow.id}`}
                      className="w-36 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-600 text-white text-xs font-mono uppercase"
                    />
                    <label className={`px-2.5 py-1.5 rounded-lg bg-slate-700/70 hover:bg-slate-600 text-slate-200 text-[11px] font-bold cursor-pointer ${logoBusy ? "opacity-50 pointer-events-none" : ""}`}>
                      {branchLogoFile ? "Image chosen ✓" : "Choose image"}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        data-testid={`bizlogo-branch-upload-${bizRow.id}`}
                        disabled={logoBusy}
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) setBranchLogoFile(await logoFileToDataUrl(f));
                        }}
                      />
                    </label>
                    {branchLogoFile && (
                      <img src={branchLogoFile} alt="pending branch logo" className="h-8 w-8 rounded-lg object-contain bg-white p-0.5" data-testid={`bizlogo-branch-pending-${bizRow.id}`} />
                    )}
                    <button
                      onClick={saveBranchLogo}
                      disabled={logoBusy || !branchCode.trim() || !branchLogoFile}
                      data-testid={`bizlogo-branch-save-${bizRow.id}`}
                      className="px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:pointer-events-none text-white text-[11px] font-bold"
                    >
                      Save branch logo
                    </button>
                  </div>
                  <div className="space-y-1.5" data-testid={`bizlogo-branch-list-${bizRow.id}`}>
                    {branchEntries.length === 0 && (
                      <p className="text-[11px] text-slate-500 italic">No branch overrides — every branch uses the business logo.</p>
                    )}
                    {branchEntries.map((code) => (
                      <div key={code} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900/60 border border-slate-700 px-2.5 py-1.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <img src={branchMap[code]} alt={`Branch ${code} logo`} className="h-8 w-8 rounded-lg object-contain bg-white p-0.5 shrink-0" />
                          <span className="text-xs font-mono font-bold text-white">{code}</span>
                          <span className="text-[10px] text-slate-500">documents for this branch use this logo automatically</span>
                        </div>
                        <button
                          onClick={() => removeBranchLogo(code)}
                          disabled={logoBusy}
                          data-testid={`bizlogo-branch-del-${bizRow.id}-${code}`}
                          className="p-1.5 rounded-lg bg-slate-700/70 hover:bg-rose-500/30 text-slate-300 hover:text-rose-300"
                          title="Remove branch logo — falls back to the business logo"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ============ EDIT MODE ============ */}
          {mode === "edit" && selected && (
            <form onSubmit={handleSaveEdit} className="space-y-3" data-testid="manage-biz-form">
              <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/25 p-3 text-[11px] text-indigo-200/90 leading-relaxed">
                Changes apply instantly across <b>inventory, production, sales, customers, orders,
                finance, dashboards and reports</b>. Changing the <b>business type</b> automatically
                provisions the new type's starter stock kit and daily-checklist templates while
                preserving all existing records.
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Business Name (rename)
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Unit Code (fixed identifier)
                  </label>
                  <input
                    type="text"
                    value={selected.code}
                    readOnly
                    className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700/60 rounded-lg text-slate-500 text-sm cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Business Type
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    data-testid="manage-biz-category"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {category !== selected.category && (
                    <p className="text-[10px] text-amber-300 mt-1">
                      Type change: this unit will mount the {category} module; new-type starter
                      stock & checklists will be provisioned automatically.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Operational Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-1 border-t border-slate-800">
                <LocationSelector
                  value={location}
                  onChange={setLocation}
                  compact
                  required
                  headingLabel="Branch Location (Ghana) — change location"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Assigned Branch Manager
                  </label>
                  <input
                    type="text"
                    value={managerName}
                    onChange={(e) => setManagerName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Contact Phone
                  </label>
                  <input
                    type="text"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Initial Capital (GH₵)
                  </label>
                  <input
                    type="number"
                    value={initialCapitalGhs}
                    onChange={(e) => setInitialCapitalGhs(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Monthly Target Revenue (GH₵)
                  </label>
                  <input
                    type="number"
                    value={monthlyTargetRevenueGhs}
                    onChange={(e) => setMonthlyTargetRevenueGhs(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={resetToList}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  data-testid="manage-biz-save"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition disabled:opacity-50"
                >
                  {busy ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          )}

          {/* ============ DELETE MODE ============ */}
          {mode === "delete" && selected && (
            <div className="space-y-4" data-testid="manage-biz-delete-panel">
              <div className="rounded-xl bg-rose-500/10 border border-rose-500/40 p-4">
                <div className="flex items-center gap-2 text-rose-300 font-bold text-sm mb-1">
                  <AlertTriangle className="w-4 h-4" />
                  Permanent deletion — this cannot be undone
                </div>
                <p className="text-[12px] text-rose-200/80 leading-relaxed">
                  Deleting <b>{selected.name}</b> ({selected.code}) removes the unit together with
                  every related record, and all dashboards, finance and reports update immediately.
                  Staff user accounts are preserved (un-assigned). Enterprise suppliers are shared
                  and are not affected.
                </p>
              </div>

              <div
                className="bg-slate-800/70 border border-slate-700 rounded-xl p-4 text-[12px]"
                data-testid="manage-delete-counts"
              >
                <div className="text-xs font-bold text-slate-300 uppercase tracking-wide mb-2">
                  Records that will be permanently removed
                </div>
                {deleteCounts ? (
                  <>
                    {countRow("Inventory / stock items", deleteCounts.groups.inventoryItems)}
                    {countRow("Sales documents & orders", deleteCounts.groups.salesDocuments)}
                    {countRow("Financial transactions", deleteCounts.groups.transactions)}
                    {countRow("Production & operations records", deleteCounts.groups.productionAndOps)}
                    {countRow("Employees", deleteCounts.groups.employees)}
                    {countRow("Customers", deleteCounts.groups.customers)}
                    {countRow("Assets", deleteCounts.groups.assets)}
                    {countRow("Checklist templates & entries", deleteCounts.groups.checklists)}
                    {countRow("Financial metric periods", deleteCounts.groups.metrics)}
                    {countRow("Custom expense categories", deleteCounts.groups.expenseCategories)}
                    {countRow("Export records", deleteCounts.groups.exports)}
                    <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-700">
                      <span className="font-bold text-white">TOTAL RECORDS</span>
                      <span className="font-black text-rose-300">
                        {deleteCounts.totalRecords}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="text-slate-400 text-xs py-2">Counting related records…</div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Type <span className="font-black text-rose-300">{selected.code}</span> to confirm
                  deletion
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={selected.code}
                  data-testid="manage-delete-confirm-input"
                  className="w-full px-3 py-2 bg-slate-800 border border-rose-500/40 rounded-lg text-white text-sm"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-1">
                <button
                  onClick={resetToList}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={busy || confirmText.trim() !== selected.code}
                  data-testid="manage-delete-confirm"
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? "Deleting..." : "Permanently Delete Unit"}
                </button>
              </div>
            </div>
          )}

          {mode === "reset" && selected && (
            <div className="space-y-4" data-testid="manage-reset-panel">
              <div className="rounded-xl bg-cyan-500/10 border border-cyan-500/40 p-4">
                <div className="flex items-center gap-2 text-cyan-300 font-bold text-sm mb-1">
                  <RotateCcw className="w-4 h-4" />
                  Reset to new business state — operational history is wiped
                </div>
                <p className="text-[12px] text-cyan-200/80 leading-relaxed">
                  Resetting <b>{selected.name}</b> ({selected.code}) clears every{" "}
                  <b>sale, stock & inventory item, production record, expense, order and all
                  other activity logs</b>, then re-seeds the exact workspace a brand-new unit
                  receives: <b>zero-based dashboard metrics</b> and the category{" "}
                  <b>starter stock kit</b>. The unit keeps its <b>setup — business type, name,
                  code, location, branches, enterprise suppliers, staff users and master
                  lists</b> — unless you choose to reset those too below. This cannot be undone.
                </p>
              </div>

              <div
                className="bg-slate-800/70 border border-slate-700 rounded-xl p-4 text-[12px]"
                data-testid="manage-reset-counts"
              >
                <div className="text-xs font-bold text-slate-300 uppercase tracking-wide mb-2">
                  Operational records that will be cleared
                </div>
                {resetCounts ? (
                  <>
                    {countRow("Inventory / stock items (replaced by starter kit)", resetCounts.groups.inventoryItems)}
                    {countRow("Sales documents & orders", resetCounts.groups.salesDocuments)}
                    {countRow("Financial transactions", resetCounts.groups.transactions)}
                    {countRow("Production & operations (master products kept unless reset)", resetCounts.groups.productionAndOps)}
                    {countRow("Employees (payroll records)", resetCounts.groups.employees)}
                    {countRow("Customers", resetCounts.groups.customers)}
                    {countRow("Assets", resetCounts.groups.assets)}
                    {countRow("Checklist entries (templates kept unless master reset)", resetCounts.groups.checklists)}
                    {countRow("Financial metric periods", resetCounts.groups.metrics)}
                    {countRow("Custom expense categories", resetCounts.groups.expenseCategories)}
                    {countRow("Export records", resetCounts.groups.exports)}
                    <div className="flex items-center justify-between pt-2 mt-1 border-t border-slate-700">
                      <span className="font-bold text-white">TOTAL OPERATIONAL RECORDS</span>
                      <span className="font-black text-cyan-300">
                        {resetCounts.totalRecords}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="text-slate-400 text-xs py-2">Counting operational records…</div>
                )}
              </div>

              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 space-y-3 text-[12px]">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={resetMasters}
                    onChange={(e) => setResetMasters(e.target.checked)}
                    data-testid="manage-reset-masters"
                    className="mt-0.5 accent-cyan-500"
                  />
                  <span className="text-slate-200">
                    <b className="text-cyan-300">Also reset master lists</b> — product / type
                    catalogs (poultry products, block types, menu items) and daily-checklist
                    templates are wiped and re-seeded to the type defaults.
                  </span>
                </label>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={resetStaffUsers}
                    onChange={(e) => setResetStaffUsers(e.target.checked)}
                    data-testid="manage-reset-users"
                    className="mt-0.5 accent-cyan-500"
                  />
                  <span className="text-slate-200">
                    <b className="text-cyan-300">Also un-assign staff users</b> — user accounts
                    are kept but un-assigned from this unit, ready for re-deployment.
                  </span>
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Type <span className="font-black text-cyan-300">{selected.code}</span> to confirm
                  reset
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={selected.code}
                  data-testid="manage-reset-confirm-input"
                  className="w-full px-3 py-2 bg-slate-800 border border-cyan-500/40 rounded-lg text-white text-sm"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-1">
                <button
                  onClick={resetToList}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={busy || confirmText.trim() !== selected.code}
                  data-testid="manage-reset-confirm"
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? "Resetting..." : "Reset to New Business State"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
