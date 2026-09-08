"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MapPin, AlertTriangle, RefreshCw, LocateFixed, Clock, Users, ShieldAlert, Timer } from "lucide-react";

/**
 * AttendanceReviewPanel — the manager/supervisor view over the Clock In/Out
 * log: who clocked where & when, GPS coordinates + distance from the branch
 * anchor, OFF-SITE flags, hours + overtime (the rows that flow into payroll).
 * Anchoring a branch's GPS (OWNER / authorized managers) turns the geofence
 * on for every clock event on that branch.
 */
export default function AttendanceReviewPanel({
  currentUser, businesses, employees,
}: { currentUser: any; businesses: any[]; employees: any[] }) {
  const [data, setData] = useState<any>(null);
  const [fBiz, setFBiz] = useState("ALL");
  const [fDate, setFDate] = useState("");
  const [fEmp, setFEmp] = useState("ALL");
  const [fOff, setFOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locBusy, setLocBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (fBiz !== "ALL") params.set("businessId", fBiz);
      if (fDate) params.set("date", fDate);
      if (fEmp !== "ALL") params.set("employeeId", fEmp);
      if (fOff) params.set("offSite", "1");
      const r = await fetch(`/api/attendance?${params.toString()}`);
      const d = await r.json();
      if (d.success) setData(d);
    } finally {
      setBusy(false);
    }
  }, [fBiz, fDate, fEmp, fOff]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener("attendance-changed", h);
    return () => window.removeEventListener("attendance-changed", h);
  }, [load]);

  const meta = data?.meta || { canReview: false, canSetLocation: false };
  const logs = data?.logs || [];
  const anchors = data?.anchors || [];

  const k = useMemo(() => {
    const onDuty = logs.filter((l: any) => !l.clockOutAt).length;
    const offSite = logs.filter((l: any) => l.offSiteIn || l.offSiteOut).length;
    const ot = logs.reduce((s: number, l: any) => s + (l.overtimeHours || 0), 0);
    const hrs = logs.reduce((s: number, l: any) => s + (l.hoursWorked || 0), 0);
    return { shifts: logs.length, onDuty, offSite, ot: Math.round(ot * 100) / 100, hrs: Math.round(hrs * 100) / 100 };
  }, [logs]);

  const setLocation = () => {
    if (fBiz === "ALL") { setNotice("Pick one business in the filter first — its location is set to where you stand."); return; }
    if (!("geolocation" in navigator)) { setNotice("GPS not available on this device."); return; }
    setLocBusy(true);
    setNotice("Reading GPS…");
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        try {
          const r = await fetch("/api/attendance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "SET_BUSINESS_LOCATION", businessId: Number(fBiz), lat: p.coords.latitude, lng: p.coords.longitude, radiusM: 300 }),
          });
          const d = await r.json();
          setNotice(d.success ? `✔ ${d.item.code} anchored at ${d.item.gpsLat.toFixed(5)}, ${d.item.gpsLng.toFixed(5)} (300m geofence on)` : (d.error || "Failed"));
          if (d.success) load();
        } finally {
          setLocBusy(false);
        }
      },
      () => { setNotice("GPS denied/unavailable — allow location access and try again."); setLocBusy(false); },
      { enableHighAccuracy: true, timeout: 9000 },
    );
  };

  if (data && !meta.canReview) {
    return (
      <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl p-4" data-testid="attl-root">
        <p className="text-xs text-slate-400" data-testid="attl-noaccess">
          Clock-in/out location review is available to the OWNER and authorized Managers/Supervisors only.
        </p>
      </div>
    );
  }

  const hhmm = (t: any) => (t ? new Date(t).toISOString().slice(11, 16) : "—");
  /** One stored GPS point (IN or OUT): coordinates + accuracy + map link. */
  const GpsRow = ({ label, lat, lng, acc, method, dist, tid }: any) => (
    <div className="flex items-center gap-1 whitespace-nowrap">
      <span className={`text-[8px] font-black w-6 shrink-0 ${label === "IN" ? "text-emerald-500" : "text-rose-400"}`}>{label}</span>
      {lat != null ? (
        <a
          data-testid={tid}
          className="text-teal-300 underline decoration-dotted text-[10px]"
          href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`}
          target="_blank" rel="noreferrer"
          title={`${method === "GPS" ? "GPS" : "Manual"} fix stored permanently — open in OpenStreetMap`}
        >
          {Number(lat).toFixed(4)}, {Number(lng).toFixed(4)}
        </a>
      ) : (
        <span className="text-slate-600 text-[10px]" data-testid={tid}>no GPS fix (manual)</span>
      )}
      {lat != null && acc != null && <span className="text-[9px] text-slate-500">±{Math.round(acc)}m</span>}
      {dist != null && <span className="text-[9px] text-slate-600">· {Math.round(dist)}m away</span>}
    </div>
  );
  const Chip = ({ label, value, sub, tone = "cyan", tid }: any) => (
    <div className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2" data-testid={tid}>
      <div className="text-[9px] uppercase font-bold text-slate-500">{label}</div>
      <div className={`text-sm font-extrabold text-${tone}-400`}>{value}</div>
      {sub && <div className="text-[9px] text-slate-500">{sub}</div>}
    </div>
  );
  const sel = "px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs";

  return (
    <div className="bg-slate-900/60 border border-slate-700/70 rounded-xl overflow-hidden" data-testid="attl-root">
      <div className="px-4 py-2.5 border-b border-slate-700/60 flex flex-wrap items-center gap-2">
        <MapPin className="w-4 h-4 text-teal-400" />
        <h4 className="text-xs font-bold text-white">Clock In / Out Log — location & hours review</h4>
        <span className="text-[9px] text-slate-500" data-testid="attl-subnote">GPS captured & permanently stored at BOTH clock-in and clock-out · feeds payroll attendance & OT automatically</span>
        <div className="ml-auto flex items-center gap-2">
          {meta.canSetLocation && (
            <button
              data-testid="attl-setloc"
              onClick={setLocation}
              disabled={locBusy}
              className="px-2.5 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-[10px] font-bold rounded-lg flex items-center gap-1"
              title="Set the filtered branch's GPS anchor to where you are standing (300m geofence)"
            >
              <LocateFixed className="w-3 h-3" /> {locBusy ? "Reading…" : "Set Branch Location"}
            </button>
          )}
          <button data-testid="attl-refresh" onClick={load} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400">
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Business / Branch</label>
            <select data-testid="attl-filter-biz" value={fBiz} onChange={(e) => setFBiz(e.target.value)} className={sel}>
              <option value="ALL">All accessible</option>
              {businesses.map((b: any) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Date</label>
            <input data-testid="attl-filter-date" type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className={sel} />
          </div>
          <div>
            <label className="block text-[10px] text-slate-500 mb-1">Employee</label>
            <select data-testid="attl-filter-emp" value={fEmp} onChange={(e) => setFEmp(e.target.value)} className={sel}>
              <option value="ALL">All staff</option>
              {employees
                .filter((e: any) => fBiz === "ALL" || Number(e.businessId) === Number(fBiz))
                .map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300 pb-2">
            <input data-testid="attl-filter-offsite" type="checkbox" checked={fOff} onChange={(e) => setFOff(e.target.checked)} className="accent-amber-500" />
            Off-site only
          </label>
          {(fBiz !== "ALL" || fDate || fEmp !== "ALL" || fOff) && (
            <button data-testid="attl-filter-reset" onClick={() => { setFBiz("ALL"); setFDate(""); setFEmp("ALL"); setFOff(false); }}
              className="px-2.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg mb-0.5">Reset</button>
          )}
        </div>

        {/* Summary chips */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <Chip tid="attl-kpi-shifts" label="Shifts" value={k.shifts} sub="in scope" tone="teal" />
          <Chip tid="attl-kpi-onduty" label="On Duty Now" value={k.onDuty} sub="clocked in" tone="emerald" />
          <Chip tid="attl-kpi-offsite" label="Off-Site Events" value={k.offSite} sub="outside branch" tone={k.offSite ? "amber" : "slate"} />
          <Chip tid="attl-kpi-hours" label="Hours Worked" value={k.hrs} sub="clocked total" tone="cyan" />
          <Chip tid="attl-kpi-ot" label="Overtime (h)" value={k.ot} sub="→ payroll" tone="violet" />
        </div>

        {/* Anchor status */}
        {anchors.length > 0 && (
          <p className="text-[10px] text-slate-500" data-testid="attl-anchors">
            Geofence: {anchors.filter((a: any) => a.anchored).length} of {anchors.length} branches anchored
            {anchors.some((a: any) => !a.anchored) && " — unanchored branches can't flag off-site events"}
          </p>
        )}
        {notice && <p data-testid="attl-notice" className="text-[11px] text-teal-300">{notice}</p>}

        {/* Table */}
        <div className="overflow-x-auto" data-testid="attl-table">
          {logs.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8" data-testid="attl-empty">
              No clock records in this scope yet — staff clock in from the navbar's Clock button.
            </p>
          ) : (
            <table className="w-full text-[11px] min-w-[920px]">
              <thead>
                <tr className="text-left text-slate-500 uppercase text-[9px]">
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Employee</th>
                  <th className="pb-2 pr-3">Business / Branch</th>
                  <th className="pb-2 pr-3">Clock In</th>
                  <th className="pb-2 pr-3">Clock Out</th>
                  <th className="pb-2 pr-3">Hours</th>
                  <th className="pb-2 pr-3">OT</th>
                  <th className="pb-2 pr-3">GPS / Location</th>
                  <th className="pb-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l: any) => (
                  <tr key={l.id} data-testid={`attl-row-${l.id}`} className="border-t border-slate-800 text-slate-300">
                    <td className="py-2 pr-3 whitespace-nowrap">{l.date}</td>
                    <td className="py-2 pr-3 font-bold text-white">{l.employeeName}</td>
                    <td className="py-2 pr-3">{l.branchCode}<div className="text-[9px] text-slate-500">{l.branchName}</div></td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {hhmm(l.clockInAt)}
                      <span className={`ml-1 text-[9px] ${l.clockInMethod === "GPS" ? "text-slate-500" : "text-amber-400"}`}>
                        {l.clockInMethod === "GPS" ? "GPS" : "no-fix"}
                      </span>
                      {l.clockInDistanceM != null && <div className="text-[9px] text-slate-500">{Math.round(l.clockInDistanceM)}m away</div>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {l.clockOutAt ? (
                        <>
                          {hhmm(l.clockOutAt)}
                          <span className={`ml-1 text-[9px] ${l.clockOutMethod === "GPS" ? "text-slate-500" : "text-amber-400"}`}>
                            {l.clockOutMethod === "GPS" ? "GPS" : "no-fix"}
                          </span>
                        </>
                      ) : (
                        <span className="text-emerald-400 font-bold">on duty</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-bold">{l.hoursWorked != null ? l.hoursWorked : "—"}</td>
                    <td className="py-2 pr-3">{l.overtimeHours > 0 ? <span className="text-violet-300 font-bold">+{l.overtimeHours}</span> : "—"}</td>
                    <td className="py-2 pr-3">
                      {/* Both stored fixes: where the shift started AND where it ended. */}
                      <GpsRow label="IN" lat={l.clockInLat} lng={l.clockInLng} acc={l.clockInAccuracyM} method={l.clockInMethod} dist={l.clockInDistanceM} tid={`attl-gps-in-${l.id}`} />
                      {l.clockOutAt ? (
                        <GpsRow label="OUT" lat={l.clockOutLat} lng={l.clockOutLng} acc={l.clockOutAccuracyM} method={l.clockOutMethod} dist={l.clockOutDistanceM} tid={`attl-gps-out-${l.id}`} />
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-[8px] font-black w-6 shrink-0 text-slate-600">OUT</span>
                          <span className="text-slate-600 text-[10px]" data-testid={`attl-gps-out-pending-${l.id}`}>pending clock-out</span>
                        </div>
                      )}
                    </td>
                    <td className="py-2">
                      {(l.offSiteIn || l.offSiteOut) ? (
                        <span data-testid={`attl-offsite-${l.id}`} className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-extrabold flex items-center gap-1 w-max">
                          <AlertTriangle className="w-3 h-3" /> OFF-SITE{l.offSiteIn && l.offSiteOut ? " (in+out)" : l.offSiteIn ? " (in)" : " (out)"}
                        </span>
                      ) : l.clockInDistanceM != null ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold">on-site</span>
                      ) : (
                        <span className="text-slate-600 text-[10px]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
