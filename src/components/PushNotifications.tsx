"use client";

import { useEffect, useRef, useState } from "react";
import { registerPushSW, thisDeviceSubscribed, pushSupported } from "@/lib/pushClient";

/**
 * Background push bootstrapper (no UI beyond hidden state testids).
 * On every sign-in: registers /sw.js and — when the browser already granted
 * notification permission and this device is subscribed — re-syncs the
 * subscription row to the server (covers key rotations & DB restores).
 */
export default function PushNotifications({ currentUser }: { currentUser: any }) {
  const [state, setState] = useState<"off" | "sw" | "subscribed">("off");
  const done = useRef(false);

  useEffect(() => {
    if (!currentUser?.id || done.current) return;
    done.current = true;
    (async () => {
      if (!pushSupported()) return;
      const reg = await registerPushSW();
      if (!reg) return;
      setState("sw");
      try {
        if (Notification.permission !== "granted") return;
        const endpoint = await thisDeviceSubscribed();
        if (!endpoint) return;
        const reg2 = await navigator.serviceWorker.getRegistration("/sw.js");
        const sub = await reg2?.pushManager.getSubscription();
        if (!sub) return;
        await fetch("/api/push/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint, keys: sub.toJSON().keys, userAgent: navigator.userAgent }),
        });
        setState("subscribed");
      } catch {}
    })();
  }, [currentUser?.id]);

  return <span className="hidden" data-testid="push-sync-state" data-state={state} />;
}
