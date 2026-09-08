"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, MapPin, AlertTriangle, Loader2, LogIn, LogOut } from "lucide-react";
import { useClampedDropdown } from "./nav/useClampedDropdown";

/**
 * AttendanceClock — the staff Clock In / Clock Out widget living in the
 * navbar for every signed-in user. Each event captures the browser's GPS fix
 * (falls back to a MANUAL no-fix record so staff are never blocked), and the
 * server auto-records date, time, assigned Business & Branch, and flags
 * off-site events against the branch anchor.
 */
export default function AttendanceClock({ currentUser }: { currentUser: any }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState<any>(null);
  const [anchors, setAnchors] = useState<any[]>([]);
  const [bizId, setBizId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Viewport-clamped panel — the clock panel sits mid-navbar, so an
  // absolute `right-0` panel flew off the LEFT edge on phones.
  const { rootRef: pop, panelStyle } = useClampedDropdown(open, 320);
  const isPrivileged = !["WORKER", "BRANCH_MANAGER", "SUPERVISOR", "ACCOUNTANT"].includes(currentUser?.role);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/attendance?mine=1");
      const d = await r.json();
      if (d.success) {
        setShift(d.openShift || null);
        setAnchors(d.anchors || []);
        if (!bizId && d.anchors?.length) {
          const remembered = Number(localStorage.getItem("att-clock-biz")) || null;
          setBizId(remembered && d.anchors.some((a: any) => a.id === remembered) ? remembered : d.anchors[0].id);
        }
      }
    } catch {
      /* offline — keep last state */
    }
  }, [bizId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [pop]);

  const anchorOf = useMemo(
    () => anchors.find((a) => a.id === (shift?.businessId ?? bizId)),
    [anchors, shift, bizId],
  );

  const getFix = (): Promise<{ lat: number | null; lng: number | null; accuracy: number | null; method: "GPS" | "MANUAL"; denied: boolean }> =>
    new Promise((resolve) => {
      if (!("geolocation" in navigator)) return resolve({ lat: null, lng: null, accuracy: null, method: "MANUAL", denied: false });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, method: "GPS", denied: false }),
        () => resolve({ lat: null, lng: null, accuracy: null, method: "MANUAL", denied: true }),
        { enableHighAccuracy: true, timeout: 9000, maximumAge: 0 },
      );
    });

  const act = async (action: "CLOCK_IN" | "CLOCK_OUT") => {
    setBusy(true);
    setStatus("Locating…");
    try {
      const fix = await getFix();
      setStatus(fix.method === "GPS" ? "Saving with GPS…" : "GPS unavailable — saving without location…");
      const r = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, businessId: bizId }),
      });
      const d = await r.json();
      if (d.success) {
        // Explicit confirmation that the GPS position was captured AND
        // permanently stored for THIS event (in-location or out-location),
        // so staff never have to guess whether their location was saved.
        const gpsNote =
          fix.method === "GPS"
            ? ` · GPS ${action === "CLOCK_IN" ? "in" : "out"}-location recorded${fix.accuracy != null ? ` (±${Math.round(fix.accuracy)}m)` : ""}`
            : " · no GPS fix — recorded without location";
        setStatus(
          d.offSite
            ? `⚠ ${action === "CLOCK_IN" ? "Clocked in" : "Clocked out"} OFF-SITE — ${Math.round(d.distanceM)}m from branch — flagged for review${gpsNote}`
            : `✔ ${action === "CLOCK_IN" ? `Clocked in at ${anchorName(d.item)}` : `Clocked out — ${d.hoursWorked}h${d.overtimeHours > 0 ? ` (+${d.overtimeHours}h OT)` : ""}${d.payrollLinked ? " · sent to payroll" : ""}`}${gpsNote}`,
        );
        await refresh();
        window.dispatchEvent(new CustomEvent("attendance-changed"));
      } else {
        setStatus(d.error || "Failed");
      }
    } catch (e: any) {
      setStatus(e?.message || "Network error");
    } finally {
      setBusy(false);
    }
  };

  const anchorName = (item: any) => item?.branchCode || anchorOf?.code || "branch";

  const since = shift ? new Date(shift.clockInAt) : null;
  const hhmm = (t: any) => (t ? new Date(t).toISOString().slice(11, 16) : "");

  return (
    <div className="relative shrink-0" ref={pop} data-testid="att-clock-root">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="att-clock-btn"
        className={`flex items-center space-x-1.5 text-xs font-bold px-2 sm:px-2.5 py-1.5 rounded-lg border transition ${
          shift
            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
            : "bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700"
        }`}
        title={shift ? `On duty since ${hhmm(shift.clockInAt)} — tap for attendance` : "Attendance — Clock In / Out"}
      >
        <Clock className={`w-3.5 h-3.5 ${shift ? "animate-pulse" : ""}`} />
        <span className="hidden lg:inline">{shift ? `On duty ${hhmm(shift.clockInAt)}` : "Clock In"}</span>
        {shift?.offSiteIn && <AlertTriangle className="w-3 h-3 text-amber-400" />}
      </button>

      {open && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 z-50 space-y-2.5 overflow-y-auto" style={panelStyle} data-testid="att-clock-panel">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-cyan-400" />
            <p className="text-xs font-extrabold text-white">Attendance Clock</p>
          </div>

          {shift ? (
            <div className="bg-emerald-500/10 border border-emerald-600/40 rounded-lg p-2.5 text-[11px] text-slate-300 space-y-1">
              <p className="font-bold text-emerald-300" data-testid="att-open-shift">
                On duty — {shift.branchCode} ({shift.branchName})
              </p>
              <p data-testid="att-open-since">
                In since <span className="font-bold text-white">{shift.date} {hhmm(shift.clockInAt)}</span>
                {shift.clockInMethod === "GPS" ? (
                  <span className="text-slate-500"> · GPS{shift.clockInDistanceM != null ? ` ${Math.round(shift.clockInDistanceM)}m` : ""}</span>
                ) : (
                  <span className="text-amber-400"> · no GPS fix</span>
                )}
              </p>
              {shift.offSiteIn && (
                <p className="text-amber-300 flex items-center gap-1" data-testid="att-offsite-badge">
                  <AlertTriangle className="w-3 h-3" /> Clocked in outside the assigned branch — flagged for manager review
                </p>
              )}
            </div>
          ) : (
            isPrivileged && (
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">You are at (Business / Branch)</label>
                <select
                  data-testid="att-clock-biz"
                  value={bizId ?? ""}
                  onChange={(e) => { const v = Number(e.target.value); setBizId(v); localStorage.setItem("att-clock-biz", String(v)); }}
                  className="w-full px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs"
                >
                  {anchors.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.code}){a.anchored ? "" : " — locations not anchored"}</option>
                  ))}
                </select>
              </div>
            )
          )}

          <div className="flex gap-2">
            {!shift ? (
              <button
                data-testid="att-clockin"
                onClick={() => act("CLOCK_IN")}
                disabled={busy || (isPrivileged && !bizId)}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />} Clock In
              </button>
            ) : (
              <button
                data-testid="att-clockout"
                onClick={() => act("CLOCK_OUT")}
                disabled={busy}
                className="flex-1 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />} Clock Out
              </button>
            )}
          </div>

          {anchorOf && !shift && (
            <p className="text-[10px] text-slate-500 flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {anchorOf.anchored
                ? `Branch anchored — alerts if you're farther than ${anchorOf.gpsRadiusM}m`
                : "Branch location not anchored — a manager can set it from Payroll → Attendance"}
            </p>
          )}
          {status && <p data-testid="att-clock-status" className="text-[11px] text-cyan-300">{status}</p>}
        </div>
      )}
    </div>
  );
}
