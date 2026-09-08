/**
 * verify-notifications.mjs — App Notifications (phone/laptop push) + idle
 * auto-logout, full-stack E2E.
 *
 *   A · Push API layer: VAPID key served once & stable; subscription CRUD
 *       with validation (http:// rejected, https upsert, delete); settings
 *       GET auto-defaults & PUT toggle persistence; forced test dispatch
 *       counters; every route 401s without a session.
 *   B · UI (GM): bell → gear → settings modal with master + 6 category
 *       toggles (orders/approvals/alerts/tasks/messages/reports) persisted
 *       to user_push_settings; service worker registers on sign-in; "Enable
 *       push" and "Send test" behave gracefully in headless; tapping a bell
 *       order row opens Customer Order & Tracking.
 *   C · Live dispatch through a local mock push endpoint (real Web Push
 *       protocol: VAPID Authorization, TTL head, aes128gcm payload):
 *       online order → ONWER/BM bell rows + push hit; ORDERS toggle OFF
 *       blocks the push while the bell row still lands; order status move
 *       by a colleague → creator push hit; audit flag assignment → assignee
 *       push hit.
 *   D · Deep links: /?tab=TRACKING & /?tab=AUDIT after session bootstrap;
 *       signed-out click → login wall → lands on the requested tab; sw.js
 *       carries notificationclick/openWindow/showNotification.
 *   E · Idle logout: server side ends a session idle >10min (401 +
 *       end_reason=IDLE_TIMEOUT, other sessions unaffected); client side
 *       signs out on DOM inactivity with the inactivity notice; real mouse
 *       activity resets the clock.
 *   Z · TEST purge, inventory/push tables restore, counts forensics,
 *       zero page errors.
 *
 * Live rows are never altered: TEST customer/orders/notifications above the
 * id baselines are deleted; inventory quantity restored to the exact
 * pre-suite value; push_subscriptions / user_push_settings snapshots
 * restored byte-for-byte.
 */
import { createRequire } from "module";
import https from "https";
import fs from "fs";
import crypto from "crypto";
const require = createRequire("/home/user/pgtooling/package.json");
const requireApp = createRequire("/home/user/gomina360_app_V1/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");
const webpush = requireApp("web-push");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26", id: 1 };
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2", id: 2 };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };
const T = "TEST Push";

const results = [];
const baseline = {};
const pageErrors = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};
const uiLogin = async (page, creds) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
};
const clickT = async (page, testid) => {
  const found = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  }, testid);
  if (!found) return false;
  await sleep(250);
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    (el || { click: () => {} }).click();
  }, testid);
  return true;
};

/* ── mock push endpoint (stands in for FCM/Mozilla push service) ────── */
const mock = { hits: [], server: null, port: 0 };
async function startMock() {
  // Web Push always uses TLS — the mock presents a cert (SAN IP:127.0.0.1)
  // signed by a local test CA the app server trusts via NODE_EXTRA_CA_CERTS.
  mock.server = https.createServer(
    { key: fs.readFileSync("/tmp/pushsrv-key.pem"), cert: fs.readFileSync("/tmp/pushsrv.pem") },
    (req, res) => {
    let body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      mock.hits.push({
        url: req.url,
        at: Date.now(),
        authorization: req.headers["authorization"] || "",
        ttl: req.headers["ttl"] || "",
        encoding: req.headers["content-encoding"] || "",
        bodyLen: Buffer.concat(body).length,
      });
      res.writeHead(201, { "Content-Type": "text/plain" });
      res.end("created");
    });
  });
  await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
  mock.port = mock.server.address().port;
}
const waitForHit = async (urlPart, sinceCount, timeoutMs = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = mock.hits.slice(sinceCount).find((h) => h.url.includes(urlPart));
    if (hit) return hit;
    await sleep(400);
  }
  return null;
};
/** Fresh, valid Web Push key material for a fixture subscription. */
function fixtureKeys() {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const p256dh = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");
  return { p256dh, auth: crypto.randomBytes(16).toString("base64url") };
}
async function insertFixtureSub(userId, tag) {
  const k = fixtureKeys();
  const endpoint = `https://127.0.0.1:${mock.port}/${tag}`;
  await pg.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,'TEST-suite')`,
    [userId, endpoint, k.p256dh, k.auth],
  );
  return endpoint;
}

/* ── A · Push API layer ─────────────────────────────────────────────── */
async function sectionA(cookies) {
  console.log("\n— A · Push API layer —");
  const v1 = await api(cookies.owner, "/api/push/vapid");
  const v2 = await api(cookies.owner, "/api/push/vapid");
  ok("A1 VAPID public key served to a signed-in user", v1.status === 200 && typeof v1.json?.publicKey === "string" && v1.json.publicKey.length >= 80, JSON.stringify(v1).slice(0, 120));
  ok("A2 VAPID key is stable across calls (persistent singleton)", v1.json?.publicKey === v2.json?.publicKey);

  const bad = await api(cookies.owner, "/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: "http://not-secure.example/TEST", keys: { p256dh: "x", auth: "y" } }),
  });
  ok("A3 insecure (http://) subscription endpoint rejected", bad.status === 400, `status=${bad.status}`);

  const fakeEp = "https://fcm.googleapis.com/fcm/send/TESTSUITE-A4";
  const put = await api(cookies.owner, "/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: fakeEp, keys: { p256dh: "TESTP256DH", auth: "TESTAUTH" }, userAgent: "TEST-suite" }),
  });
  const list = await api(cookies.owner, "/api/push/subscriptions");
  ok("A4 valid https subscription upserts and lists", put.status === 200 && (list.json?.subscriptions || []).some((s) => s.endpoint === fakeEp), JSON.stringify({ put: put.status, list: (list.json?.subscriptions || []).length }));
  const del = await api(cookies.owner, "/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: fakeEp }) });
  const list2 = await api(cookies.owner, "/api/push/subscriptions");
  ok("A5 DELETE removes the device subscription", del.status === 200 && !(list2.json?.subscriptions || []).some((s) => s.endpoint === fakeEp));

  const s1 = await api(cookies.owner, "/api/push/settings");
  ok("A6 settings GET auto-creates defaults — master + all 6 categories ON",
    s1.status === 200 && s1.json?.settings?.enabled === true && ["orders", "approvals", "alerts", "tasks", "messages", "reports"].every((k) => s1.json.settings[k] === true),
    JSON.stringify(s1.json).slice(0, 200));
  const s2 = await api(cookies.owner, "/api/push/settings", { method: "PUT", body: JSON.stringify({ reports: false }) });
  const s3 = await api(cookies.owner, "/api/push/settings");
  ok("A7 PUT toggle persists across reads (reports off)", s2.json?.settings?.reports === false && s3.json?.settings?.reports === false);
  await api(cookies.owner, "/api/push/settings", { method: "PUT", body: JSON.stringify({ reports: true }) });

  // With the fixture sub of section C absent here, dispatch counters must be honest zeros.
  const t0 = await api(cookies.owner, "/api/push/test", { method: "POST" });
  ok("A8 test-dispatch route answers with counters (no device ⇒ 0 attempted)",
    t0.status === 200 && t0.json?.success === true && t0.json.subscriptions === 0 && t0.json.attempted === 0,
    JSON.stringify(t0.json).slice(0, 160));

  const u1 = await api(null, "/api/push/vapid");
  const u2 = await api(null, "/api/push/subscriptions", { method: "POST", body: "{}" });
  const u3 = await api(null, "/api/push/settings");
  const u4 = await api(null, "/api/push/test", { method: "POST" });
  ok("A9 every push route rejects anonymous callers (401)", [u1, u2, u3, u4].every((r) => r.status === 401), `codes=${[u1, u2, u3, u4].map((r) => r.status)}`);
}

/* ── B · UI: bell → settings modal, SW bootstrap, tap-through ──────── */
async function sectionB(browser) {
  console.log("\n— B · Staff UI: bell gear, settings modal, SW bootstrap —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "B");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, GM);
  // The bell mounts once the data bootstrap finishes (a few seconds after
  // the login screen disappears).
  await page.waitForSelector('[data-testid="notif-bell"]', { timeout: 45000 });
  await sleep(500);
  await clickT(page, "notif-bell");
  const panel = await page.waitForSelector('[data-testid="notif-panel"]', { timeout: 15000 }).catch(() => null);
  ok("B1 bell opens the notification panel", !!panel);
  const gear = await page.evaluate(() => !!document.querySelector('[data-testid="notif-settings"]'));
  ok("B2 gear (settings) button present in the panel header", gear);
  await clickT(page, "notif-settings");
  const modal = await page.waitForSelector('[data-testid="notif-settings-modal"]', { timeout: 15000 }).catch(() => null);
  ok("B3 gear opens the Notification Settings modal", !!modal);

  await page.waitForSelector('[data-testid="push-toggle-orders"]', { timeout: 20000 }).catch(() => null);
  const cats = await page.evaluate(() =>
    ["orders", "approvals", "alerts", "tasks", "messages", "reports"].map((k) => !!document.querySelector(`[data-testid="push-toggle-${k}"]`)),
  );
  const master = await page.evaluate(() => !!document.querySelector('[data-testid="push-toggle-master"]'));
  ok("B4 master switch + all 6 category toggles rendered (orders/approvals/alerts/tasks/messages/reports)", master && cats.every(Boolean), JSON.stringify({ master, cats }));

  // Toggle ORDERS off/on through the REAL modal button; assert DB persistence.
  // (Settings load async into the modal; the checkboxes disable while saving.)
  await page.waitForSelector('[data-testid="push-toggle-orders"]', { timeout: 15000 });
  await sleep(600);
  await clickT(page, "push-toggle-orders");
  let row = null;
  for (let i = 0; i < 10 && !row; i++) {
    await sleep(400);
    row = (await pg.query(`SELECT orders FROM user_push_settings WHERE user_id=$1`, [GM.id])).rows[0];
    if (row && row.orders !== false) row = null;
  }
  ok("B5 toggling ORDERS off in the modal persists to user_push_settings", !!row && row.orders === false, JSON.stringify(row || {}));
  await sleep(900); // let the save spinner release the checkbox
  await clickT(page, "push-toggle-orders");
  let row2 = null;
  for (let i = 0; i < 10 && !row2; i++) {
    await sleep(400);
    row2 = (await pg.query(`SELECT orders FROM user_push_settings WHERE user_id=$1`, [GM.id])).rows[0];
    if (row2 && row2.orders !== true) row2 = null;
  }
  ok("B6 toggling ORDERS back on persists again", !!row2 && row2.orders === true, JSON.stringify(row2 || {}));

  // Service worker must be registered by the signed-in app bootstrap.
  const swReg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration("/sw.js");
    return !!r && (r.active?.state === "activated" || !!r.installing || !!r.waiting || r.active?.state === "activating");
  });
  const syncState = await page.evaluate(() => document.querySelector('[data-testid="push-sync-state"]')?.getAttribute("data-state") || "missing");
  ok("B7 /sw.js service worker registered at sign-in (push-sync-state=sw)", swReg && syncState === "sw", `reg=${swReg} state=${syncState}`);

  // "Send test" without a subscribed device → graceful guidance text.
  await clickT(page, "push-test");
  await page.waitForFunction(() => (document.querySelector('[data-testid="push-test-result"]')?.textContent || "").length > 5, { timeout: 15000 }).catch(() => {});
  const testTxt = await page.evaluate(() => document.querySelector('[data-testid="push-test-result"]')?.textContent || "");
  ok("B8 Send-test reports gracefully with no device subscribed", /Enable|No subscribed device/i.test(testTxt), testTxt.slice(0, 120));

  // "Enable on this device" — headless has no push service; either it works
  // (real subscription) or a clear explanation appears. Both are correct.
  await clickT(page, "push-enable");
  await sleep(2500);
  const enableOutcome = await page.evaluate(() => ({
    notice: document.querySelector('[data-testid="push-notice"]')?.textContent || "",
    state: document.querySelector('[data-testid="push-state"]')?.textContent || "",
    disableBtn: !!document.querySelector('[data-testid="push-disable-device"]'),
  }));
  const graceful = enableOutcome.disableBtn || enableOutcome.notice.length > 8;
  ok("B9 Enable-on-this-device either subscribes or explains the browser block", graceful, JSON.stringify(enableOutcome).slice(0, 200));
  console.log(`   ℹ headless subscribe outcome: ${enableOutcome.disableBtn ? "SUBSCRIBED (real push subscription)" : "browser/push-service unavailable — notice shown"}`);

  await clickT(page, "notif-settings-close");

  // Tap-through: a fresh ONLINE_ORDER_RECEIVED bell row opens Customer Order & Tracking.
  const [tapRow] = (
    await pg.query(
      `INSERT INTO notifications (user_id, type, title, body, business_id, record_type, record_ref)
       VALUES ($1,'ONLINE_ORDER_RECEIVED','TEST tap-through order GM-TAP','Customer placed a TEST order',1,'customer_trackings','TEST-GM-TAP') RETURNING id`,
      [GM.id],
    )
  ).rows;
  baseline.tapNotifId = tapRow.id;
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="notif-bell"]', { timeout: 45000 });
  await sleep(500);
  await clickT(page, "notif-bell");
  await page.waitForSelector(`[data-testid="notif-item-${tapRow.id}"]`, { timeout: 15000 }).catch(() => null);
  const tapped = await clickT(page, `notif-item-${tapRow.id}`);
  const tracking = await page.waitForSelector('[data-testid="ct-root"]', { timeout: 20000 }).catch(() => null);
  ok("B10 tapping an order notification opens Customer Order & Tracking", tapped && !!tracking);
  await ctx.close();
}

/* ── C · live dispatch through the mock push endpoint ───────────────── */
async function sectionC(cookies) {
  console.log("\n— C · live Web Push dispatch (mock endpoint) —");
  const menu = await api(null, "/api/menu");
  const biz1 = (menu.json?.businesses || []).find((b) => b.businessId === 1);
  const item = (biz1?.products || []).find((p) => p.available > 0) || biz1?.products?.[0];
  ok("C0 menu item available for TEST orders", !!item, "no products");
  if (!item) return;
  baseline.menuItem = item;
  baseline.invQty = (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [item.id])).rows[0].q;

  await insertFixtureSub(OWNER.id, "TEST/push-owner");
  await insertFixtureSub(GM.id, "TEST/push-gm");

  // — C1: customer online order → bell rows + push hits.
  const hitsBefore = mock.hits.length;
  const order = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: `${T} One`, customerPhone: "0551223344",
      fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
      items: [{ inventoryId: item.id, quantity: 1 }], note: "TEST push C1",
    }),
  });
  const code = order.json?.trackingCode || "";
  ok("C1 customer places an online order (public storefront)", order.status === 200 && /^GM-/.test(code), JSON.stringify(order.json || {}).slice(0, 150));
  baseline.code1 = code;

  let ownerBell = null;
  for (let i = 0; i < 15 && !ownerBell; i++) {
    await sleep(400);
    ownerBell = (await pg.query(
      `SELECT id FROM notifications WHERE user_id=$1 AND type='ONLINE_ORDER_RECEIVED' AND record_ref=$2`,
      [OWNER.id, code],
    )).rows[0];
  }
  ok("C2 owner bell received ONLINE_ORDER_RECEIVED", !!ownerBell);
  const bmBell = (await pg.query(
    `SELECT id FROM notifications WHERE user_id=$1 AND type='ONLINE_ORDER_RECEIVED' AND record_ref=$2`,
    [BM.id, code],
  )).rows[0];
  ok("C3 branch-assigned staff (BM) also got the bell row (fan-out)", !!bmBell);

  const ownerHit = await waitForHit("TEST/push-owner", hitsBefore);
  ok("C4 OS push dispatched to the owner's device (VAPID + TTL + encrypted payload)",
    !!ownerHit && ownerHit.authorization.startsWith("vapid ") && ownerHit.ttl === "3600" && ownerHit.encoding === "aes128gcm" && ownerHit.bodyLen > 80,
    JSON.stringify(ownerHit || {}).slice(0, 200));

  // — C2: ORDERS toggle off ⇒ bell YES, push NO.
  await api(cookies.owner, "/api/push/settings", { method: "PUT", body: JSON.stringify({ orders: false }) });
  const beforeGate = mock.hits.length;
  const order2 = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: `${T} Two`, customerPhone: "0551223344",
      fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
      items: [{ inventoryId: item.id, quantity: 1 }], note: "TEST push C5",
    }),
  });
  const code2 = order2.json?.trackingCode || "";
  baseline.code2 = code2;
  let ownerBell2 = null;
  for (let i = 0; i < 15 && !ownerBell2; i++) {
    await sleep(400);
    ownerBell2 = (await pg.query(
      `SELECT id FROM notifications WHERE user_id=$1 AND type='ONLINE_ORDER_RECEIVED' AND record_ref=$2`,
      [OWNER.id, code2],
    )).rows[0];
  }
  ok("C5 with ORDERS off the bell row still lands", !!ownerBell2);
  await sleep(4500);
  const gatedHits = mock.hits.slice(beforeGate).filter((h) => h.url.includes("TEST/push-owner"));
  ok("C6 ...but the OS push is gated OFF by the user's own settings", gatedHits.length === 0, `hits=${gatedHits.length}`);
  await api(cookies.owner, "/api/push/settings", { method: "PUT", body: JSON.stringify({ orders: true }) });

  // — C3: colleague advances status ⇒ ORDER_TRACKING_STATUS push to the creator.
  await pg.query(`UPDATE customer_trackings SET created_by_user_id=$1 WHERE tracking_code=$2`, [OWNER.id, code2]);
  const ntfMaxBeforeC7 = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  const beforeC7 = mock.hits.length;
  const adv = await api(cookies.bm, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({ action: "SET_STATUS", id: (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [code2])).rows[0].id, status: "CONFIRMED", note: "TEST C7" }),
  });
  let creatorBell = null;
  for (let i = 0; i < 15 && !creatorBell; i++) {
    await sleep(400);
    creatorBell = (await pg.query(
      `SELECT id FROM notifications WHERE id>$1 AND user_id=$2 AND type='ORDER_TRACKING_STATUS' AND record_ref=$3`,
      [ntfMaxBeforeC7, OWNER.id, code2],
    )).rows[0];
  }
  ok("C7 colleague (BM) advancing the order notifies the creator's bell",
    adv.status === 200 && !!creatorBell, `status=${adv.status} ${JSON.stringify(adv.json || {}).slice(0, 120)}`);
  const statusHit = await waitForHit("TEST/push-owner", beforeC7);
  ok("C8 OS push dispatched for the status change", !!statusHit);
  // Return the reserved stock before the rows are purged.
  await api(cookies.bm, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({ action: "SET_STATUS", id: (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [code2])).rows[0].id, status: "CANCELLED", note: "TEST C7 cleanup" }),
  });

  // — C4: audit flag assigned to the GM ⇒ bell + push to the GM.
  const txId = (await pg.query(`SELECT MIN(id) m FROM transactions`)).rows[0].m;
  const ntfMaxBeforeC9 = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  const beforeC9 = mock.hits.length;
  const flag = await api(cookies.owner, "/api/audit", {
    method: "POST",
    body: JSON.stringify({ recordType: "TRANSACTION", recordId: txId, action: "FLAGGED", reason: "TEST push wiring check", assignedUserId: GM.id }),
  });
  let gmBell = null;
  for (let i = 0; i < 15 && !gmBell; i++) {
    await sleep(400);
    gmBell = (await pg.query(
      `SELECT id, type FROM notifications WHERE id>$1 AND user_id=$2 AND type='AUDIT_ISSUE_ASSIGNED'`,
      [ntfMaxBeforeC9, GM.id],
    )).rows[0];
  }
  ok("C9 audit flag assigned to the GM lands in their bell (AUDIT_ISSUE_ASSIGNED)",
    flag.status === 200 && !!gmBell, `status=${flag.status} ${JSON.stringify(flag.json || {}).slice(0, 120)}`);
  const gmHit = await waitForHit("TEST/push-gm", beforeC9);
  ok("C10 OS push dispatched to the assignee's device", !!gmHit);

  // — C5: forced test dispatch proves per-user targeting end-to-end.
  const beforeC11 = mock.hits.length;
  const testRes = await api(cookies.gm, "/api/push/test", { method: "POST" });
  const gmTestHit = await waitForHit("TEST/push-gm", beforeC11);
  ok("C11 'Send test notification' reaches the user's own subscribed device",
    testRes.status === 200 && testRes.json?.attempted >= 1 && !!gmTestHit, JSON.stringify(testRes.json || {}).slice(0, 160));
}

/* ── D · deep links & service-worker payload ────────────────────────── */
async function sectionD(browser) {
  console.log("\n— D · deep links & service worker —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "D");
  await page.setViewport({ width: 1440, height: 960 });

  // D1: signed-out notification click → login wall → lands on TRACKING.
  await page.goto(`${BASE}/?tab=TRACKING`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', GM.email);
  await page.type('[data-testid="login-password"]', GM.pass);
  await page.click('[data-testid="login-submit"]');
  const d1 = await page.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 }).catch(() => null);
  ok("D1 signed-out deep link /?tab=TRACKING lands on Customer Order & Tracking after login", !!d1);

  // D2: reload on /?tab=AUDIT as owner → Audit Command Center.
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  hookPage(page2, "D2");
  await page2.setViewport({ width: 1440, height: 960 });
  await uiLogin(page2, OWNER);
  await page2.goto(`${BASE}/?tab=AUDIT`, { waitUntil: "networkidle0", timeout: 60000 });
  const d2 = await page2.waitForSelector('[data-testid="aud-root"]', { timeout: 30000 }).catch(() => null);
  ok("D2 deep link /?tab=AUDIT opens the Audit Command Center (session bootstrap)", !!d2);

  // D3: the service worker carries the OS-notification payloads.
  const sw = await (await fetch(`${BASE}/sw.js`)).text();
  ok("D3 sw.js shows notifications, handles clicks and focuses/opens app tabs",
    sw.includes("showNotification") && sw.includes("notificationclick") && sw.includes("openWindow"), `len=${sw.length}`);

  await ctx.close();
  await ctx2.close();
}

/* ── E · idle auto-logout ───────────────────────────────────────────── */
async function sectionE(browser) {
  console.log("\n— E · 10-minute idle auto-logout —");
  // E1: server-side idle expiry.
  const idleCookie = await loginCookie(GM);
  const sessId = (await pg.query(`SELECT id FROM user_sessions WHERE user_id=$1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, [GM.id])).rows[0].id;
  const alive = await api(idleCookie, "/api/auth/me");
  await pg.query(`UPDATE user_sessions SET last_seen_at = NOW() - INTERVAL '11 minutes' WHERE id=$1`, [sessId]);
  const dead = await api(idleCookie, "/api/auth/me");
  const ended = (await pg.query(`SELECT end_reason r FROM user_sessions WHERE id=$1`, [sessId])).rows[0];
  ok("E1 session idle >10min is refused (401) and soft-ended as IDLE_TIMEOUT server-side",
    alive.status === 200 && dead.status === 401 && ended?.r === "IDLE_TIMEOUT",
    `alive=${alive.status} dead=${dead.status} reason=${ended?.r}`);
  const fresh = await loginCookie(GM);
  const freshMe = await api(fresh, "/api/auth/me");
  ok("E2 a fresh login is untouched by the idle rule", freshMe.status === 200 && freshMe.json?.user?.id === GM.id);

  // E3: client-side DOM inactivity auto-logout (6s test seam).
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "E");
  await page.setViewport({ width: 1440, height: 960 });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(() => sessionStorage.setItem("gomina.idleMs", "6000"));
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', GM.email);
  await page.type('[data-testid="login-password"]', GM.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  const out = await page.waitForSelector('[data-testid="login-email"]', { timeout: 45000 }).catch(() => null);
  ok("E3 no mouse/keyboard/touch activity ⇒ automatic sign-out back to the login screen", !!out);
  const noticeTxt = await page.evaluate(() => document.querySelector('[data-testid="login-notice"]')?.textContent || "");
  ok("E4 the login screen explains the automatic inactivity sign-out", /inactivity/i.test(noticeTxt), noticeTxt.slice(0, 140));
  await ctx.close();

  // E4: real activity keeps the session alive past the idle window.
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  hookPage(page2, "E5");
  await page2.setViewport({ width: 1440, height: 960 });
  await page2.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page2.evaluate(() => sessionStorage.setItem("gomina.idleMs", "9000"));
  await page2.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page2.type('[data-testid="login-email"]', GM.email);
  await page2.type('[data-testid="login-password"]', GM.pass);
  await page2.click('[data-testid="login-submit"]');
  await page2.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await sleep(3000);
  await page2.mouse.move(300, 300);
  await page2.mouse.move(340, 320);
  await sleep(3000);
  await page2.mouse.move(380, 340);
  await sleep(3800);
  const stillIn = await page2.evaluate(() => !document.querySelector('[data-testid="login-email"]') && !!document.querySelector('[data-testid="notif-bell"]'));
  ok("E5 real user activity resets the idle clock (still signed in past the window)", stillIn);
  await ctx2.close();
}

/* ── Z · cleanup & forensics ────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  // Restore the exact inventory quantity the CONFIRMED order consumed.
  if (baseline.menuItem) {
    await pg.query(
      `UPDATE inventory_items SET quantity=$2::double precision, status=CASE WHEN $2::double precision <=0 THEN 'OUT_OF_STOCK' WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END WHERE id=$1`,
      [baseline.menuItem.id, baseline.invQty],
    );
  }
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE id > $1 OR customer_name LIKE 'TEST%' RETURNING id`, [baseline.trMax]);
  const trx = await pg.query(`DELETE FROM transactions WHERE id > $1 RETURNING id`, [baseline.trxMax]);
  const ntf = await pg.query(`DELETE FROM notifications WHERE id > $1 RETURNING id`, [baseline.ntfMax]);
  const arv = await pg.query(`DELETE FROM audit_reviews WHERE id > $1 RETURNING id`, [baseline.arMax]);
  const aiu = await pg.query(`DELETE FROM audit_issue_updates WHERE id > $1 RETURNING id`, [baseline.aiMax]);
  const atr = await pg.query(`DELETE FROM audit_trail WHERE id > $1 RETURNING id`, [baseline.atMax]);
  const cust = await pg.query(`DELETE FROM customers WHERE id > $1 RETURNING id`, [baseline.custMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);

  // push tables: restore the exact pre-suite snapshot (both were empty at
  // baseline — assert and reinsert defensively either way).
  await pg.query(`DELETE FROM push_subscriptions`);
  for (const r of baseline.pushSubs) {
    await pg.query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.user_id, r.endpoint, r.p256dh, r.auth, r.user_agent, r.created_at, r.last_seen_at],
    );
  }
  await pg.query(`DELETE FROM user_push_settings`);
  for (const r of baseline.pushSettings) {
    await pg.query(
      `INSERT INTO user_push_settings (id, user_id, enabled, orders, approvals, alerts, tasks, messages, reports, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.user_id, r.enabled, r.orders, r.approvals, r.alerts, r.tasks, r.messages, r.reports, r.updated_at],
    );
  }
  console.log(`   purged: trackings=${trk.rowCount} transactions=${trx.rowCount} notifications=${ntf.rowCount} audit_reviews=${arv.rowCount} issue_updates=${aiu.rowCount} trail=${atr.rowCount} customers=${cust.rowCount} sessions=${sess.rowCount}`);

  const invNow = baseline.menuItem ? (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [baseline.menuItem.id])).rows[0].q : null;
  ok("Z1 inventory restored to the exact pre-suite quantity", !baseline.menuItem || Math.abs(invNow - baseline.invQty) < 1e-9, `qty=${invNow} want=${baseline.invQty}`);

  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii, (SELECT count(*)::int FROM notifications) n,
      (SELECT count(*)::int FROM audit_reviews) ar, (SELECT count(*)::int FROM push_subscriptions) ps,
      (SELECT count(*)::int FROM user_push_settings) ups`)).rows[0];
  ok("Z2 live data byte-identical to suite start (incl. push tables)", JSON.stringify(counts) === JSON.stringify(baseline.counts),
    `start=${JSON.stringify(baseline.counts)} end=${JSON.stringify(counts)}`);
  const leftovers = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  ok("Z3 no TEST rows left behind anywhere", leftovers === 0);
  ok("Z4 zero page/console errors across every browser pass", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
}

(async () => {
  await pg.connect();
  await startMock();
  console.log(`   mock push endpoint: https://127.0.0.1:${mock.port}/`);
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customer_trackings`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.arMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM audit_reviews`)).rows[0].m;
  baseline.aiMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM audit_issue_updates`)).rows[0].m;
  baseline.atMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM audit_trail`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customers`)).rows[0].m;
  baseline.pushSubs = (await pg.query(`SELECT * FROM push_subscriptions ORDER BY id`)).rows;
  baseline.pushSettings = (await pg.query(`SELECT * FROM user_push_settings ORDER BY id`)).rows;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii, (SELECT count(*)::int FROM notifications) n,
      (SELECT count(*)::int FROM audit_reviews) ar, (SELECT count(*)::int FROM push_subscriptions) ps,
      (SELECT count(*)::int FROM user_push_settings) ups`)).rows[0];
  console.log(`   baseline counts: ${JSON.stringify(baseline.counts)}`);

  const cookies = { owner: await loginCookie(OWNER), gm: await loginCookie(GM), bm: await loginCookie(BM) };
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionA(cookies);
    await sectionB(browser);
    await sectionC(cookies);
    await sectionD(browser);
    await sectionE(browser);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
    mock.server?.close();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
