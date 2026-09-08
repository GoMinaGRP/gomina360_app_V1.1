"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Video,
  Camera,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Eye,
  Wifi,
  X,
  Building2,
  MapPin,
  ShieldCheck,
  AlertTriangle,
  CheckCircle,
  Wrench,
  Server,
} from "lucide-react";
import AiSectionGuide from "./AiSectionGuide";

/**
 * CCTV Security Command — Integration Hub sub-module.
 *
 * Organised strictly as Business → Branch → Cameras. The OWNER sees and
 * manages every camera; managers see only cameras inside their accessible
 * businesses and can manage them only while the OWNER's canManageCctv grant
 * is active. Includes a data-driven live monitor (the Hub's 24/7 viewer),
 * an add/edit form covering name, location, brand, type, model and full
 * connection details (PoE/RTSP, ONVIF, Wi-Fi, Cloud P2P, Coax, NVR/DVR),
 * a connection test with operator-readable results, and inline removal.
 */

const BRANDS = [
  ["HIKVISION", "Hikvision"],
  ["DAHUA", "Dahua"],
  ["UNIVIEW", "Uniview (UNV)"],
  ["AXIS", "Axis"],
  ["REOLINK", "Reolink"],
  ["TP_LINK_VIGI", "TP-Link VIGI"],
  ["EZVIZ", "EZVIZ"],
  ["ANNKE", "Annke"],
  ["OTHER", "Other / Generic"],
];

const CAMERA_TYPES = [
  ["IP_CAMERA", "IP Camera (Bullet/Dome)"],
  ["PTZ_IP_CAMERA", "PTZ IP Camera"],
  ["WIFI_CAMERA", "Wi-Fi Camera"],
  ["NVR_SYSTEM", "NVR System (Network Video Recorder)"],
  ["DVR_SYSTEM", "DVR System (Digital Video Recorder)"],
  ["NVR_CHANNEL", "Camera via NVR Channel"],
  ["DVR_CHANNEL", "Camera via DVR Channel"],
  ["ANALOG_CAMERA", "Analog Camera (Coax)"],
];

const CONNECTION_TYPES = [
  ["POE_RTSP", "PoE + RTSP Stream"],
  ["ONVIF", "ONVIF Protocol"],
  ["WIFI", "Wi-Fi"],
  ["CLOUD_P2P", "Cloud P2P (App ID)"],
  ["COAXIAL_BNC", "Coaxial / BNC"],
  ["NVR_CHANNEL", "NVR Channel"],
  ["DVR_CHANNEL", "DVR Channel"],
];

const label = (pairs: string[][], v: string) =>
  pairs.find(([k]) => k === v)?.[1] || v;

const STATUS_STYLE: Record<string, string> = {
  ONLINE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  OFFLINE: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  MAINTENANCE: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

const EMPTY_FORM: any = {
  businessId: "",
  branchCode: "",
  name: "",
  location: "",
  brand: "HIKVISION",
  cameraType: "IP_CAMERA",
  model: "",
  connectionType: "POE_RTSP",
  host: "",
  port: "",
  streamUrl: "",
  username: "",
  password: "",
  snapshotUrl: "",
  status: "ONLINE",
  notes: "",
};

interface Props {
  currentUser: any;
  businesses: any[];
  onClose: () => void;
}

export default function CctvCommandCenter({ currentUser, businesses, onClose }: Props) {
  const [cameras, setCameras] = useState<any[]>([]);
  const [scope, setScope] = useState<{ isOwner: boolean; canManage: boolean; businessIds: number[] | null }>({
    isOwner: false,
    canManage: false,
    businessIds: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeOk, setNoticeOk] = useState(true);
  const [selBusiness, setSelBusiness] = useState<number | "ALL">("ALL");
  const [selBranch, setSelBranch] = useState<string>("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState<any>(EMPTY_FORM);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [monitorCam, setMonitorCam] = useState<any | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cctv");
      const d = await res.json();
      if (d?.success) {
        setCameras(d.cameras || []);
        setScope(d.scope);
      } else {
        setError(d?.error || "Failed to load cameras.");
      }
    } catch (e: any) {
      setError(e?.message || "Network error.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const scopedBusinesses = useMemo(() => {
    const list = scope.businessIds === null && scope.isOwner
      ? businesses
      : businesses.filter((b) => (scope.businessIds ?? []).includes(b.id));
    return [...list].sort((a, b) => a.id - b.id);
  }, [businesses, scope]);

  const canManageBusiness = (businessId: number) =>
    scope.isOwner || (scope.canManage && (scope.businessIds ?? []).includes(businessId));

  // Business → Branch grouping with camera counts (from the scoped list).
  const tree = useMemo(() => {
    const byBiz = new Map<number, Map<string, any[]>>();
    for (const c of cameras) {
      if (!byBiz.has(c.businessId)) byBiz.set(c.businessId, new Map());
      const branches = byBiz.get(c.businessId)!;
      const key = c.branchCode || "—";
      if (!branches.has(key)) branches.set(key, []);
      branches.get(key)!.push(c);
    }
    return byBiz;
  }, [cameras]);

  const visible = cameras.filter(
    (c) =>
      (selBusiness === "ALL" || c.businessId === selBusiness) &&
      (selBranch === "ALL" || (c.branchCode || "") === selBranch)
  );

  const setF = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const openAdd = (presetBiz?: number) => {
    const bizId = presetBiz ?? (selBusiness !== "ALL" ? Number(selBusiness) : scopedBusinesses[0]?.id) ?? "";
    const biz = scopedBusinesses.find((b) => b.id === Number(bizId));
    setEditing(null);
    setForm({ ...EMPTY_FORM, businessId: bizId, branchCode: biz?.code || "" });
    setFormErr("");
    setFormOpen(true);
  };

  const openEdit = (c: any) => {
    setEditing(c);
    setForm({
      businessId: c.businessId,
      branchCode: c.branchCode || "",
      name: c.name || "",
      location: c.location || "",
      brand: c.brand || "HIKVISION",
      cameraType: c.cameraType || "IP_CAMERA",
      model: c.model || "",
      connectionType: c.connectionType || "POE_RTSP",
      host: c.host || "",
      port: c.port ?? "",
      streamUrl: c.streamUrl || "",
      username: c.username || "",
      password: "", // blank keeps the stored credential
      snapshotUrl: c.snapshotUrl || "",
      status: c.status || "ONLINE",
      notes: c.notes || "",
    });
    setFormErr("");
    setFormOpen(true);
  };

  const onPickBusiness = (id: string) => {
    const biz = scopedBusinesses.find((b) => b.id === Number(id));
    setForm((f: any) => ({ ...f, businessId: id, branchCode: biz?.code || "" }));
  };

  const saveForm = async () => {
    if (!form.businessId) return setFormErr("Choose the business this camera belongs to.");
    if (!form.name.trim()) return setFormErr("Camera name is required.");
    if (!form.location.trim()) return setFormErr("Location is required.");
    setBusy(true);
    setFormErr("");
    try {
      const payload = {
        ...form,
        port: form.port === "" ? null : Number(form.port),
        branchCode: form.branchCode?.trim(),
      };
      const res = editing
        ? await fetch("/api/cctv", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: editing.id, ...payload }),
          })
        : await fetch("/api/cctv", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: payload }),
          });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setNoticeOk(true);
        setNotice(editing ? `Camera "${d.camera.name}" updated.` : `Camera "${d.camera.name}" registered to ${d.camera.branchName || d.camera.branchCode}.`);
        setFormOpen(false);
        await load();
      } else {
        setFormErr(d?.error || "Failed to save the camera.");
      }
    } catch (e: any) {
      setFormErr(e?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const testCamera = async (id: number) => {
    setTestingId(id);
    setNotice("");
    try {
      const res = await fetch("/api/cctv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "TEST_CONNECTION" }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setNoticeOk(!!d.ok);
        setNotice(d.detail);
        await load();
      } else {
        setNoticeOk(false);
        setNotice(d?.error || "Test failed to run.");
      }
    } catch (e: any) {
      setNoticeOk(false);
      setNotice(e?.message || "Network error.");
    } finally {
      setTestingId(null);
    }
  };

  const removeCamera = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch("/api/cctv", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        setNoticeOk(true);
        setNotice(`Camera "${d.removed}" removed from the registry.`);
        setConfirmDel(null);
        await load();
      } else {
        setNoticeOk(false);
        setNotice(d?.error || "Failed to remove the camera.");
        setConfirmDel(null);
      }
    } catch (e: any) {
      setNoticeOk(false);
      setNotice(e?.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-rose-500";
  const labelCls = "block text-[11px] font-semibold text-slate-400 mb-1";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-5"
      data-testid="cctv-modal"
    >
      <div className="bg-slate-950 border border-slate-700 rounded-2xl w-full max-w-6xl shadow-2xl flex flex-col max-h-[94vh] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/80 flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 flex items-center justify-center text-white shadow-lg shrink-0">
            <Video className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              CCTV Security Command
              <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/30" data-testid="cctv-count">
                {cameras.length} CAMERA{cameras.length === 1 ? "" : "S"}
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Business → Branch → Cameras • owner manages all; managers manage only authorised branches
            </p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <AiSectionGuide moduleKey="CCTV" section="DEFAULT" variant="header" />
            <button
              onClick={load}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              title="Refresh"
              data-testid="cctv-refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            {scope.canManage && (
              <button
                onClick={() => openAdd()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow transition"
                data-testid="cctv-add-open"
              >
                <Plus className="w-4 h-4" /> Add Camera
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
              aria-label="Close"
              data-testid="cctv-close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notices */}
        {notice && (
          <div
            className={`mx-5 mt-3 px-3 py-2 rounded-lg text-xs border ${
              noticeOk
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                : "bg-rose-500/10 border-rose-500/30 text-rose-300"
            }`}
            data-testid="cctv-notice"
          >
            {notice}
          </div>
        )}
        {error && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300" data-testid="cctv-error">
            {error}
          </div>
        )}

        {/* Body: rail + grid */}
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row" >
          {/* Business → Branch rail */}
          <aside className="md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-slate-800 overflow-y-auto p-3 space-y-1" data-testid="cctv-rail">
            <button
              onClick={() => { setSelBusiness("ALL"); setSelBranch("ALL"); }}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition ${
                selBusiness === "ALL" ? "bg-rose-600 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
              data-testid="cctv-biz-ALL"
            >
              All Businesses ({cameras.length})
            </button>
            {scopedBusinesses.map((b) => {
              const branches = tree.get(b.id) || new Map<string, any[]>();
              const total = [...branches.values()].reduce((s, arr) => s + arr.length, 0);
              const active = selBusiness === b.id;
              return (
                <div key={b.id}>
                  <button
                    onClick={() => { setSelBusiness(b.id); setSelBranch("ALL"); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-between transition ${
                      active ? "bg-rose-600/90 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                    }`}
                    data-testid={`cctv-biz-${b.id}`}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Building2 className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{b.name}</span>
                    </span>
                    <span className="text-[10px] opacity-80">{total}</span>
                  </button>
                  {active && branches.size > 0 && (
                    <div className="ml-4 mt-1 space-y-1">
                      {[...branches.entries()].map(([code, arr]) => (
                        <button
                          key={code}
                          onClick={() => setSelBranch(code)}
                          className={`w-full text-left px-2.5 py-1.5 rounded-md text-[11px] font-mono flex items-center justify-between transition ${
                            selBranch === code ? "bg-cyan-600/30 text-cyan-200 border border-cyan-500/40" : "text-slate-400 hover:bg-slate-800/70"
                          }`}
                          data-testid={`cctv-branch-${code}`}
                        >
                          <span>{code}</span>
                          <span className="text-[10px]">{arr.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </aside>

          {/* Camera grid */}
          <div className="flex-1 overflow-y-auto p-4" data-testid="cctv-grid">
            {loading && cameras.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-16">Loading cameras…</div>
            ) : visible.length === 0 ? (
              <div className="text-center py-16 space-y-3" data-testid="cctv-empty">
                <Camera className="w-10 h-10 text-slate-600 mx-auto" />
                <p className="text-slate-400 text-sm">No cameras registered in this scope yet.</p>
                {scope.canManage && (
                  <button
                    onClick={() => openAdd(selBusiness === "ALL" ? undefined : Number(selBusiness))}
                    className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition"
                  >
                    <Plus className="w-3.5 h-3.5 inline mr-1" /> Register the first camera
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {visible.map((c) => {
                  const manageable = canManageBusiness(c.businessId);
                  const biz = businesses.find((b) => b.id === c.businessId);
                  return (
                    <div
                      key={c.id}
                      className="bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden shadow-lg flex flex-col"
                      data-testid={`cctv-card-${c.id}`}
                    >
                      <div className="relative h-36 bg-slate-800 flex items-center justify-center overflow-hidden">
                        {c.snapshotUrl ? (
                          <img src={c.snapshotUrl} alt={c.name} className="w-full h-full object-cover" />
                        ) : (
                          <Camera className="w-10 h-10 text-slate-600" />
                        )}
                        <span className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-bold border ${STATUS_STYLE[c.status] || STATUS_STYLE.OFFLINE}`}>
                          {c.status}
                        </span>
                        <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 text-[10px] font-mono text-cyan-300 border border-cyan-500/20">
                          {c.branchCode}
                        </span>
                      </div>
                      <div className="p-3.5 space-y-2 flex-1">
                        <div>
                          <h4 className="text-sm font-bold text-white">{c.name}</h4>
                          <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3" /> {c.location} • {biz?.name || `Business #${c.businessId}`}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-200">
                            {label(BRANDS, c.brand)}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-300">
                            {label(CAMERA_TYPES, c.cameraType)}
                          </span>
                          {c.model && (
                            <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-300">
                              {c.model}
                            </span>
                          )}
                        </div>
                        <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800 text-[10px] font-mono text-slate-400 space-y-0.5">
                          <div className="flex items-center gap-1">
                            <Wifi className="w-3 h-3 text-cyan-400" />
                            <span>{label(CONNECTION_TYPES, c.connectionType)}</span>
                          </div>
                          {c.streamUrl ? <div className="truncate">stream: {c.streamUrl}</div> : null}
                          {(c.host || c.port) && (
                            <div>endpoint: {c.host || "—"}{c.port ? `:${c.port}` : ""}{c.username ? ` • user ${c.username}` : ""}{c.hasCredentials ? " • password stored ✓" : ""}</div>
                          )}
                        </div>
                        {c.lastTestResult && (
                          <p className={`text-[10px] flex items-start gap-1 ${c.status === "ONLINE" ? "text-emerald-400/90" : "text-rose-400/90"}`}>
                            {c.status === "ONLINE" ? <CheckCircle className="w-3 h-3 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />}
                            <span className="line-clamp-2">{c.lastTestAt ? new Date(c.lastTestAt).toLocaleString() + " — " : ""}{c.lastTestResult}</span>
                          </p>
                        )}
                      </div>
                      <div className="px-3.5 pb-3 flex items-center gap-1.5 flex-wrap">
                        <button
                          onClick={() => setMonitorCam(c)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold transition"
                          data-testid={`cctv-monitor-${c.id}`}
                        >
                          <Eye className="w-3.5 h-3.5" /> Monitor
                        </button>
                        {manageable && (
                          <>
                            <button
                              onClick={() => testCamera(c.id)}
                              disabled={testingId === c.id}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-300 border border-cyan-500/30 text-[11px] font-bold transition disabled:opacity-50"
                              data-testid={`cctv-test-${c.id}`}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${testingId === c.id ? "animate-spin" : ""}`} />
                              {testingId === c.id ? "Testing…" : "Test"}
                            </button>
                            <button
                              onClick={() => openEdit(c)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold transition"
                              data-testid={`cctv-edit-${c.id}`}
                            >
                              <Pencil className="w-3.5 h-3.5" /> Edit
                            </button>
                            {confirmDel === c.id ? (
                              <>
                                <button
                                  onClick={() => removeCamera(c.id)}
                                  disabled={busy}
                                  className="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold transition"
                                  data-testid={`cctv-del-confirm-${c.id}`}
                                >
                                  Confirm remove?
                                </button>
                                <button
                                  onClick={() => setConfirmDel(null)}
                                  className="px-2 py-1.5 rounded-lg bg-slate-800 text-slate-400 text-[11px] transition"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => setConfirmDel(c.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-[11px] font-semibold transition"
                                data-testid={`cctv-del-${c.id}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Remove
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Add / Edit form ─────────────────────────────────────────────── */}
      {formOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-lg shadow-2xl max-h-[92vh] overflow-y-auto space-y-4" data-testid="cctv-form">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="text-base font-bold text-white flex items-center gap-2">
                <Camera className="w-4 h-4 text-rose-400" />
                {editing ? `Edit — ${editing.name}` : "Register CCTV Camera"}
              </h4>
              <button onClick={() => setFormOpen(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white" data-testid="cctv-cancel">
                <X className="w-4 h-4" />
              </button>
            </div>

            {formErr && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 p-2.5 rounded-lg text-xs" data-testid="cctv-form-error">
                {formErr}
              </div>
            )}

            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-bold text-rose-300 uppercase tracking-wider">
                <Building2 className="w-3.5 h-3.5" /> Business & Branch (Required)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Business <span className="text-rose-400">*</span></label>
                  <select
                    className={inputCls}
                    value={form.businessId}
                    onChange={(e) => onPickBusiness(e.target.value)}
                    data-testid="cctv-business-select"
                  >
                    <option value="">Select business…</option>
                    {scopedBusinesses.map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Branch / Register <span className="text-rose-400">*</span></label>
                  <input
                    className={`${inputCls} font-mono`}
                    value={form.branchCode}
                    onChange={(e) => setF("branchCode", e.target.value.toUpperCase())}
                    placeholder="e.g. POULTRY-01"
                    data-testid="cctv-branch-input"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className={labelCls}>Camera Name <span className="text-rose-400">*</span></label>
                <input className={inputCls} value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="e.g. Yard & Feed Storage Camera" data-testid="cctv-name" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Location <span className="text-rose-400">*</span></label>
                <input className={inputCls} value={form.location} onChange={(e) => setF("location", e.target.value)} placeholder="e.g. Main gate, 4m pole facing north yard" data-testid="cctv-location" />
              </div>
              <div>
                <label className={labelCls}>Brand <span className="text-rose-400">*</span></label>
                <select className={inputCls} value={form.brand} onChange={(e) => setF("brand", e.target.value)} data-testid="cctv-brand">
                  {BRANDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Camera Type <span className="text-rose-400">*</span></label>
                <select className={inputCls} value={form.cameraType} onChange={(e) => setF("cameraType", e.target.value)} data-testid="cctv-type">
                  {CAMERA_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Model</label>
                <input className={inputCls} value={form.model} onChange={(e) => setF("model", e.target.value)} placeholder="e.g. DS-2CD2T43G2-4I" data-testid="cctv-model" />
              </div>
            </div>

            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-bold text-cyan-300 uppercase tracking-wider">
                <Server className="w-3.5 h-3.5" /> Connection Details
              </div>
              <div>
                <label className={labelCls}>Connection Type <span className="text-rose-400">*</span></label>
                <select className={inputCls} value={form.connectionType} onChange={(e) => setF("connectionType", e.target.value)} data-testid="cctv-conn">
                  {CONNECTION_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Host / IP / Cloud ID</label>
                  <input className={`${inputCls} font-mono`} value={form.host} onChange={(e) => setF("host", e.target.value)} placeholder="192.168.1.64" data-testid="cctv-host" />
                </div>
                <div>
                  <label className={labelCls}>Port</label>
                  <input className={`${inputCls} font-mono`} type="number" value={form.port} onChange={(e) => setF("port", e.target.value)} placeholder="554" data-testid="cctv-port" />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>Stream URL (RTSP/HTTP, if known)</label>
                  <input className={`${inputCls} font-mono`} value={form.streamUrl} onChange={(e) => setF("streamUrl", e.target.value)} placeholder="rtsp://192.168.1.64:554/Streaming/Channels/101" data-testid="cctv-url" />
                </div>
                <div>
                  <label className={labelCls}>Username</label>
                  <input className={`${inputCls} font-mono`} value={form.username} onChange={(e) => setF("username", e.target.value)} placeholder="admin" data-testid="cctv-user" />
                </div>
                <div>
                  <label className={labelCls}>Password {editing ? "(blank keeps current)" : ""}</label>
                  <input className={`${inputCls} font-mono`} type="password" value={form.password} onChange={(e) => setF("password", e.target.value)} placeholder={editing ? "••••••••" : "device password"} data-testid="cctv-pass" />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Status</label>
                <select className={inputCls} value={form.status} onChange={(e) => setF("status", e.target.value)} data-testid="cctv-status">
                  <option value="ONLINE">Online</option>
                  <option value="OFFLINE">Offline</option>
                  <option value="MAINTENANCE">Maintenance</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Preview Image URL (optional)</label>
                <input className={`${inputCls} font-mono`} value={form.snapshotUrl} onChange={(e) => setF("snapshotUrl", e.target.value)} placeholder="https://…" data-testid="cctv-snapshot" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Notes</label>
                <textarea className={`${inputCls} h-16 resize-none`} value={form.notes} onChange={(e) => setF("notes", e.target.value)} placeholder="Install notes, recording schedule, maintenance hints…" data-testid="cctv-notes" />
              </div>
            </div>

            <button
              onClick={saveForm}
              disabled={busy}
              className="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm shadow transition disabled:opacity-50"
              data-testid="cctv-save"
            >
              {busy ? "Saving…" : editing ? "Save Changes" : "Register Camera"}
            </button>
          </div>
        </div>
      )}

      {/* ── Live Monitor (data-driven successor of the Hub's 24/7 viewer) ── */}
      {monitorCam && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden w-full max-w-4xl shadow-2xl" data-testid="cctv-monitor">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center space-x-2.5">
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></div>
                <h4 className="text-sm font-bold text-white">
                  {label(BRANDS, monitorCam.brand)} Live Monitor — {monitorCam.branchCode}
                </h4>
                <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/30">LIVE</span>
              </div>
              <button
                onClick={() => setMonitorCam(null)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                data-testid="cctv-monitor-close"
              >
                Close Monitor
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="relative rounded-xl overflow-hidden border-2 border-slate-700 bg-black aspect-video max-h-[400px] mx-auto flex items-center justify-center">
                {monitorCam.snapshotUrl ? (
                  <img src={monitorCam.snapshotUrl} alt={monitorCam.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="text-center text-slate-500 space-y-2">
                    <Camera className="w-12 h-12 mx-auto" />
                    <p className="text-xs">No preview frame stored for this camera</p>
                  </div>
                )}
                <div className="absolute top-3 left-3 flex items-center space-x-2 bg-black/75 backdrop-blur-sm px-3 py-1 rounded-lg border border-white/10">
                  <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></div>
                  <span className="text-xs font-bold text-white">{monitorCam.name}</span>
                </div>
                <div className="absolute bottom-3 right-3 bg-black/75 backdrop-blur-sm px-3 py-1 rounded-lg text-[11px] font-mono text-emerald-400 border border-emerald-500/30">
                  {label(CONNECTION_TYPES, monitorCam.connectionType)} • {monitorCam.status}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {visible.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setMonitorCam(c)}
                    className={`p-2 rounded-lg border text-left transition ${
                      monitorCam.id === c.id
                        ? "bg-slate-800 border-rose-500 ring-2 ring-rose-500/30"
                        : "bg-slate-900 border-slate-700 hover:bg-slate-800"
                    }`}
                    data-testid={`cctv-thumb-${c.id}`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-200">
                      <span className={c.status === "ONLINE" ? "text-emerald-400" : "text-rose-400"}>{c.status}</span>
                      <span className="text-rose-400 font-mono">REC</span>
                    </div>
                    <div className="text-[11px] font-semibold text-white mt-0.5 truncate">{c.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{c.branchCode}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
