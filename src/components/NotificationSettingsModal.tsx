"use client";

import React, { useCallback, useEffect, useState } from "react";
import { X, BellRing, Smartphone, Send, ShieldAlert, CheckCircle2, BellOff } from "lucide-react";
import {
  pushSupported,
  subscribeThisDevice,
  unsubscribeThisDevice,
  thisDeviceSubscribed,
} from "@/lib/pushClient";

const CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: "orders", label: "Orders", hint: "Online orders, status changes, purchases" },
  { key: "approvals", label: "Approvals", hint: "Flags, corrections, resolutions, verifications" },
  { key: "alerts", label: "Alerts", hint: "Stock & operational warnings" },
  { key: "tasks", label: "Tasks", hint: "Checklists & assigned duties" },
  { key: "messages", label: "Messages", hint: "Issue responses & discussions" },
  { key: "reports", label: "Reports", hint: "Report-ready & export summaries" },
];

/**
 * Notification settings — every user manages their own phone/laptop
 * (Web Push) notifications here: enable this device, choose the categories
 * that may reach them, and fire a live test notification.
 */
export default function NotificationSettingsModal({
  isOpen,
  onClose,
  currentUser,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentUser: any;
}) {
  const [supported] = useState(() => pushSupported());
  const [permission, setPermission] = useState<string>("default");
  const [deviceOn, setDeviceOn] = useState(false);
  const [settings, setSettings] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!supported) return;
    setPermission(Notification.permission);
    const endpoint = await thisDeviceSubscribed();
    setDeviceOn(!!endpoint);
    try {
      const res = await fetch("/api/push/settings");
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) setSettings(body.settings);
    } catch {}
  }, [supported]);

  useEffect(() => {
    if (isOpen) {
      setNotice("");
      setTestResult("");
      void load();
    }
  }, [isOpen, load]);

  if (!isOpen) return null;

  const save = async (patch: any) => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) setSettings(body.settings);
    } catch {}
    setBusy(false);
  };

  const enable = async () => {
    setBusy(true);
    setNotice("");
    const r = await subscribeThisDevice();
    if (r.ok) {
      setDeviceOn(true);
      setPermission("granted");
      await save({ enabled: true });
      setNotice("This device now receives GoMina 360 notifications — even when you are not inside the app.");
    } else {
      setPermission(typeof Notification !== "undefined" ? Notification.permission : "default");
      setNotice(
        r.reason === "denied"
          ? "Your browser has BLOCKED notifications for this site. Unblock them in the browser's site settings (lock icon → Notifications), then try again."
          : `Could not enable push on this device (${r.reason || "unknown"}). The in-app bell keeps working regardless.`,
      );
    }
    setBusy(false);
  };

  const disableDevice = async () => {
    setBusy(true);
    await unsubscribeThisDevice();
    setDeviceOn(false);
    setNotice("This device was unsubscribed. Other devices (if any) keep receiving notifications.");
    setBusy(false);
  };

  const sendTest = async () => {
    setTestBusy(true);
    setTestResult("");
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        if (!body.subscriptions) {
          setTestResult("No subscribed device for your account yet — tap “Enable on this device” first.");
        } else if (body.sent > 0) {
          setTestResult(`Sent to ${body.sent} device${body.sent === 1 ? "" : "s"} — check your notifications!`);
        } else {
          setTestResult(`Dispatch ran (${body.attempted} device${body.attempted === 1 ? "" : "s"}, none accepted${body.pruned ? `, ${body.pruned} stale removed` : ""}). Re-enable this device and retry.`);
        }
      } else {
        setTestResult("Test failed — please try again.");
      }
    } catch {
      setTestResult("Network error — could not send the test.");
    }
    setTestBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      data-testid="notif-settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Notification settings"
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-slate-800 shrink-0">
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shrink-0">
            <BellRing className="w-5 h-5 text-slate-950" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-black text-white leading-tight">Notification Settings</h2>
            <p className="text-[10px] text-slate-400 leading-tight">
              Phone &amp; laptop alerts for {currentUser?.name || "you"} — like Gmail.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white shrink-0" aria-label="Close" data-testid="notif-settings-close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {!supported ? (
            <div className="flex items-start gap-2.5 rounded-xl bg-amber-500/10 border border-amber-500/40 px-3.5 py-3" data-testid="push-unsupported">
              <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-200">
                This browser does not support push notifications. The in-app bell (top bar) keeps working —
                try Chrome, Edge or a recent Android/Safari browser for phone &amp; laptop alerts.
              </p>
            </div>
          ) : (
            <>
              {/* Device state */}
              <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-3 space-y-2">
                <p className="text-[11px] text-slate-300 flex items-center gap-1.5" data-testid="push-state">
                  <Smartphone className="w-3.5 h-3.5 text-cyan-300" />
                  {deviceOn
                    ? "This device is subscribed — GoMina 360 notifications reach it even when you are not inside the app."
                    : permission === "denied"
                    ? "Notifications are BLOCKED in this browser — enable them in site settings to use push."
                    : "This device is not subscribed yet."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {!deviceOn ? (
                    <button
                      onClick={enable}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold disabled:opacity-40"
                      data-testid="push-enable"
                    >
                      <BellRing className="w-3.5 h-3.5" /> {busy ? "Enabling…" : "Enable on this device"}
                    </button>
                  ) : (
                    <button
                      onClick={disableDevice}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 text-[11px] font-bold disabled:opacity-40"
                      data-testid="push-disable-device"
                    >
                      <BellOff className="w-3.5 h-3.5" /> Unsubscribe this device
                    </button>
                  )}
                  <button
                    onClick={sendTest}
                    disabled={testBusy}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-bold disabled:opacity-40"
                    data-testid="push-test"
                  >
                    <Send className="w-3.5 h-3.5" /> {testBusy ? "Sending…" : "Send test notification"}
                  </button>
                </div>
                {testResult && (
                  <p className="text-[10px] font-bold text-cyan-300" data-testid="push-test-result">{testResult}</p>
                )}
                {notice && <p className="text-[10px] text-amber-200/90" data-testid="push-notice">{notice}</p>}
              </div>

              {/* Master + categories */}
              {settings && (
                <div className="space-y-2" data-testid="push-categories">
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 cursor-pointer">
                    <span className="text-[12px] font-extrabold text-white flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" /> All notifications
                    </span>
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-emerald-500"
                      checked={settings.enabled !== false}
                      disabled={busy}
                      onChange={(e) => save({ enabled: e.target.checked })}
                      data-testid="push-toggle-master"
                    />
                  </label>
                  <p className="text-[9px] uppercase tracking-wider font-bold text-slate-500 px-1">Categories that may reach you</p>
                  {CATEGORIES.map((c) => (
                    <label
                      key={c.key}
                      className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3.5 py-2.5 cursor-pointer"
                    >
                      <span className="min-w-0">
                        <span className="block text-[12px] font-bold text-slate-200">{c.label}</span>
                        <span className="block text-[9px] text-slate-500 truncate">{c.hint}</span>
                      </span>
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-emerald-500 shrink-0"
                        checked={settings[c.key] !== false}
                        disabled={busy || settings.enabled === false}
                        onChange={(e) => save({ [c.key]: e.target.checked })}
                        data-testid={`push-toggle-${c.key}`}
                      />
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
