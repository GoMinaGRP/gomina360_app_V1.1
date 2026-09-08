"use client";

// Auto-logout after 10 minutes of user inactivity (Gmail-style). Activity =
// real DOM interaction: mouse, keyboard, touch, scroll, wheel. Background
// timers, visibility of an idle tab, or server-side keepalives do NOT count —
// a laptop left open in the office signs itself out on its own.
//
// Test seam: sessionStorage "gomina.idleMs" (milliseconds) overrides the
// 10-minute window for automated suites; production never sets it.

import { useEffect } from "react";

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "wheel"] as const;
const DEFAULT_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const CHECK_EVERY_MS = 5000;

export default function IdleLogout({ active, onIdle }: { active: boolean; onIdle: () => void }) {
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    let disposed = false;
    let queued = false;
    // High-frequency events (mousemove/scroll) are throttled to ~1 bump/sec.
    const onEvent = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        last = Date.now();
      }, 1000);
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onEvent, { passive: true });
    const timer = setInterval(() => {
      if (disposed) return;
      let idleMs = DEFAULT_IDLE_MS;
      try {
        idleMs = Number(sessionStorage.getItem("gomina.idleMs")) || DEFAULT_IDLE_MS;
      } catch {
        /* storage blocked — keep the default */
      }
      if (Date.now() - last >= idleMs) onIdle();
    }, CHECK_EVERY_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onEvent);
    };
  }, [active, onIdle]);
  return null;
}
