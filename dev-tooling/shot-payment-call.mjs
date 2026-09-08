// Presentation artifact: scrolls the public tracking page to the Payment card
// so the tap-to-call "payment assistance / delivery support" line is visible.
// Uses a temporary TEST order + temporary help number on biz 1, then purges
// the TEST rows and restores the business fields exactly. No user data touched.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/shot-payment-call.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const { Client } = req("pg");

const BASE = "http://127.0.0.1:3000";
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await pg.connect();

const ownerLogin = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" }),
}).then((r) => r.json());
const cookie = ownerLogin.sessionToken;
const api = (path, method = "GET", body = null) =>
  fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", "x-gomina-session": cookie }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const baseline = (await pg.query(`SELECT customer_help_phone h, momo_number m, momo_name n FROM businesses WHERE id=1`)).rows[0];
const trMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customer_trackings`)).rows[0].m;
const custMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customers`)).rows[0].m;
const ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m;

const menu = (await api("/api/menu")).json;
const prod = (menu.businesses || []).find((b) => b.businessId === 1)?.products?.find((p) => p.available >= 2);
if (!prod || !Number.isFinite(prod.id)) throw new Error("no sellable product on biz 1");
const qty = Number((await pg.query(`SELECT quantity FROM inventory_items WHERE id=${Number(prod.id)}`)).rows[0].quantity);

await api("/api/businesses/1", "PATCH", { customerHelpPhone: "+233 24 100 2000", momoNumber: "059 411 2233", momoName: "Mina Akuafo Poultry" });
const order = await api("/api/order", "POST", {
  businessId: 1, customerName: "TEST Payment Call Shot", customerPhone: "+233555909090",
  fulfillmentType: "PICKUP", items: [{ inventoryId: prod.id, quantity: 1 }],
});
const code = order.json?.trackingCode;
console.log("TEST order:", code, order.status);
if (!/^GM-[A-Z0-9-]+$/.test(code || "")) throw new Error("unexpected tracking code");
// mark the payment as awaiting confirmation (customer chose MoMo) so the exact requested state renders
await pg.query(`UPDATE customer_trackings SET payment_choice='MOMO_NOW', payment_status='PENDING_CONFIRMATION', payment_ref='TEST-REF-9090' WHERE tracking_code='${code}'`);

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 780, height: 900 } });
const page = await browser.newPage();
await page.goto(`${BASE}/track?code=${encodeURIComponent(code)}`, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForSelector('[data-testid="track-payment-call"]', { timeout: 20000 });
await page.evaluate(() => document.querySelector('[data-testid="track-payment"]')?.scrollIntoView({ block: "center" }));
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "/home/user/payment-call-shot.png" });
await browser.close();

// purge + restore (all literals — the embedded pg engine rejects some
// parameterized statement forms; ids are numeric, code/values regex-safe)
const sqlLit = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
await pg.query(`DELETE FROM customer_trackings WHERE id > ${trMax}`);
await pg.query(`DELETE FROM customers WHERE id > ${custMax} AND name LIKE 'TEST%'`);
await pg.query(`DELETE FROM notifications WHERE id > ${ntfMax} AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS')`);
await pg.query(`UPDATE inventory_items SET quantity=${Number(qty)}::double precision WHERE id=${Number(prod.id)}`);
await pg.query(`UPDATE businesses SET customer_help_phone=${sqlLit(baseline.h)}, momo_number=${sqlLit(baseline.m)}, momo_name=${sqlLit(baseline.n)} WHERE id=1`);
await pg.query(`DELETE FROM user_sessions WHERE token=${sqlLit(cookie)}`).catch(() => {});
await pg.end();
console.log("shot saved → /home/user/payment-call-shot.png · TEST rows purged · biz 1 restored");
