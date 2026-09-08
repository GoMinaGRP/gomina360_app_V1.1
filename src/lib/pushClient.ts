"use client";

/** Browser-side Web Push helpers (service worker registration + subscribe). */

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerPushSW(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/** Subscribe this device (asks the OS permission first), then sync to server. */
export async function subscribeThisDevice(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: perm };
    const reg = await registerPushSW();
    if (!reg) return { ok: false, reason: "sw-failed" };
    const ready = await navigator.serviceWorker.ready;
    const keyRes = await fetch("/api/push/vapid");
    const keyBody = await keyRes.json().catch(() => null);
    const publicKey = keyBody?.publicKey;
    if (!keyRes.ok || !publicKey) return { ok: false, reason: "no-vapid" };
    let sub = await ready.pushManager.getSubscription();
    if (!sub) {
      sub = await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey) as BufferSource,
      });
    }
    const json = sub.toJSON();
    await fetch("/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys, userAgent: navigator.userAgent }),
    });
    void reg;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "subscribe-failed" };
  }
}

/** True while this exact device holds a live subscription for the app. */
export async function thisDeviceSubscribed(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint || null;
  } catch {
    return null;
  }
}

/** Unsubscribe this device locally + on the server. */
export async function unsubscribeThisDevice(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    const endpoint = sub?.endpoint;
    await sub?.unsubscribe().catch(() => {});
    if (endpoint) {
      await fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    }
  } catch {}
}
