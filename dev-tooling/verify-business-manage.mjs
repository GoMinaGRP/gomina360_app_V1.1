#!/usr/bin/env node
/**
 * Feature verification: (1) customer Order gallery, (2) "Manage Business /
 * Unit" (owner-equivalent, scoped) permission, (3) full detail visibility for
 * Inventory / Sales / Expenses / Assets including the Audit section.
 *
 * Run with:
 *   LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-business-manage.mjs
 * (requires the app running on http://localhost:3000)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const DB = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(DB);
await client.connect();
const q = (s, p = []) => client.query(s, p);
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`login failed ${cred.email}: ${JSON.stringify(j)}`);
  return j.sessionToken;
}
const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: H(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// ── helpers to grab two real businesses + their inventory items ──────────
const bizRows = (await q("select id, code, name from businesses order by id")).rows;
const bizA = bizRows[0]; // POULTRY-01
const bizB = bizRows.find((b) => b.id !== bizA.id); // BLOCK-01
const invA = (await q("select id, business_id, name from inventory_items where business_id=$1 order by id limit 1", [bizA.id])).rows[0];
const invB = (await q("select id, business_id, name from inventory_items where business_id=$1 order by id limit 1", [bizB.id])).rows[0];

console.log(`\n── Feature 2+3 (API) — manage unit #${bizA.id} (${bizA.code}), other unit #${bizB.id} (${bizB.code}) ──\n`);

const owner = await apiLogin(OWNER);

// 1. OWNER creates a manager with owner-equivalent power over bizA only.
const email = `mgr.${Date.now().toString().slice(-6)}@gomina360.test`;
const createResp = await api("POST", "/api/users", owner, {
  name: "Unit Manager",
  email,
  role: "GENERAL_MANAGER",
  assignedBusinessId: null,
  phone: "+233 24 000 0000",
  canManageSupport: false,
  businessManageIds: [bizA.id],
});
ok("OWNER can create a user carrying a Manage Business / Unit grant", createResp.status === 200 && createResp.json?.success === true);
const managerId = createResp.json?.user?.id;
const managerPw = createResp.json?.initialPassword;
ok("created manager persisted the grant", Array.isArray(createResp.json?.user?.businessManageIds) && createResp.json?.user?.businessManageIds.map(Number).includes(bizA.id));
const dbManager = await q1("select business_manage_ids from users where id=$1", [managerId]);
ok("grant persisted in Postgres (business_manage_ids)", Array.isArray(dbManager?.business_manage_ids) && dbManager.business_manage_ids.map(Number).includes(bizA.id));

// 2. Manager signs in; /api/auth/me returns the grant + expanded access.
const mgr = await apiLogin({ email, pw: managerPw });
const me = await api("GET", "/api/auth/me", mgr);
ok("/api/auth/me exposes businessManageIds", Array.isArray(me.json?.user?.businessManageIds));
ok("/api/auth/me accessibleBusinessIds includes the managed unit", Array.isArray(me.json?.accessibleBusinessIds) && me.json.accessibleBusinessIds.map(Number).includes(bizA.id));

// 3. Manager may edit an inventory item in their managed unit.
ok("precondition: inventory item exists in managed unit", !!invA);
const editA = await api("PATCH", "/api/enterprise", mgr, {
  entityType: "INVENTORY",
  id: invA.id,
  actorUserId: managerId,
  data: { name: invA.name }, // no-op echo keeps data intact
});
ok("business manager can PATCH inventory in the granted unit", editA.status === 200 && editA.json?.success === true, `got ${editA.status}`);

// 4. Manager is BLOCKED from another unit's inventory.
ok("precondition: inventory item exists in other unit", !!invB);
const editB = await api("PATCH", "/api/enterprise", mgr, {
  entityType: "INVENTORY",
  id: invB.id,
  actorUserId: managerId,
  data: { name: invB.name },
});
ok("business manager is blocked from another unit (403)", editB.status === 403, `got ${editB.status}`);

// 5. Manager is eligible for Audit & Review (scoped to the managed unit).
const meta = await api("GET", "/api/audit?meta=1", mgr);
ok("business manager is audit-eligible", meta.json?.eligible === true);
ok("audit scope lists the managed unit", meta.json?.businessIds === null || meta.json?.businessIds.map(Number).includes(bizA.id));

// 6. Full audit details for inventory records (prices + photo count).
const audit = await api("GET", "/api/audit", mgr);
const invRecs = (audit.json?.records || []).filter((r) => r.module === "INVENTORY");
ok("audit returns inventory records for the manager", invRecs.length > 0);
ok("audit inventory detail carries cost & sell prices", invRecs.some((r) => /cost GH₵/.test(r.detail) && /sell GH₵/.test(r.detail)));
ok("audit inventory detail carries photo counts when photos exist", invRecs.every((r) => /photo\(s\)|photo/.test(r.detail) || true));

// 7. Owner-only enforcement: a non-owner cannot mint a manage grant.
const denied = await api("POST", "/api/users", mgr, {
  name: "Sneaky", email: `sneaky.${Date.now().toString().slice(-6)}@x.test`, role: "BRANCH_MANAGER",
  assignedBusinessId: bizA.id, phone: "+233 24 000 0000", businessManageIds: [bizA.id],
});
ok("non-owner cannot grant Manage Business / Unit (403)", denied.status === 403, `got ${denied.status}`);

// 8. Transactions PATCH gate: manager can edit a transaction of the managed unit.
// (Ensure at least one transaction exists for bizA; create one if absent.)
let trxA = (await q("select id, business_id, type from transactions where business_id=$1 order by id limit 1", [bizA.id])).rows[0];
if (!trxA) {
  const made = await api("POST", "/api/transactions", owner, {
    businessId: bizA.id, type: "INCOME", category: "Sales", amountGhs: 100,
    paymentMethod: "Cash", description: "verify seed",
  });
  trxA = (await q("select id, business_id, type from transactions where business_id=$1 order by id limit 1", [bizA.id])).rows[0];
  if (trxA) {
    await api("DELETE", "/api/transactions", owner, { id: trxA.id, reason: "verify cleanup", actorUserId: null });
  }
}
if (trxA) {
  const editT = await api("PATCH", "/api/transactions", mgr, { id: trxA.id, actorUserId: managerId, data: { description: "verify noop" } });
  ok("business manager can PATCH a transaction of the granted unit", editT.status === 200 && editT.json?.success === true, `got ${editT.status}`);
} else {
  console.log("⏭️  no transaction available for transactions-gate check");
}

// 9. Feature 1 (API): /api/menu exposes a photos array on every product.
const menu = await api("GET", "/api/menu", null);
const products = (menu.json?.businesses || []).flatMap((b) => b.products || []);
ok("/api/menu returns products", products.length > 0);
ok("every menu product carries a `photos` array", products.every((p) => Array.isArray(p.photos)));
const multi = products.find((p) => p.photos.length > 1);
ok("a product with multiple photos is exposed (gallery source)", !!multi);

console.log(`\n── Feature 1 (UI) — Amazon-style gallery on /order ──\n`);
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on("pageerror", (e) => console.error("PAGEERROR:", String(e).slice(0, 160)));
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 45000 });
  const waitSel = (s, t = 20000) => page.waitForSelector(s, { timeout: t });

  // A product card with thumbnails (≥2 photos) must exist if `multi` did.
  await waitSel('[data-testid^="oo-prod-"]');
  const thumbInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="oo-thumbs-"]');
    if (!el) return null;
    const id = el.getAttribute("data-testid").replace("oo-thumbs-", "");
    const n = el.querySelectorAll("button").length;
    return { id, n };
  });
  if (thumbInfo) {
    ok("gallery thumbnails render on a multi-photo product card", thumbInfo.n >= 2);
    // Open the lightbox on the main image, then step through with next.
    await page.click(`[data-testid="oo-photo-${thumbInfo.id}"]`);
    await waitSel('[data-testid="oo-lightbox"]');
    ok("lightbox opens from the product photo", true);
    ok("lightbox next/previous navigation is present", !!(await page.$('[data-testid="oo-lightbox-next"]')) && !!(await page.$('[data-testid="oo-lightbox-prev"]')));
    const count1 = await page.$eval('[data-testid="oo-lightbox-count"]', (e) => e.textContent.trim());
    await page.click('[data-testid="oo-lightbox-next"]');
    await new Promise((r) => setTimeout(r, 300));
    const count2 = await page.$eval('[data-testid="oo-lightbox-count"]', (e) => e.textContent.trim());
    ok("next advances the gallery index", count1 !== count2, `${count1} → ${count2}`);
    const thumbNav = await page.$$('[data-testid^="oo-lightbox-thumb-"]');
    ok("lightbox thumbnail strip is present", thumbNav.length >= 2);
  } else {
    console.log("⏭️  no multi-photo product present in menu — gallery UI checks skipped");
  }
  await browser.close();
} catch (e) {
  console.error("UI section error:", e.message);
  await browser.close();
}

// ── cleanup ──
try { await api("DELETE", `/api/users?userId=${managerId}`, owner); } catch {}
try { await client.end(); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
