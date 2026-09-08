/* GoMina 360 — Web Push service worker.
 *
 * Receives server pushes and shows an OS-level notification (phone / laptop)
 * even when nobody has the app open — Gmail-style. Clicking a notification
 * focuses an existing app tab (navigating it to the deep link) or opens a
 * fresh one on the relevant page (/?tab=…).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    try { data = { body: event.data ? event.data.text() : "" }; } catch (__) {}
  }
  const title = data.title || "GoMina 360";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.tag || "gomina-360",
      renotify: true,
      data: { url: data.url || "/", type: data.type || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        // Prefer an already-open app tab: navigate + focus it (no duplicates).
        for (const client of list) {
          if (client.url && client.url.startsWith(self.location.origin)) {
            client.focus();
            if ("navigate" in client) client.navigate(url);
            return;
          }
        }
        return clients.openWindow(url);
      }),
  );
});
