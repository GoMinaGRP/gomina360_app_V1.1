"use client";

import React from "react";
import { Bell, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, Sparkles, ShieldAlert, Activity, Egg, ListChecks } from "lucide-react";
import { CurrencyCode, formatMoney } from "@/lib/currency";
import { PoultryAlert, PerformanceMetric, ALERT_STYLES, METRIC_COLORS } from "@/lib/poultryAnalytics";

interface Props {
  alerts: PoultryAlert[];
  metrics: PerformanceMetric[];
  healthScore: number;
  statusColor: "green" | "yellow" | "red";
  currency: CurrencyCode;
  /** false on a brand-new farm (no flocks / logs / records yet): the panel
      shows a neutral "ready to start" state instead of a misleading 100. */
  hasData?: boolean;
}

export default function PoultryAnalyticsAlerts({ alerts, metrics, healthScore, statusColor, hasData = true }: Props) {
  if (!hasData) {
    return (
      <div className="space-y-4" data-testid="pa-empty">
        <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col justify-center">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Activity className="w-4 h-4" /> Poultry Health & Performance Score
            </div>
            <div className="flex items-end gap-2 mt-1">
              <span className="text-4xl font-black text-slate-500">—</span>
              <span className="text-xs text-slate-500 mb-1">/ 100</span>
            </div>
            <div className="w-full max-w-xs h-2.5 bg-slate-800 rounded-full overflow-hidden mt-2">
              <div className="h-full bg-slate-700 transition-all" style={{ width: "0%" }} />
            </div>
            <p className="text-[10px] text-slate-500 mt-2">Scores appear once your first records are in.</p>
          </div>
          <div className="md:col-span-2 flex items-center">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center shrink-0">
                <Egg className="w-5 h-5 text-emerald-300" />
              </div>
              <div>
                <div className="text-sm font-bold text-white">This farm is ready to go</div>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  Brand-new unit — no flocks or logs yet. Start with your first flock, then capture daily feed,
                  water, health and production logs: the health score, smart alerts and performance metrics
                  switch on automatically from real data.
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex items-center gap-2 mb-3">
            <ListChecks className="w-4 h-4 text-cyan-300" />
            <h3 className="text-sm font-bold text-white">First steps for this farm</h3>
          </div>
          <ol className="space-y-2 text-[11px] text-slate-300">
            <li className="flex gap-2"><span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-black flex items-center justify-center shrink-0">1</span><span><span className="font-bold text-white">Register the first flock</span> (Flocks tab) — batch, birds in, source and date.</span></li>
            <li className="flex gap-2"><span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-black flex items-center justify-center shrink-0">2</span><span><span className="font-bold text-white">Log today's feed & water</span> (Daily Ops) — builds the consumption trends.</span></li>
            <li className="flex gap-2"><span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-black flex items-center justify-center shrink-0">3</span><span><span className="font-bold text-white">Record production & health checks</span> — egg/harvest counts, vaccinations, any mortality.</span></li>
          </ol>
        </div>
      </div>
    );
  }

  const critical = alerts.filter((a) => a.level === "critical");
  const warning = alerts.filter((a) => a.level === "warning");
  const normal = alerts.filter((a) => a.level === "normal");

  const scoreBarColor =
    statusColor === "red" ? "bg-rose-500" : statusColor === "yellow" ? "bg-amber-500" : "bg-emerald-500";
  const scoreTextColor =
    statusColor === "red" ? "text-rose-400" : statusColor === "yellow" ? "text-amber-400" : "text-emerald-400";

  return (
    <div className="space-y-4">
      {/* Health Score + Summary */}
      <div className={`rounded-2xl border p-5 grid grid-cols-1 md:grid-cols-3 gap-4 ${
        statusColor === "red" ? "bg-rose-500/10 border-rose-500/30"
        : statusColor === "yellow" ? "bg-amber-500/10 border-amber-500/30"
        : "bg-emerald-500/10 border-emerald-500/30"
      }`}>
        <div className="flex flex-col justify-center">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <Activity className="w-4 h-4" /> Poultry Health & Performance Score
          </div>
          <div className="flex items-end gap-2 mt-1">
            <span className={`text-4xl font-black ${scoreTextColor}`}>{healthScore}</span>
            <span className="text-xs text-slate-400 mb-1">/ 100</span>
          </div>
          <div className="w-full max-w-xs h-2.5 bg-slate-800 rounded-full overflow-hidden mt-2">
            <div className={`h-full ${scoreBarColor} transition-all`} style={{ width: `${healthScore}%` }} />
          </div>
        </div>

        <div className="flex items-center justify-around md:col-span-2">
          <div className="text-center">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-rose-500/20 border border-rose-500/40">
              <ShieldAlert className="w-5 h-5 text-rose-400" />
            </div>
            <div className="mt-1 text-2xl font-black text-rose-400">{critical.length}</div>
            <div className="text-[10px] text-slate-400 uppercase">Critical</div>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/40">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            </div>
            <div className="mt-1 text-2xl font-black text-amber-400">{warning.length}</div>
            <div className="text-[10px] text-slate-400 uppercase">Warning</div>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="mt-1 text-2xl font-black text-emerald-400">{normal.length}</div>
            <div className="text-[10px] text-slate-400 uppercase">Normal</div>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-slate-700 border border-slate-600">
              <Bell className="w-5 h-5 text-slate-300" />
            </div>
            <div className="mt-1 text-2xl font-black text-slate-200">{alerts.length}</div>
            <div className="text-[10px] text-slate-400 uppercase">Total</div>
          </div>
        </div>
      </div>

      {/* Smart Alerts feed */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-white">Smart Alerts & Warnings</h3>
          <span className="text-[10px] text-slate-400">Auto-updates as data is entered</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-105 overflow-y-auto pr-1">
          {alerts.map((alert) => (
            <div key={alert.id} className={`rounded-xl border p-3 ${ALERT_STYLES[alert.level]}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {alert.level === "critical" ? (
                    <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
                  ) : alert.level === "warning" ? (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">{alert.category}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        alert.level === "critical" ? "bg-rose-500/30 text-rose-200" : alert.level === "warning" ? "bg-amber-500/30 text-amber-200" : "bg-emerald-500/30 text-emerald-200"
                      }`}>{alert.level}</span>
                    </div>
                    <div className="text-[13px] font-bold mt-0.5">{alert.title}</div>
                  </div>
                </div>
              </div>
              <p className="text-[11px] leading-snug mt-1.5 opacity-90">{alert.message}</p>
              <div className="flex items-center justify-between mt-2 text-[10px]">
                {alert.value && alert.threshold && (
                  <span><span className="font-bold">Now: </span>{alert.value} <span className="opacity-60">| Target: {alert.threshold}</span></span>
                )}
                <span className="opacity-60">{alert.timestamp}</span>
              </div>
              <div className="mt-2 text-[11px] bg-slate-900/40 rounded-lg p-2 leading-snug">
                <span className="font-bold text-cyan-300">💡 Recommendation: </span>
                <span className="text-slate-200">{alert.recommendation}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Performance Metrics */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-white">Key Performance Indicators</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {metrics.map((m) => (
            <div key={m.label} className={`rounded-xl border bg-slate-900/60 p-3 ${METRIC_COLORS[m.color] || METRIC_COLORS.green}`}>
              <div className="text-[10px] uppercase font-bold opacity-70">{m.label}</div>
              <div className="text-lg font-black mt-1">{m.current}</div>
              <div className="flex items-center justify-between mt-1 text-[10px] opacity-70">
                <span>Prev: {m.previous}</span>
                <span className="flex items-center gap-0.5 font-bold">
                  {m.trend === "declining" ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                  {Math.abs(m.changePct).toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
