"use client";

// Notification bell — sits on every dashboard. Flagged issues & required
// corrections reach the assigned user here instantly; responses reach the
// reviewing auditor. Clicking a notification opens the right workspace
// (My Issues for the assignee, the Audit Center for the reviewer).

import { useCallback, useEffect, useState } from "react";
import { Bell, CheckCheck, Flag, Inbox, Settings } from "lucide-react";
import { useClampedDropdown } from "./nav/useClampedDropdown";

type Notif = any;

export default function NotificationBell({
  currentUser,
  onOpenIssue,
  onOpenRecord,
  onOpenSettings,
  onSummary,
}: {
  currentUser: any;
  onOpenIssue: (n: Notif) => void;
  /** Non-issue rows (orders, purchases, status changes…): go to the page
   *  the event belongs to — e.g. Customer Order & Tracking. */
  onOpenRecord?: (n: Notif) => void;
  /** Gear in the panel header → notification & push settings. */
  onOpenSettings?: () => void;
  onSummary?: (s: { unread: number; openAssigned: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  // Viewport-clamped panel — the bell sits near the right edge; on phones
  // its `absolute right-0` panel could extend past the LEFT screen edge.
  // width 384 clamps to (vw − 16px) automatically on narrow screens.
  const { rootRef: panelRef, panelStyle } = useClampedDropdown(open, 384);

  const load = useCallback(async () => {
    if (!currentUser?.id) return;
    try {
      const res = await fetch("/api/notifications");
      const body = await res.json();
      if (!res.ok || !body.success) return;
      setItems(body.notifications || []);
      setUnread(body.unreadCount || 0);
      onSummary?.({ unread: body.unreadCount || 0, openAssigned: body.openAssignedCount || 0 });
    } catch {
      /* transient — next poll recovers */
    }
  }, [currentUser?.id, onSummary]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [load]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const markAll = async () => {
    await fetch("/api/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) });
    load();
  };

  const clickItem = async (n: Notif) => {
    if (!n.isRead) {
      fetch("/api/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [n.id] }) }).then(load);
    }
    setOpen(false);
    if (n.issueId) onOpenIssue(n);
    else onOpenRecord?.(n);
  };

  const ago = (v: any) => {
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  return (
    <div className="relative shrink-0" ref={panelRef}>
      <button
        onClick={() => { setOpen(!open); if (!open) load(); }}
        className="relative p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
        title="Notifications — flagged issues, corrections & responses"
        data-testid="notif-bell"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center shadow" data-testid="notif-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="overflow-y-auto rounded-xl bg-slate-800 border border-slate-700 shadow-2xl z-50" style={panelStyle} data-testid="notif-panel">
          <div className="sticky top-0 flex items-center justify-between px-3 py-2.5 bg-slate-800/95 backdrop-blur border-b border-slate-700">
            <div className="text-xs font-black text-white flex items-center gap-1.5">
              Notifications
              {unread > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">{unread} new</span>}
            </div>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={markAll} className="flex items-center gap-1 text-[10px] font-bold text-teal-300 hover:text-teal-200" data-testid="notif-mark-all">
                  <CheckCheck className="w-3 h-3" /> Mark all read
                </button>
              )}
              {onOpenSettings && (
                <button
                  onClick={() => { setOpen(false); onOpenSettings(); }}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition"
                  title="Notification settings — phone/laptop push, categories, test"
                  data-testid="notif-settings"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500 text-xs flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6" /> All clear — no notifications.
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                onClick={() => clickItem(n)}
                className={`w-full text-left px-3 py-2.5 border-b border-slate-700/60 last:border-0 hover:bg-slate-700/60 transition ${n.isRead ? "opacity-70" : ""}`}
                data-testid={`notif-item-${n.id}`}
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${n.isRead ? "bg-slate-600" : "bg-rose-400"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-bold text-slate-100 flex items-center gap-1.5">
                      {String(n.type).includes("CORRECTION") ? <Flag className="w-3 h-3 text-amber-400 shrink-0" /> : null}
                      <span className="truncate">{n.title}</span>
                    </div>
                    {n.body && <div className="text-[10px] text-slate-400 line-clamp-2 mt-0.5">{n.body}</div>}
                    <div className="text-[9px] text-slate-500 mt-1">
                      {n.actorName ? `${n.actorName} · ` : ""}{ago(n.createdAt)}{n.recordRef ? ` · ${n.recordRef}` : ""}
                      {n.issueId || onOpenRecord ? " · tap to open" : ""}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
