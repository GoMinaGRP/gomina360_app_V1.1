"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AiSectionGuide from "./AiSectionGuide";
import {
  Truck, Users, Route, CalendarClock, Fuel, Wrench, ShieldAlert, ClipboardList,
  BarChart3, LayoutDashboard, MapPin, X, Plus, CheckCircle2, AlertTriangle,
  RefreshCw, Gauge, Navigation, Radio, CircleDot, Shield, Satellite, KeyRound,
  PlayCircle, StopCircle, ChevronRight, FileWarning, Clock, Landmark,
} from "lucide-react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis,
  AreaChart, Area, CartesianGrid,
} from "recharts";
import { CurrencyCode, formatMoney } from "@/lib/currency";

type Props = {
  currentUser: any;
  businessInfo: any;
  businessMetrics: any;
  inventory: any[];
  customers: any[];
  transactions: any[];
  assets: any[];
  employees: any[];
  currentCurrency: CurrencyCode;
  onRefreshData: () => void;
};

type Tab =
  | "DASHBOARD" | "FLEET" | "DRIVERS" | "TRIPS" | "BOOKINGS" | "FUEL"
  | "MAINTENANCE" | "GPS" | "COMPLIANCE" | "CHECKLIST" | "REPORTS";

type FormType = null | "VEHICLE" | "TRIP" | "BOOKING" | "FUEL" | "MAINT" | "CHECKLIST" | "GEOFENCE";

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: "DASHBOARD", label: "Dashboard", icon: LayoutDashboard },
  { key: "FLEET", label: "Fleet", icon: Truck },
  { key: "DRIVERS", label: "Drivers", icon: Users },
  { key: "TRIPS", label: "Trips & Routes", icon: Route },
  { key: "BOOKINGS", label: "Bookings", icon: CalendarClock },
  { key: "FUEL", label: "Fuel", icon: Fuel },
  { key: "MAINTENANCE", label: "Maintenance", icon: Wrench },
  { key: "GPS", label: "Live GPS", icon: Satellite },
  { key: "COMPLIANCE", label: "Safety & Alerts", icon: ShieldAlert },
  { key: "CHECKLIST", label: "Daily Checklist", icon: ClipboardList },
  { key: "REPORTS", label: "Reports & AI", icon: BarChart3 },
];

const VEHICLE_TYPES = ["TRUCK", "VAN", "CAR", "MOTORCYCLE", "MINIBUS", "TANKER", "TRICYCLE", "BUS", "EXCAVATOR", "PICKUP"];
const FUEL_TYPES = ["DIESEL", "PETROL", "LPG", "ELECTRIC"];
const MAINT_CATEGORIES = ["PREVENTIVE", "REPAIR", "INSPECTION", "TIRES", "BODYWORK", "ELECTRICAL", "OTHER"];
const TRIP_PURPOSES = ["DELIVERY", "PASSENGER", "HAULAGE", "PICKUP", "FIELD", "OTHER"];
const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  MAINTENANCE: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  OUT_OF_SERVICE: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  PLANNED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  EN_ROUTE: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  CANCELLED: "bg-slate-500/15 text-slate-400 border-slate-600",
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  CONFIRMED: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  IN_PROGRESS: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  DUE: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  IN_WORKSHOP: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  DONE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  UNRESOLVED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  ACKNOWLEDGED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  RESOLVED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};
const SEV_STYLE: Record<string, string> = {
  CRITICAL: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  HIGH: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  MEDIUM: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  LOW: "bg-slate-500/15 text-slate-400 border-slate-600",
};
const PIE_COLORS = ["#34d399", "#fbbf24", "#a78bfa", "#f87171", "#38bdf8"];

const CHECK_ITEMS: { key: string; label: string; critical?: boolean }[] = [
  { key: "lightsOk", label: "Lights & indicators", critical: true },
  { key: "brakesOk", label: "Brakes", critical: true },
  { key: "tyresOk", label: "Tyres & pressure", critical: true },
  { key: "oilOk", label: "Engine oil level", critical: true },
  { key: "coolantOk", label: "Coolant level" },
  { key: "beltsOk", label: "Belts & hoses" },
  { key: "mirrorsOk", label: "Mirrors & glass" },
  { key: "hornOk", label: "Horn" },
  { key: "fireExtinguisherOk", label: "Fire extinguisher" },
  { key: "firstAidOk", label: "First-aid kit" },
  { key: "documentationOk", label: "Documents aboard" },
  { key: "cleaningOk", label: "Cab & cargo clean" },
];

function Badge({ text, map = STATUS_STYLE }: { text: string; map?: Record<string, string> }) {
  const cls = map[String(text || "").toUpperCase()] || "bg-slate-500/15 text-slate-400 border-slate-600";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${cls}`}>{String(text || "—").replace(/_/g, " ")}</span>;
}
function Tile({ label, value, sub, icon: Icon, tone = "text-emerald-300" }: any) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        {Icon ? <Icon className={`h-4 w-4 ${tone}`} /> : null}
      </div>
      <p className="mt-1 text-lg font-black text-white sm:text-xl">{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p> : null}
    </div>
  );
}
const Field = ({ label, children, span }: any) => (
  <label className={`block ${span ? "sm:col-span-2" : ""}`}>
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
    {children}
  </label>
);
const inp = "w-full rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none";

export default function TransportModule(props: Props) {
  const { currentUser, businessInfo, currentCurrency, onRefreshData } = props;
  const bizId = Number(businessInfo?.id);
  const money = useCallback((n: any) => formatMoney(Number(n) || 0, currentCurrency), [currentCurrency]);

  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [data, setData] = useState<any>(null);
  const [live, setLive] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormType>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [gpsVehicle, setGpsVehicle] = useState<number | null>(null);
  const [secretBox, setSecretBox] = useState<{ secret: string; deviceId: string } | null>(null);
  const noticeT = useRef<any>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    if (noticeT.current) clearTimeout(noticeT.current);
    noticeT.current = setTimeout(() => setNotice(null), 4000);
  };

  const load = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch(`/api/transport?businessId=${bizId}`, { cache: "no-store" }),
        fetch(`/api/transport/trackers?businessId=${bizId}`, { cache: "no-store" }),
      ]);
      const j1 = await r1.json();
      if (!j1.success) { setError(j1.error || "Failed to load transport module"); return; }
      setData(j1);
      setError(null);
      const j2 = await r2.json().catch(() => null);
      if (j2?.success) setLive(j2);
    } catch (e: any) {
      setError(e.message || "Network error");
    } finally {
      setLoading(false);
    }
  }, [bizId]);
  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    if (tab !== "GPS") return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [tab, load]);

  const post = useCallback(async (body: any, url = "/api/transport") => {
    setSaving(true);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ businessId: bizId, ...body }) });
    const j = await res.json().catch(() => ({ success: false, error: "Bad response" }));
    setSaving(false);
    if (!j.success) { flash(`⚠ ${j.error || "Failed"}`); return j; }
    return j;
  }, [bizId]);
  const patchFx = useCallback(async (body: any) => {
    setSaving(true);
    const res = await fetch("/api/transport", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ businessId: bizId, ...body }) });
    const j = await res.json().catch(() => ({ success: false, error: "Bad response" }));
    setSaving(false);
    if (!j.success) { flash(`⚠ ${j.error || "Failed"}`); }
    return j;
  }, [bizId]);

  const done = useCallback((msg: string) => { setForm(null); setDraft({}); flash(msg); load(); onRefreshData(); }, [load, onRefreshData]);

  const M = data?.metrics || {};
  const vehicles: any[] = data?.vehicles || [];
  const drivers: any[] = data?.drivers || props.employees || [];
  const trips: any[] = useMemo(() => [...(data?.trips || [])].sort((a, b) => (b.id || 0) - (a.id || 0)), [data]);
  const bookings: any[] = useMemo(() => [...(data?.bookings || [])].sort((a, b) => (b.id || 0) - (a.id || 0)), [data]);
  const fuels: any[] = useMemo(() => [...(data?.fuelLogs || [])].sort((a, b) => String(b.loggedDate).localeCompare(String(a.loggedDate))), [data]);
  const maint: any[] = data?.maintenance || [];
  const checks: any[] = data?.checklists || [];
  const fences: any[] = data?.geofences || [];
  const violations: any[] = data?.violations || [];
  const insights: any[] = data?.insights || [];
  const byVehicle = data?.utilizationByVehicle || {};
  const canEdit = ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER", "MANAGER"].includes(String(currentUser?.role || "").toUpperCase());
  const vehById = useCallback((id: any) => vehicles.find((v) => v.id === Number(id)), [vehicles]);

  // expiry radar for compliance
  const expiries = useMemo(() => {
    const rows: { vehicle: any; kind: string; date: string; days: number }[] = [];
    const today = Date.now();
    for (const v of vehicles) {
      for (const [kind, d] of [["Insurance", v.insuranceExpiry], ["Roadworthy", v.roadworthyExpiry], ["License", v.licenseExpiry], ["Fitness", v.fitnessExpiry]] as const) {
        if (!d) continue;
        const days = Math.floor((new Date(String(d)).getTime() - today) / 86400000);
        rows.push({ vehicle: v, kind, date: String(d), days });
      }
    }
    return rows.sort((a, b) => a.days - b.days);
  }, [vehicles]);

  const fuelTrend = useMemo(() => {
    const m: Record<string, { date: string; spend: number; liters: number }> = {};
    for (const f of fuels) {
      const k = String(f.loggedDate || "").slice(0, 10);
      if (!k) continue;
      m[k] ||= { date: k, spend: 0, liters: 0 };
      m[k].spend += Number(f.totalGhs || 0);
      m[k].liters += Number(f.quantityLiters || 0);
    }
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [fuels]);

  const expenseSplit = useMemo(() => ([
    { name: "Fuel", value: Number(M.fuelSpendGhs || 0) },
    { name: "Maintenance", value: Number(M.maintenanceSpendGhs || 0) },
    { name: "Other", value: Math.max(0, Number(M.expensesGhs || 0) - Number(M.fuelSpendGhs || 0) - Number(M.maintenanceSpendGhs || 0)) },
  ].filter((x) => x.value > 0)), [M]);

  const liveById: Record<number, any> = useMemo(() => {
    const m: Record<number, any> = {};
    for (const v of live?.vehicles || []) m[Number(v.id)] = v;
    return m;
  }, [live]);

  const selectedLive = gpsVehicle != null ? liveById[gpsVehicle] : null;

  /* ── submit handlers ─────────────────────────────────────────────── */
  const submitVehicle = async () => {
    const j = await post({ entity: "VEHICLE", action: "CREATE", ...draft });
    if (j.success) done(`✓ Vehicle ${j.vehicle?.licensePlate} registered & linked to Assets`);
  };
  const submitTrip = async () => {
    const j = await post({ entity: "TRIP", action: "CREATE", ...draft });
    if (j.success) done(`✓ Trip ${j.trip?.source || "?"} → ${j.trip?.destination || "?"} created`);
  };
  const submitBooking = async () => {
    const j = await post({ entity: "BOOKING", action: "CREATE", ...draft });
    if (j.success) done(`✓ Booking for ${j.booking?.customerName} created`);
  };
  const submitFuel = async () => {
    const j = await post({ entity: "FUEL", action: "LOG", ...draft });
    if (j.success) done(`✓ Fuel logged (${money(j.transaction?.amountGhs ?? j.fuelLog?.totalGhs)} → Expenses)`);
  };
  const submitMaint = async () => {
    const j = await post({ entity: "MAINTENANCE", action: "CREATE", ...draft });
    if (j.success) done(`✓ Maintenance · ${j.maintenance?.title}`);
  };
  const submitChecklist = async () => {
    const j = await post({ entity: "CHECKLIST", action: "SUBMIT", ...draft });
    if (j.success) done(`✓ Daily checklist submitted for ${vehById(draft.vehicleId)?.licensePlate || "vehicle"}`);
  };
  const submitGeofence = async () => {
    const j = await patchFx({ entity: "GEOFENCE", action: "CREATE", ...draft });
    if (j.success) done(`✓ Geofence “${j.geofence?.name}” armed`);
  };
  const registerTracker = async (vehicleId: number) => {
    const providerKey = draft[`prov_${vehicleId}`] || "SIMULATED";
    const j = await post({ action: "REGISTER", vehicleId, providerKey, deviceImei: draft[`imei_${vehicleId}`] || undefined }, "/api/transport/trackers");
    if (j.success) {
      setSecretBox({ secret: j.deviceSecret, deviceId: j.deviceId });
      flash(`✓ Tracker registered (${j.provider?.label || providerKey})`);
      load();
    }
  };
  const simulate = async (vehicleId: number, opts: any = {}) => {
    const j = await post({ action: "SIMULATE", vehicleId, steps: 8, ...opts }, "/api/transport/trackers");
    if (j.success) { flash(`✓ Simulated ${j.accepted} positions`); load(); }
  };
  const tripAct = async (id: number, action: string, extra: any = {}) => {
    const j = await post({ entity: "TRIP", action, id, ...extra });
    if (j.success) done(`✓ Trip ${action.toLowerCase()}`);
  };
  const bookingAct = async (id: number, action: string, extra: any = {}) => {
    const j = await post({ entity: "BOOKING", action, id, ...extra });
    if (j.success) done(`✓ Booking ${action.toLowerCase()}`);
  };
  const maintAct = async (id: number, action: string, extra: any = {}) => {
    const j = await post({ entity: "MAINTENANCE", action, id, ...extra });
    if (j.success) done(`✓ Maintenance ${action.toLowerCase()}`);
  };

  /* ═══════════════════ RENDER ═══════════════════ */
  const Modal = ({ title, onSubmit, submitLabel = "Save", children }: any) => (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" data-testid="transport-modal">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-800 p-4 shadow-2xl sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <button onClick={() => setForm(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-white" data-testid="transport-modal-close"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => setForm(null)} className="rounded-lg border border-slate-600 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700">Cancel</button>
          <button onClick={onSubmit} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50" data-testid="transport-modal-submit">
            {saving ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );

  const VehicleSelect = ({ value, onChange, onlyActive = false }: any) => (
    <select className={inp} value={value || ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)} data-testid="transport-vehicle-select">
      <option value="">Select vehicle…</option>
      {vehicles.filter((v) => !onlyActive || v.status === "ACTIVE").map((v) => (
        <option key={v.id} value={v.id}>{v.licensePlate} — {v.name}</option>
      ))}
    </select>
  );

  const rowCls = "rounded-xl border border-slate-700/60 bg-slate-800/60 p-3";

  return (
    <div className="min-h-screen bg-slate-900 px-3 pb-24 pt-4 text-slate-100 sm:px-6" data-testid="transport-module">
      <header className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-black text-white sm:text-2xl">
              <Truck className="h-6 w-6 text-sky-400" /> Transportation & Fleet
            </h1>
            <p className="mt-0.5 text-xs text-slate-400">{businessInfo?.name} · {businessInfo?.code} · live GPS, trips, bookings, fuel & maintenance</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="rounded-lg border border-slate-600 p-2 text-slate-300 hover:bg-slate-800" title="Refresh" data-testid="transport-refresh"><RefreshCw className="h-4 w-4" /></button>
            {canEdit && (
              <button onClick={() => { setDraft({}); setForm("VEHICLE"); }} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs font-bold text-white hover:bg-sky-500" data-testid="transport-add-vehicle">
                <Plus className="h-4 w-4" /> Vehicle
              </button>
            )}
          </div>
        </div>
        {notice && (
          <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200" data-testid="transport-notice">{notice}</div>
        )}
        {error && (
          <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200" data-testid="transport-error">{error}</div>
        )}
      </header>

      <nav className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-slate-700/60 bg-slate-800/60 p-1" data-testid="transport-tabs">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            data-testid={`transport-tab-${key.toLowerCase()}`}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${tab === key ? "bg-sky-600 text-white" : "text-slate-400 hover:bg-slate-700 hover:text-white"}`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </nav>

      {loading && !data && <p className="py-16 text-center text-sm text-slate-500">Loading transport module…</p>}

      {data && tab === "DASHBOARD" && (
        <div className="space-y-4" data-testid="transport-dashboard">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Fleet" value={`${M.activeVehicles || 0}/${M.fleetCount || 0}`} sub="active / total" icon={Truck} tone="text-sky-300" />
            <Tile label="On trip now" value={M.onTrip || 0} sub="dispatched" icon={Route} tone="text-violet-300" />
            <Tile label="Trackers online" value={M.trackersOnline || 0} sub={M.trackersOffline ? `${M.trackersOffline} offline` : "all healthy"} icon={Satellite} tone="text-emerald-300" />
            <Tile label="Open alerts" value={M.violationsOpen || 0} sub={M.violationsCritical ? `${M.violationsCritical} critical` : "no critical"} icon={ShieldAlert} tone="text-rose-300" />
            <Tile label="Revenue" value={money(M.revenueGhs)} sub="transport income" icon={CircleDot || Gauge} />
            <Tile label="Fuel spend" value={money(M.fuelSpendGhs)} sub={M.fleetEconomyKmpl ? `fleet ${M.fleetEconomyKmpl} km/L` : "log fuel to compute"} icon={Fuel} tone="text-amber-300" />
            <Tile label="Maintenance" value={money(M.maintenanceSpendGhs)} sub="workshop + parts" icon={Wrench} tone="text-amber-300" />
            <Tile label="Net profit" value={money(M.profitGhs)} sub={`utilisation ${Math.round((M.utilization30d || 0) * 100)}% (30d)`} icon={BarChart3} tone={Number(M.profitGhs) >= 0 ? "text-emerald-300" : "text-rose-300"} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className={rowCls}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300"><Clock className="h-4 w-4 text-sky-400" /> Active trips</h3>
              {trips.filter((t) => t.status === "EN_ROUTE").length === 0 && <p className="text-xs text-slate-500">No vehicle on the road right now.</p>}
              {trips.filter((t) => t.status === "EN_ROUTE").slice(0, 4).map((t) => (
                <div key={t.id} className="mb-2 flex items-center justify-between rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2">
                  <div>
                    <p className="text-sm font-bold text-white">{vehById(t.vehicleId)?.licensePlate || "—"} · {t.source || "?"} → {t.destination || "?"}</p>
                    <p className="text-[10px] text-slate-400">driver {t.driverName || "—"} · GPS {Number(t.gpsDistanceKm || 0).toFixed(1)} km</p>
                  </div>
                  {canEdit && <button onClick={() => tripAct(t.id, "COMPLETE", { endOdometerKm: (vehById(t.vehicleId)?.odometerKm || 0) + Math.round(Number(t.gpsDistanceKm || 0)) })} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20" data-testid={`transport-complete-trip-${t.id}`}><StopCircle className="mr-1 inline h-3 w-3" />Complete</button>}
                </div>
              ))}
            </div>
            <div className={rowCls}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300"><AlertTriangle className="h-4 w-4 text-rose-400" /> Latest alerts</h3>
              {violations.length === 0 && <p className="text-xs text-slate-500">No tracker violations. Nice and quiet.</p>}
              {violations.slice(0, 5).map((v) => (
                <div key={v.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-700 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-white">{v.kind.replace(/_/g, " ")} · {v.vehiclePlate || vehById(v.vehicleId)?.licensePlate}</p>
                    <p className="truncate text-[10px] text-slate-500">{v.detail}</p>
                  </div>
                  <div className="ml-2 flex shrink-0 items-center gap-1.5">
                    <Badge text={v.severity} map={SEV_STYLE} />
                    <Badge text={v.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={rowCls}>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Today's fleet kilometres</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="Today" value={`${M.todaysKm || 0} km`} sub="GPS-tracked" icon={Gauge} tone="text-sky-300" />
              <Tile label="Completed trips" value={M.tripsCompleted || 0} sub="all time" icon={CheckCircle2} tone="text-emerald-300" />
              <Tile label="km total" value={M.kmTotal || 0} sub="odometer & GPS" icon={Route} tone="text-sky-300" />
              <Tile label="Pending bookings" value={M.bookingsPending || 0} sub="awaiting dispatch" icon={CalendarClock} tone="text-amber-300" />
            </div>
          </div>

          <AiSectionGuide moduleKey="TRANSPORT" section={tab} businessInfo={businessInfo} />
        </div>
      )}

      {data && tab === "FLEET" && (
        <div className="space-y-3" data-testid="transport-fleet">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Fleet · {vehicles.length} vehicles</h2>
            {canEdit && <button onClick={() => { setDraft({}); setForm("VEHICLE"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-vehicle-2"><Plus className="h-3.5 w-3.5" /> Register vehicle</button>}
          </div>
          {vehicles.length === 0 && (
            <div className={`${rowCls} text-center`}>
              <Truck className="mx-auto mb-2 h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-400">No vehicles yet — register your first truck, van or bike. It will also appear in Assets automatically.</p>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {vehicles.map((v) => {
              const lv = liveById[v.id];
              const u = byVehicle[v.id] || {};
              return (
                <div key={v.id} className={rowCls} data-testid={`transport-vehicle-${v.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-black text-white">{v.licensePlate}</p>
                      <p className="text-[11px] text-slate-400">{v.name}{v.make ? ` · ${v.make}` : ""}{v.model ? ` ${v.model}` : ""} · {v.fuelType}</p>
                    </div>
                    <Badge text={v.status} />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">Odometer</p><p className="text-xs font-bold text-white">{Number(v.odometerKm || 0).toLocaleString()} km</p></div>
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">Trips (30d)</p><p className="text-xs font-bold text-white">{u.trips || 0}</p></div>
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">km (30d)</p><p className="text-xs font-bold text-white">{Math.round(Number(u.km || 0))}</p></div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[10px]">
                    {v.gpsEnabled ? (
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-bold ${lv?.gpsHealth === "ONLINE" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
                        <Radio className="h-3 w-3" /> {lv?.gpsHealth || v.gpsHealth || "STALE"} {lv?.live ? `· ${Math.round(Number(lv.live.speedKmh || 0))} km/h` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-slate-600 px-2 py-0.5 font-bold text-slate-400">no tracker</span>
                    )}
                    <span className="text-slate-500">{v.providerLabel || v.gpsProviderKey || ""}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button onClick={() => { setGpsVehicle(v.id); setTab("GPS"); }} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-700" data-testid={`transport-gps-${v.id}`}><MapPin className="mr-1 inline h-3 w-3" />Track</button>
                    <button onClick={() => { setDraft({ vehicleId: v.id, odometerKm: v.odometerKm, fuelType: v.fuelType }); setForm("FUEL"); }} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-700" data-testid={`transport-fuel-${v.id}`}><Fuel className="mr-1 inline h-3 w-3" />Fuel</button>
                    <button onClick={() => { setDraft({ vehicleId: v.id, odometerKm: v.odometerKm }); setForm("MAINT"); }} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-700" data-testid={`transport-maint-${v.id}`}><Wrench className="mr-1 inline h-3 w-3" />Maintain</button>
                    <button onClick={() => { setDraft({ vehicleId: v.id, odometerKm: v.odometerKm, employeeId: v.assignedEmployeeId }); setForm("CHECKLIST"); }} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-700" data-testid={`transport-check-${v.id}`}><ClipboardList className="mr-1 inline h-3 w-3" />Check</button>
                    {canEdit && (
                      v.status === "OUT_OF_SERVICE" ? (
                        <button onClick={async () => (await post({ entity: "VEHICLE", action: "STATUS", id: v.id, status: "ACTIVE" })).success && done("✓ Vehicle back in service")} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`transport-restore-${v.id}`}>Restore</button>
                      ) : (
                        <button onClick={async () => (await post({ entity: "VEHICLE", action: "STATUS", id: v.id, status: "OUT_OF_SERVICE" })).success && done("⚠ Vehicle grounded")} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300" data-testid={`transport-ground-${v.id}`}>Ground</button>
                      )
                    )}
                  </div>
                  {canEdit && !v.gpsEnabled && (
                    <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/40 p-1.5">
                      <select className="flex-1 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-[10px] text-white" value={draft[`prov_${v.id}`] || "SIMULATED"} onChange={(e) => setDraft({ ...draft, [`prov_${v.id}`]: e.target.value })} data-testid={`transport-provider-${v.id}`}>
                        {(data.providers || []).map((p: any) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                      <button onClick={() => registerTracker(v.id)} className="rounded-md bg-sky-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-sky-500" data-testid={`transport-register-${v.id}`}><Satellite className="mr-1 inline h-3 w-3" />Link tracker</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && tab === "DRIVERS" && (
        <div className="space-y-3" data-testid="transport-drivers">
          <h2 className="text-sm font-bold text-white">Drivers · <span className="text-slate-400 text-xs">from Employees — assign a driver to vehicles & trips</span></h2>
          {drivers.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No employees in this business yet. Add staff in the Employees view — they appear here automatically.</p>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {drivers.map((d: any) => {
              const v = vehicles.find((x) => Number(x.assignedEmployeeId) === Number(d.id));
              const dtrips = trips.filter((t) => Number(t.driverEmployeeId) === Number(d.id));
              const dkm = dtrips.reduce((s, t) => s + Number(t.actualKm || 0), 0);
              return (
                <div key={d.id} className={rowCls} data-testid={`transport-driver-${d.id}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-bold text-white">{d.name}</p>
                      <p className="text-[11px] text-slate-400">{d.role || d.position || "Staff"}{d.phone ? ` · ${d.phone}` : ""}</p>
                    </div>
                    {v ? <Badge text="ASSIGNED" map={{ ASSIGNED: "bg-sky-500/15 text-sky-300 border-sky-500/40" }} /> : null}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">Vehicle</p><p className="text-xs font-bold text-white">{v?.licensePlate || "—"}</p></div>
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">Trips</p><p className="text-xs font-bold text-white">{dtrips.length}</p></div>
                    <div className="rounded-lg bg-slate-900/60 p-2"><p className="text-[9px] uppercase text-slate-500">km driven</p><p className="text-xs font-bold text-white">{Math.round(dkm)}</p></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && tab === "TRIPS" && (
        <div className="space-y-3" data-testid="transport-trips">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Trips & Routes · {trips.length}</h2>
            {canEdit && <button onClick={() => { setDraft({ status: "PLANNED", purpose: "DELIVERY" }); setForm("TRIP"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-trip"><Plus className="h-3.5 w-3.5" /> New trip</button>}
          </div>
          {trips.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No trips yet. Dispatch from Bookings or create one directly.</p>}
          {trips.slice(0, 30).map((t) => (
            <div key={t.id} className={rowCls} data-testid={`transport-trip-${t.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-white"><Navigation className="mr-1 inline h-3.5 w-3.5 text-sky-400" />{t.source || "?"} → {t.destination || "?"}</p>
                  <p className="text-[10px] text-slate-400">
                    {vehById(t.vehicleId)?.licensePlate || "no vehicle"} · driver {t.driverName || "—"} · {t.purpose}
                    {t.startTs ? ` · started ${new Date(t.startTs).toLocaleString()}` : ""}
                    {t.actualKm ? ` · ${Number(t.actualKm).toFixed(1)} km` : t.expectedKm ? ` · ~${t.expectedKm} km` : ""}{" "}
                    {Number(t.fareGhs) > 0 ? `· ${money(t.fareGhs)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge text={t.status} />
                  {canEdit && t.status === "PLANNED" && <button onClick={() => tripAct(t.id, "START")} className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-300" data-testid={`transport-start-${t.id}`}><PlayCircle className="mr-1 inline h-3 w-3" />Start</button>}
                  {canEdit && t.status === "EN_ROUTE" && <button onClick={() => tripAct(t.id, "COMPLETE", { endOdometerKm: (vehById(t.vehicleId)?.odometerKm || 0) + Math.round(Number(t.gpsDistanceKm || 0)) })} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`transport-end-${t.id}`}><StopCircle className="mr-1 inline h-3 w-3" />Complete</button>}
                  {canEdit && (t.status === "PLANNED" || t.status === "EN_ROUTE") && <button onClick={() => tripAct(t.id, "CANCEL")} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300">Cancel</button>}
                </div>
              </div>
              {Array.isArray(t.gpsRoute) && t.gpsRoute.length > 1 && <BreadcrumbMap points={t.gpsRoute} className="mt-2" />}
            </div>
          ))}
        </div>
      )}

      {data && tab === "BOOKINGS" && (
        <div className="space-y-3" data-testid="transport-bookings">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Bookings & Orders · {bookings.length}</h2>
            {canEdit && <button onClick={() => { setDraft({}); setForm("BOOKING"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-booking"><Plus className="h-3.5 w-3.5" /> New booking</button>}
          </div>
          {bookings.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No bookings yet. Bookings create/upsert Customers automatically and book revenue to Finance on completion.</p>}
          {bookings.slice(0, 30).map((b) => (
            <div key={b.id} className={rowCls} data-testid={`transport-booking-${b.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-white">{b.customerName}</p>
                  <p className="text-[10px] text-slate-400">
                    {b.origin || "?"} → {b.destination || "?"}{b.cargo ? ` · ${b.cargo}` : ""}{b.passengers ? ` · ${b.passengers} pax` : ""} · {money(b.fareGhs)}
                    {b.scheduledFor ? ` · ${new Date(b.scheduledFor).toLocaleDateString()}` : ""}
                    {b.tripId ? ` · trip #${b.tripId}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge text={b.status} />
                  {canEdit && b.status === "PENDING" && <button onClick={() => bookingAct(b.id, "CONFIRM")} className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-300" data-testid={`transport-confirm-${b.id}`}>Confirm</button>}
                  {canEdit && b.status === "CONFIRMED" && (
                    <button
                      onClick={() => bookingAct(b.id, "DISPATCH", { vehicleId: draft[`bv_${b.id}`] || undefined })}
                      className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-300"
                      data-testid={`transport-dispatch-${b.id}`}
                    ><Truck className="mr-1 inline h-3 w-3" />Dispatch</button>
                  )}
                  {canEdit && b.status === "CONFIRMED" && (
                    <select className="rounded-md border border-slate-600 bg-slate-900 px-1.5 py-1 text-[10px] text-white" value={draft[`bv_${b.id}`] || ""} onChange={(e) => setDraft({ ...draft, [`bv_${b.id}`]: e.target.value ? Number(e.target.value) : undefined })} data-testid={`transport-bveh-${b.id}`}>
                      <option value="">auto vehicle…</option>
                      {vehicles.filter((v) => v.status === "ACTIVE").map((v) => <option key={v.id} value={v.id}>{v.licensePlate}</option>)}
                    </select>
                  )}
                  {canEdit && b.status === "IN_PROGRESS" && <button onClick={() => bookingAct(b.id, "COMPLETE")} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`transport-bcomplete-${b.id}`}>Complete → {money(b.fareGhs)}</button>}
                  {canEdit && ["PENDING", "CONFIRMED"].includes(b.status) && <button onClick={() => bookingAct(b.id, "CANCEL")} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300">Cancel</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && tab === "FUEL" && (
        <div className="space-y-3" data-testid="transport-fuel">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Fuel · {money(M.fuelSpendGhs)} spent{M.fleetEconomyKmpl ? ` · fleet ${M.fleetEconomyKmpl} km/L` : ""}</h2>
            {canEdit && <button onClick={() => { setDraft({}); setForm("FUEL"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-fuel"><Plus className="h-3.5 w-3.5" /> Log fuel</button>}
          </div>
          {fuelTrend.length > 1 && (
            <div className={`${rowCls} h-44`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fuelTrend}>
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={9} />
                  <YAxis stroke="#64748b" fontSize={9} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }} />
                  <Area type="monotone" dataKey="spend" name={currentCurrency} stroke="#fbbf24" fill="#fbbf2422" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          {fuels.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No fuel logs yet. Every log posts to Expenses (Finance) and feeds the fleet km/L figure.</p>}
          {fuels.slice(0, 30).map((f) => (
            <div key={f.id} className={rowCls} data-testid={`transport-fuelrow-${f.id}`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-white">{f.quantityLiters} L @ {money(f.pricePerLiterGhs)}/L — {vehById(f.vehicleId)?.licensePlate}</p>
                  <p className="text-[10px] text-slate-400">{f.loggedDate}{f.station ? ` · ${f.station}` : ""}{f.odometerKm != null ? ` · odo ${Number(f.odometerKm).toLocaleString()} km` : ""} · by {f.createdByName || "—"}</p>
                </div>
                <p className="text-sm font-black text-amber-300">{money(f.totalGhs)}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && tab === "MAINTENANCE" && (
        <div className="space-y-3" data-testid="transport-maintenance">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Maintenance & Repairs · {money(M.maintenanceSpendGhs)}</h2>
            {canEdit && <button onClick={() => { setDraft({}); setForm("MAINT"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-maint"><Plus className="h-3.5 w-3.5" /> New job</button>}
          </div>
          {maint.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No maintenance records. Starting a job grounds the vehicle; completing it posts the cost to Expenses.</p>}
          {maint.map((m) => (
            <div key={m.id} className={rowCls} data-testid={`transport-maintrow-${m.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-white">{m.title} <span className="text-[10px] font-normal text-slate-500">· {m.category}</span></p>
                  <p className="text-[10px] text-slate-400">
                    {vehById(m.vehicleId)?.licensePlate} · est {money(m.estimatedCostGhs)}{Number(m.actualCostGhs) > 0 ? ` · actual ${money(m.actualCostGhs)}` : ""}
                    {m.dueDate ? ` · due ${m.dueDate}` : ""}{m.vendorName ? ` · ${m.vendorName}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge text={m.status} />
                  {canEdit && m.status === "DUE" && <button onClick={() => maintAct(m.id, "START")} className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-300" data-testid={`transport-mstart-${m.id}`}>Start (grounds vehicle)</button>}
                  {canEdit && m.status === "IN_WORKSHOP" && (
                    <>
                      <input className="w-20 rounded-md border border-slate-600 bg-slate-900 px-1.5 py-1 text-[10px] text-white" placeholder={`cost (${m.estimatedCostGhs || 0})`} value={draft[`mc_${m.id}`] ?? ""} onChange={(e) => setDraft({ ...draft, [`mc_${m.id}`]: e.target.value })} data-testid={`transport-mcost-${m.id}`} />
                      <button onClick={() => maintAct(m.id, "DONE", { actualCostGhs: Number(draft[`mc_${m.id}`] || m.estimatedCostGhs || 0) })} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`transport-mdone-${m.id}`}>Done</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && tab === "GPS" && (
        <div className="space-y-3" data-testid="transport-gps">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-white">Live GPS & Trackers · {M.trackersOnline || 0} online</h2>
            <div className="flex gap-2">
              {canEdit && <button onClick={() => { setDraft({ kind: "CIRCLE" }); setForm("GEOFENCE"); }} className="flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-bold text-cyan-300" data-testid="transport-add-geofence"><MapPin className="h-3.5 w-3.5" /> Geofence</button>}
              <select className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white" value={gpsVehicle ?? ""} onChange={(e) => setGpsVehicle(e.target.value ? Number(e.target.value) : null)} data-testid="transport-gps-picker">
                <option value="">All vehicles…</option>
                {vehicles.filter((v) => v.gpsEnabled).map((v) => <option key={v.id} value={v.id}>{v.licensePlate}</option>)}
              </select>
            </div>
          </div>

          {secretBox && (
            <div className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-4" data-testid="transport-secret-box">
              <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-300">🔐 Device credentials — saved once only</h3>
              <p className="mt-1 text-[11px] text-slate-300">Configure the device/webhook to push positions via <code className="rounded bg-slate-900 px-1">POST /api/transport/trackers</code> with <code className="rounded bg-slate-900 px-1">action=INGEST</code>, these credentials, and lat/lng/speed.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-900/80 p-2"><p className="text-[9px] uppercase text-slate-500">Device IMEI / ID</p><p className="font-mono text-xs text-white" data-testid="transport-secret-imei">{secretBox.deviceId}</p></div>
                <div className="rounded-lg bg-slate-900/80 p-2"><p className="text-[9px] uppercase text-slate-500">Device secret</p><p className="break-all font-mono text-xs text-white" data-testid="transport-secret-key">{secretBox.secret}</p></div>
              </div>
              <button onClick={() => { navigator.clipboard?.writeText(JSON.stringify({ action: "INGEST", deviceId: secretBox.deviceId, secret: secretBox.secret, lat: 5.6037, lng: -0.187, speed: 60 })); flash("✓ Example payload copied"); }} className="mt-2 rounded-lg border border-cyan-500/40 px-3 py-1.5 text-[10px] font-bold text-cyan-300 hover:bg-cyan-500/20" data-testid="transport-secret-copy">Copy example payload</button>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className={rowCls}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Tracked fleet</h3>
              {vehicles.filter((v) => v.gpsEnabled).length === 0 && (
                <p className="text-xs text-slate-500">No trackers linked yet. Open <b>Fleet</b>, pick a vehicle card and hit “Link tracker” — the SIMULATED provider works out of the box for pilots; MANUAL accepts staff-pushed positions; TRACCAR/TKSTAR/JIMI etc. point at the device ingest endpoint.</p>
              )}
              {vehicles.filter((v) => v.gpsEnabled).map((v) => {
                const lv = liveById[v.id];
                return (
                  <button key={v.id} onClick={() => setGpsVehicle(v.id)} className={`mb-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${gpsVehicle === v.id ? "border-sky-500/60 bg-sky-500/10" : "border-slate-700 hover:bg-slate-800"}`} data-testid={`transport-gpsrow-${v.id}`}>
                    <div>
                      <p className="text-sm font-bold text-white">{v.licensePlate} {lv?.live?.speedKmh != null && <span className="text-[10px] text-sky-300">· {Math.round(Number(lv.live.speedKmh))} km/h</span>}</p>
                      <p className="text-[10px] text-slate-400">{v.gpsProviderKey} · today {Number(v.gpsMileageTodayKm || 0).toFixed(1)} km{lv?.live ? ` · ${Number(lv.live.lat).toFixed(4)}, ${Number(lv.live.lng).toFixed(4)}` : " · awaiting first fix"}</p>
                    </div>
                    <span className={`h-2.5 w-2.5 rounded-full ${lv?.gpsHealth === "ONLINE" ? "bg-emerald-400" : lv?.gpsHealth === "STALE" ? "bg-amber-400" : "bg-rose-400"}`} />
                  </button>
                );
              })}
            </div>
            <div className={rowCls}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">{selectedLive ? `Track — ${selectedLive.licensePlate}` : "Geofences"}</h3>
              {selectedLive && (
                <>
                  {selectedLive.live ? (
                    <BreadcrumbMap points={[...(selectedLive.breadcrumbs || []), { lat: selectedLive.live.lat, lng: selectedLive.live.lng, ts: Date.now() }]} height={220} />
                  ) : (
                    <p className="text-xs text-slate-500">No live fix yet for {selectedLive.licensePlate}{selectedLive.gpsProviderKey === "SIMULATED" ? " — run the simulator once:" : "."}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {canEdit && <button onClick={() => simulate(selectedLive.id)} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-bold text-emerald-300" data-testid="transport-simulate">▶ Simulate drive (8 positions)</button>}
                    {canEdit && <button onClick={() => simulate(selectedLive.id, { speed: 130 })} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[10px] font-bold text-rose-300" data-testid="transport-simulate-speed">⚡ Simulate speeding</button>}
                    {canEdit && (
                      <button onClick={async () => (await post({ action: "UNREGISTER", vehicleId: selectedLive.id }, "/api/transport/trackers")).success && done("✓ Tracker unlinked")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-[10px] font-bold text-slate-300">Unlink</button>
                    )}
                  </div>
                </>
              )}
              {!selectedLive && (
                <>
                  {fences.length === 0 && <p className="text-xs text-slate-500">No geofences yet. Create a circle around depots/customer sites to get ENTER/EXIT alerts in the bell.</p>}
                  {fences.map((g) => (
                    <div key={g.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-700 px-3 py-2" data-testid={`transport-fence-${g.id}`}>
                      <div>
                        <p className="text-xs font-bold text-white"><MapPin className="mr-1 inline h-3 w-3 text-cyan-400" />{g.name}</p>
                        <p className="text-[10px] text-slate-500">{g.kind}{g.kind === "CIRCLE" ? ` · r ${g.radiusM} m` : ""}{g.notifyOnEnter ? " · enter" : ""}{g.notifyOnExit ? " · exit" : ""}</p>
                      </div>
                      {canEdit && <button onClick={async () => (await patchFx({ entity: "GEOFENCE", action: "TOGGLE", id: g.id })).success && load()} className={`rounded-lg border px-2 py-1 text-[10px] font-bold ${g.active ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-slate-600 text-slate-400"}`} data-testid={`transport-fence-toggle-${g.id}`}>{g.active ? "ARMED" : "OFF"}</button>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {data && tab === "COMPLIANCE" && (
        <div className="space-y-3" data-testid="transport-compliance">
          <h2 className="text-sm font-bold text-white">Safety, Violations & Compliance</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className={rowCls}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Tracker violations · {violations.filter((v) => v.status === "UNRESOLVED").length} open</h3>
              {violations.length === 0 && <p className="text-xs text-slate-500">Nothing flagged. Speeding, geofence, prolonged-stop, night-movement and offline trackers all raise violations here + the bell.</p>}
              {violations.slice(0, 20).map((v) => (
                <div key={v.id} className="mb-2 rounded-lg border border-slate-700 px-3 py-2" data-testid={`transport-violation-${v.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-white">{v.kind.replace(/_/g, " ")} · {v.vehiclePlate || vehById(v.vehicleId)?.licensePlate}</p>
                    <div className="flex items-center gap-1"><Badge text={v.severity} map={SEV_STYLE} /><Badge text={v.status} /></div>
                  </div>
                  <p className="mt-0.5 text-[10px] text-slate-400">{v.detail}</p>
                  {v.remedyHint && <p className="text-[10px] text-cyan-300/80">💡 {v.remedyHint}</p>}
                  {canEdit && v.status === "UNRESOLVED" && (
                    <div className="mt-1.5 flex gap-1.5">
                      <button onClick={async () => (await patchFx({ entity: "VIOLATION", action: "ACKNOWLEDGE", id: v.id })).success && load()} className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-300" data-testid={`transport-vack-${v.id}`}>Acknowledge</button>
                      <button onClick={async () => (await patchFx({ entity: "VIOLATION", action: "RESOLVE", id: v.id })).success && load()} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300" data-testid={`transport-vres-${v.id}`}>Resolve</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className={rowCls}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Document radar — expiring papers</h3>
              {expiries.length === 0 && <p className="text-xs text-slate-500">No insurance / roadworthy / license / fitness dates recorded. Add them on vehicle registration to power this radar + AI early warnings.</p>}
              {expiries.map((e, i) => (
                <div key={i} className="mb-1.5 flex items-center justify-between rounded-lg border border-slate-700 px-3 py-2" data-testid={`transport-expiry-${e.kind}`}>
                  <p className="text-xs font-semibold text-white">{e.vehicle.licensePlate} · {e.kind}</p>
                  <p className="text-[10px] text-slate-500">{e.date}</p>
                  <Badge text={e.days < 0 ? "EXPIRED" : `${e.days}d left`} map={{ EXPIRED: "bg-rose-500/15 text-rose-300 border-rose-500/40", ...(e.days <= 14 ? { [`${e.days}D LEFT`]: "bg-amber-500/15 text-amber-300 border-amber-500/40" } : { [`${e.days}D LEFT`]: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" }) }} />
                </div>
              ))}
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/40 p-3 text-[10px] leading-relaxed text-slate-400">
                <p className="font-bold text-slate-300">Speed limit: <span className="text-white">{process.env.NEXT_PUBLIC_TRANSPORT_SPEED_LIMIT || "90"} km/h</span> (server env <code>TRANSPORT_SPEED_LIMIT_KMH</code>) — violations above it.</p>
                <p className="mt-1">Night window 22:00–05:00: movement without an active trip is logged as UNAUTHORIZED_MOVEMENT. Prolonged stops (45min+) spawn PROLONGED_STOP. Trackers silent for 3h+ are swept OFFLINE.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {data && tab === "CHECKLIST" && (
        <div className="space-y-3" data-testid="transport-checklist">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Daily Checklist & Notes · {checks.length} submitted</h2>
            {canEdit && vehicles.length > 0 && <button onClick={() => { setDraft({ shiftDate: new Date().toISOString().slice(0, 10) }); setForm("CHECKLIST"); }} className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white" data-testid="transport-add-checklist"><Plus className="h-3.5 w-3.5" /> Submit today</button>}
          </div>
          {checks.length === 0 && <p className={`${rowCls} text-sm text-slate-400`}>No pre-trip checklists yet. A failed critical check grounds recommendations into AI alerts.</p>}
          {checks.slice(0, 20).map((c) => {
            const fails = CHECK_ITEMS.filter((k) => (c as any)[k.key] === false);
            return (
              <div key={c.id} className={rowCls} data-testid={`transport-checkrow-${c.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-white">{vehById(c.vehicleId)?.licensePlate} · {c.shiftDate}</p>
                    <p className="text-[10px] text-slate-400">by {c.userName || "—"} · odo {Number(c.odometerKm || 0).toLocaleString()} km{c.fuelLevelPct != null ? ` · fuel ${c.fuelLevelPct}%` : ""}{c.notes ? ` · “${c.notes}”` : ""}</p>
                  </div>
                  <Badge text={fails.length === 0 ? "PASSED" : `${fails.length} FAILS`} map={{ PASSED: STATUS_STYLE.ACTIVE, [`${fails.length} FAILS`]: STATUS_STYLE.UNRESOLVED }} />
                </div>
                {fails.length > 0 && <p className="mt-1 text-[10px] text-rose-300">⚠ {fails.map((f) => f.label).join(", ")}</p>}
              </div>
            );
          })}
        </div>
      )}

      {data && tab === "REPORTS" && (
        <div className="space-y-4" data-testid="transport-reports">
          <h2 className="text-sm font-bold text-white">Reports, Finance & AI Analytics</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Gross revenue" value={money(M.revenueGhs)} icon={Landmark} />
            <Tile label="Total expenses" value={money(M.expensesGhs)} sub="fuel + maintenance" icon={FileWarning} tone="text-amber-300" />
            <Tile label="Net profit" value={money(M.profitGhs)} icon={BarChart3} tone={Number(M.profitGhs) >= 0 ? "text-emerald-300" : "text-rose-300"} />
            <Tile label="Fleet economy" value={M.fleetEconomyKmpl ? `${M.fleetEconomyKmpl} km/L` : "—"} sub={M.fleetEconomyKmpl ? "odometer-derived" : "needs 2+ odometer logs"} icon={Gauge} tone="text-sky-300" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {expenseSplit.length > 0 && (
              <div className={`${rowCls} h-52`}>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-300">Expense split</h3>
                <ResponsiveContainer width="100%" height="88%">
                  <PieChart>
                    <Pie data={expenseSplit} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%">
                      {expenseSplit.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }} formatter={(v: any) => money(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className={`${rowCls} h-52`}>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-300">km per vehicle</h3>
              <ResponsiveContainer width="100%" height="88%">
                <BarChart data={vehicles.slice(0, 8).map((v) => ({ plate: v.licensePlate, km: Math.round(Number((byVehicle[v.id] || {}).km || 0)) }))}>
                  <XAxis dataKey="plate" stroke="#64748b" fontSize={9} />
                  <YAxis stroke="#64748b" fontSize={9} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="km" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className={rowCls}>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">AI alerts & analytics ({insights.length})</h3>
            {insights.length === 0 && <p className="text-xs text-slate-500">The module scans every load for expired papers, weak fuel economy and overdue maintenance — and raises AI insights here (plus on HIGH/CRITICAL tracker violations).</p>}
            {insights.slice(0, 12).map((i) => (
              <div key={i.id} className="mb-2 rounded-lg border border-slate-700 px-3 py-2" data-testid={`transport-insight-${i.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-bold text-white">{i.title}</p>
                  <Badge text={i.impactLevel || "MEDIUM"} map={SEV_STYLE} />
                </div>
                <p className="mt-0.5 text-[10px] text-slate-400">{i.recommendation}</p>
              </div>
            ))}
          </div>
          <div className={rowCls}>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Finance interlink — transactions booked</h3>
            {(data.transactions || []).length === 0 && <p className="text-xs text-slate-500">Completed bookings & fuel/maintenance costs post here automatically with txn numbers (visible in the Finance module).</p>}
            {(data.transactions || []).slice(0, 12).map((t: any) => (
              <div key={t.id} className="mb-1.5 flex items-center justify-between rounded-lg border border-slate-700 px-3 py-2 text-xs">
                <div>
                  <p className="font-bold text-white">{t.transactionNumber || t.id} · {t.category}</p>
                  <p className="text-[10px] text-slate-500">{t.description}</p>
                </div>
                <p className={`font-black ${t.type === "INCOME" ? "text-emerald-300" : "text-amber-300"}`}>{t.type === "INCOME" ? "+" : "−"}{money(t.amountGhs)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════ FORMS ══════════ */}
      {form === "VEHICLE" && (
        <Modal title="Register vehicle" onSubmit={submitVehicle} submitLabel="Register">
          <Field label="Vehicle name *"><input className={inp} placeholder="12-Ton Cargo #1" value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="transport-f-name" /></Field>
          <Field label="License plate *"><input className={inp} placeholder="GR 4567-25" value={draft.licensePlate || ""} onChange={(e) => setDraft({ ...draft, licensePlate: e.target.value })} data-testid="transport-f-plate" /></Field>
          <Field label="Type"><select className={inp} value={draft.vehicleType || "TRUCK"} onChange={(e) => setDraft({ ...draft, vehicleType: e.target.value })}>{VEHICLE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Fuel"><select className={inp} value={draft.fuelType || "DIESEL"} onChange={(e) => setDraft({ ...draft, fuelType: e.target.value })}>{FUEL_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Make / model" span><input className={inp} placeholder="Sinotruck CNHTC / Howo" value={draft.make || ""} onChange={(e) => setDraft({ ...draft, make: e.target.value })} /></Field>
          <Field label="Year"><input className={inp} type="number" value={draft.year || ""} onChange={(e) => setDraft({ ...draft, year: e.target.value })} /></Field>
          <Field label="Initial odometer (km)"><input className={inp} type="number" value={draft.odometerKm ?? 0} onChange={(e) => setDraft({ ...draft, odometerKm: Number(e.target.value) })} /></Field>
          <Field label="Purchase cost"><input className={inp} type="number" value={draft.purchaseCostGhs ?? 0} onChange={(e) => setDraft({ ...draft, purchaseCostGhs: Number(e.target.value) })} /></Field>
          <Field label="Assigned driver"><select className={inp} value={draft.assignedEmployeeId || ""} onChange={(e) => setDraft({ ...draft, assignedEmployeeId: e.target.value ? Number(e.target.value) : undefined })} data-testid="transport-f-driver"><option value="">none</option>{drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Insurance expiry"><input className={inp} type="date" value={draft.insuranceExpiry || ""} onChange={(e) => setDraft({ ...draft, insuranceExpiry: e.target.value })} /></Field>
          <Field label="Roadworthy expiry"><input className={inp} type="date" value={draft.roadworthyExpiry || ""} onChange={(e) => setDraft({ ...draft, roadworthyExpiry: e.target.value })} /></Field>
          <Field label="License expiry"><input className={inp} type="date" value={draft.licenseExpiry || ""} onChange={(e) => setDraft({ ...draft, licenseExpiry: e.target.value })} /></Field>
          <Field label="Fitness expiry"><input className={inp} type="date" value={draft.fitnessExpiry || ""} onChange={(e) => setDraft({ ...draft, fitnessExpiry: e.target.value })} /></Field>
          <Field label="Notes" span><input className={inp} placeholder="Tanker, tail lift, exact cargo bed…" value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
        </Modal>
      )}

      {form === "TRIP" && (
        <Modal title="Create trip" onSubmit={submitTrip} submitLabel="Create">
          <Field label="Vehicle"><VehicleSelect value={draft.vehicleId} onChange={(v: number) => setDraft({ ...draft, vehicleId: v })} /></Field>
          <Field label="Driver"><select className={inp} value={draft.driverEmployeeId || ""} onChange={(e) => setDraft({ ...draft, driverEmployeeId: e.target.value ? Number(e.target.value) : undefined })}><option value="">name free…</option>{drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Driver name (optional)"><input className={inp} value={draft.driverName || ""} onChange={(e) => setDraft({ ...draft, driverName: e.target.value })} /></Field>
          <Field label="Purpose"><select className={inp} value={draft.purpose || "DELIVERY"} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}>{TRIP_PURPOSES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="From"><input className={inp} placeholder="Accra depot" value={draft.source || ""} onChange={(e) => setDraft({ ...draft, source: e.target.value })} data-testid="transport-f-source" /></Field>
          <Field label="To"><input className={inp} placeholder="Kumasi" value={draft.destination || ""} onChange={(e) => setDraft({ ...draft, destination: e.target.value })} data-testid="transport-f-dest" /></Field>
          <Field label="Expected km"><input className={inp} type="number" value={draft.expectedKm ?? ""} onChange={(e) => setDraft({ ...draft, expectedKm: Number(e.target.value) })} /></Field>
          <Field label="Fare"><input className={inp} type="number" value={draft.fareGhs ?? 0} onChange={(e) => setDraft({ ...draft, fareGhs: Number(e.target.value) })} /></Field>
          <Field label="Cargo" span><input className={inp} value={draft.cargo || ""} onChange={(e) => setDraft({ ...draft, cargo: e.target.value })} /></Field>
          <Field label="Start now?" span>
            <select className={inp} value={draft.status || "PLANNED"} onChange={(e) => setDraft({ ...draft, status: e.target.value })} data-testid="transport-f-status"><option value="PLANNED">Plan only</option><option value="EN_ROUTE">Dispatch immediately</option></select>
          </Field>
        </Modal>
      )}

      {form === "BOOKING" && (
        <Modal title="New booking / order" onSubmit={submitBooking} submitLabel="Create booking">
          <Field label="Customer name *"><input className={inp} value={draft.customerName || ""} onChange={(e) => setDraft({ ...draft, customerName: e.target.value })} data-testid="transport-f-cust" /></Field>
          <Field label="Phone"><input className={inp} value={draft.customerPhone || ""} onChange={(e) => setDraft({ ...draft, customerPhone: e.target.value })} /></Field>
          <Field label="From"><input className={inp} value={draft.origin || ""} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} /></Field>
          <Field label="To"><input className={inp} value={draft.destination || ""} onChange={(e) => setDraft({ ...draft, destination: e.target.value })} /></Field>
          <Field label="Cargo"><input className={inp} value={draft.cargo || ""} onChange={(e) => setDraft({ ...draft, cargo: e.target.value })} /></Field>
          <Field label="Passengers"><input className={inp} type="number" value={draft.passengers ?? 0} onChange={(e) => setDraft({ ...draft, passengers: Number(e.target.value) })} /></Field>
          <Field label="Quoted fare"><input className={inp} type="number" value={draft.fareGhs ?? 0} onChange={(e) => setDraft({ ...draft, fareGhs: Number(e.target.value) })} data-testid="transport-f-fare" /></Field>
          <Field label="Deposit"><input className={inp} type="number" value={draft.depositGhs ?? 0} onChange={(e) => setDraft({ ...draft, depositGhs: Number(e.target.value) })} /></Field>
          <Field label="Scheduled for"><input className={inp} type="date" value={draft.scheduledFor || ""} onChange={(e) => setDraft({ ...draft, scheduledFor: e.target.value })} /></Field>
        </Modal>
      )}

      {form === "FUEL" && (
        <Modal title="Log fuel" onSubmit={submitFuel} submitLabel="Log → Expenses">
          <Field label="Vehicle *"><VehicleSelect value={draft.vehicleId} onChange={(v: number) => { const veh = vehById(v); setDraft({ ...draft, vehicleId: v, odometerKm: veh?.odometerKm ?? draft.odometerKm, fuelType: veh?.fuelType ?? draft.fuelType }); }} /></Field>
          <Field label="Odometer (km)"><input className={inp} type="number" value={draft.odometerKm ?? ""} onChange={(e) => setDraft({ ...draft, odometerKm: Number(e.target.value) })} data-testid="transport-f-odo" /></Field>
          <Field label="Liters *"><input className={inp} type="number" value={draft.quantityLiters ?? ""} onChange={(e) => setDraft({ ...draft, quantityLiters: Number(e.target.value) })} data-testid="transport-f-liters" /></Field>
          <Field label="Price per liter *"><input className={inp} type="number" step="0.01" value={draft.pricePerLiterGhs ?? ""} onChange={(e) => setDraft({ ...draft, pricePerLiterGhs: Number(e.target.value) })} data-testid="transport-f-ppl" /></Field>
          <Field label="Total"><input className={inp} disabled value={money((Number(draft.quantityLiters) || 0) * (Number(draft.pricePerLiterGhs) || 0))} /></Field>
          <Field label="Station"><input className={inp} value={draft.station || ""} onChange={(e) => setDraft({ ...draft, station: e.target.value })} /></Field>
          <Field label="Date"><input className={inp} type="date" value={draft.loggedDate || new Date().toISOString().slice(0, 10)} onChange={(e) => setDraft({ ...draft, loggedDate: e.target.value })} /></Field>
          <Field label="Notes"><input className={inp} value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
        </Modal>
      )}

      {form === "MAINT" && (
        <Modal title="New maintenance job" onSubmit={submitMaint} submitLabel="Create job">
          <Field label="Vehicle *"><VehicleSelect value={draft.vehicleId} onChange={(v: number) => setDraft({ ...draft, vehicleId: v })} /></Field>
          <Field label="Category"><select className={inp} value={draft.category || "PREVENTIVE"} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{MAINT_CATEGORIES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Title *" span><input className={inp} placeholder="e.g. Replace brake pads + resurface discs" value={draft.title || ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} data-testid="transport-f-title" /></Field>
          <Field label="Estimated cost"><input className={inp} type="number" value={draft.estimatedCostGhs ?? 0} onChange={(e) => setDraft({ ...draft, estimatedCostGhs: Number(e.target.value) })} /></Field>
          <Field label="Due date"><input className={inp} type="date" value={draft.dueDate || ""} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></Field>
          <Field label="Vendor / workshop"><input className={inp} value={draft.vendorName || ""} onChange={(e) => setDraft({ ...draft, vendorName: e.target.value })} /></Field>
          <Field label="Next due odometer"><input className={inp} type="number" value={draft.nextDueOdometerKm ?? ""} onChange={(e) => setDraft({ ...draft, nextDueOdometerKm: Number(e.target.value) })} /></Field>
          <Field label="Description" span><input className={inp} value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
        </Modal>
      )}

      {form === "CHECKLIST" && (
        <Modal title="Daily vehicle checklist" onSubmit={submitChecklist} submitLabel="Submit checklist">
          <Field label="Vehicle *"><VehicleSelect value={draft.vehicleId} onChange={(v: number) => { const veh = vehById(v); setDraft({ ...draft, vehicleId: v, odometerKm: veh?.odometerKm ?? draft.odometerKm }); }} /></Field>
          <Field label="Odometer (km)"><input className={inp} type="number" value={draft.odometerKm ?? ""} onChange={(e) => setDraft({ ...draft, odometerKm: Number(e.target.value) })} /></Field>
          <Field label="Fuel level (%)"><input className={inp} type="number" value={draft.fuelLevelPct ?? ""} onChange={(e) => setDraft({ ...draft, fuelLevelPct: Number(e.target.value) })} /></Field>
          <Field label="Driver (employee)"><select className={inp} value={draft.employeeId || ""} onChange={(e) => setDraft({ ...draft, employeeId: e.target.value ? Number(e.target.value) : undefined })}><option value="">—</option>{drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <div className="sm:col-span-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">12-point check — tap to confirm</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {CHECK_ITEMS.map((c) => {
                const on = draft[c.key] === true || draft[c.key] === undefined ? true : false;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setDraft({ ...draft, [c.key]: !on })}
                    className={`rounded-lg border px-2 py-1.5 text-left text-[10px] font-semibold transition ${on ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}
                    data-testid={`transport-check-${c.key}`}
                  >
                    {on ? "✓" : "✗"} {c.label}{c.critical ? " *" : ""}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[9px] text-slate-500">* critical — any failure raises a HIGH AI risk alert.</p>
          </div>
          <Field label="Notes" span><input className={inp} placeholder="Anything the mechanic should know…" value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
        </Modal>
      )}

      {form === "GEOFENCE" && (
        <Modal title="Create geofence" onSubmit={submitGeofence} submitLabel="Arm geofence">
          <Field label="Name *"><input className={inp} placeholder="Main Depot" value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="transport-f-fencename" /></Field>
          <Field label="Radius (m)"><input className={inp} type="number" value={draft.radiusM ?? 500} onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })} /></Field>
          <Field label="Latitude"><input className={inp} type="number" step="0.0001" value={draft.lat ?? ""} onChange={(e) => setDraft({ ...draft, lat: Number(e.target.value) })} placeholder="5.6037" data-testid="transport-f-lat" /></Field>
          <Field label="Longitude"><input className={inp} type="number" step="0.0001" value={draft.lng ?? ""} onChange={(e) => setDraft({ ...draft, lng: Number(e.target.value) })} placeholder="-0.1870" data-testid="transport-f-lng" /></Field>
          <Field label="Alert on enter" span><select className={inp} value={draft.notifyOnEnter === false ? "off" : "on"} onChange={(e) => setDraft({ ...draft, notifyOnEnter: e.target.value === "on" })}><option value="on">enter + exit alerts</option><option value="off">exit alerts only</option></select></Field>
        </Modal>
      )}
    </div>
  );
}

/** Offline breadcrumb track — normalize recent GPS points into an SVG box so
 *  the tracker view works without a maps library or network. */
function BreadcrumbMap({ points, height = 160, className = "" }: { points: any[]; height?: number; className?: string }) {
  const pts = (points || []).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  if (pts.length < 2) {
    const one = pts[0];
    return (
      <div className={`rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-center text-[10px] text-slate-500 ${className}`} style={{ height }} data-testid="transport-map">
        {one ? `Last fix: ${Number(one.lat).toFixed(4)}, ${Number(one.lng).toFixed(4)}` : "No positions yet"}
      </div>
    );
  }
  const lats = pts.map((p) => Number(p.lat));
  const lngs = pts.map((p) => Number(p.lng));
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const W = 600, H = 220, pad = 18;
  const dx = Math.max(maxLng - minLng, 0.0005);
  const dy = Math.max(maxLat - minLat, 0.0005);
  const xy = (p: any) => [
    pad + ((Number(p.lng) - minLng) / dx) * (W - 2 * pad),
    H - pad - ((Number(p.lat) - minLat) / dy) * (H - 2 * pad),
  ];
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join(" ");
  const first = xy(pts[0]), last = xy(pts[pts.length - 1]);
  return (
    <div className={`overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60 ${className}`} data-testid="transport-map">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height }}>
        <defs>
          <linearGradient id="tk" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#38bdf8" />
          </linearGradient>
        </defs>
        {Array.from({ length: 6 }).map((_, i) => (
          <line key={`v${i}`} x1={(W / 6) * (i + 0.5)} y1="0" x2={(W / 6) * (i + 0.5)} y2={H} stroke="#1e293b" strokeWidth="1" />
        ))}
        {Array.from({ length: 4 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={(H / 4) * (i + 0.5)} x2={W} y2={(H / 4) * (i + 0.5)} stroke="#1e293b" strokeWidth="1" />
        ))}
        <path d={path} fill="none" stroke="url(#tk)" strokeWidth="3" strokeLinecap="round" />
        {pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 20)) === 0).map((p, i) => {
          const [x, y] = xy(p);
          return <circle key={i} cx={x} cy={y} r="2.4" fill="#38bdf8" opacity="0.75" />;
        })}
        <circle cx={first[0]} cy={first[1]} r="5" fill="#34d399" />
        <circle cx={last[0]} cy={last[1]} r="6" fill="#a78bfa" stroke="#fff" strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between px-2 py-1 text-[9px] text-slate-500">
        <span>start {Number(pts[0].lat).toFixed(3)}, {Number(pts[0].lng).toFixed(3)}</span>
        <span>{pts.length} fixes</span>
        <span>last {Number(pts[pts.length - 1].lat).toFixed(3)}, {Number(pts[pts.length - 1].lng).toFixed(3)}</span>
      </div>
    </div>
  );
}
