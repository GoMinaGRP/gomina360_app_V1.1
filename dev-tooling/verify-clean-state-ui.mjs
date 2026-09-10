#!/usr/bin/env node
/**
 * Clean-state UI smoke test (headless Chromium).
 *
 * Verifies that freshly-created (clean) businesses render correct EMPTY
 * states in their real dashboards/sections — no sample data, no misleading
 * "auto-provisioned" copy — across the flagship module types.
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-clean-state-ui.mjs
 * (requires the app running on http://localhost:3000)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`login failed: ${JSON.stringify(j)}`);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => console.error("PAGEERROR:", String(e).slice(0, 200)));

const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const bodyHas = (text) => page.evaluate((t) => document.body.innerText.includes(t), text);

async function uiLogin() {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await page.$eval('[data-testid="login-email"]', (e) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, "kwame.owner@gomina360.com");
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval('[data-testid="login-password"]', (e) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, "Owner@GoMina26");
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** Click a business in the sidebar by its display name, wait for its module. */
async function openBusiness(name) {
  const clicked = await page.evaluate((n) => {
    const btns = [...document.querySelectorAll("aside button")];
    const b = btns.find((x) => (x.textContent || "").trim().includes(n));
    if (b) { b.click(); return true; }
    return false;
  }, name);
  if (!clicked) return false;
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("h2, h3")].some((h) => (h.textContent || "").includes(n)),
    { timeout: 25000 }, name,
  );
  await sleep(800);
  return true;
}

async function clickTabByText(label) {
  const clicked = await page.evaluate((l) => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => (x.textContent || "").trim() === l || (x.textContent || "").trim().startsWith(l));
    if (b) { b.click(); return true; }
    return false;
  }, label);
  if (!clicked) return false;
  await sleep(900);
  return true;
}

async function main() {
  const token = await apiLogin(OWNER);
  const tag = Date.now().toString().slice(-6);
  const created = [];

  const cleanup = async () => {
    for (const b of created) {
      try {
        await api("DELETE", `/api/businesses/${b.id}`, token, { confirmCode: b.code });
      } catch {}
    }
    const leftovers = [];
    for (const b of created) {
      if (await q1(`SELECT id FROM businesses WHERE id = $1`, [b.id])) leftovers.push(b.code);
    }
    ok("cleanup: all UI-test businesses deleted", leftovers.length === 0, leftovers.join(","));
  };

  try {

  const makeBiz = async (type) => {
    // Let the app auto-generate the branch code (e.g. LIVESTOCK-02) so each
    // module is exercised exactly as a real unit would be.
    const res = await api("POST", "/api/businesses", token, {
      name: `Clean UI ${type} ${tag}`,
      category: type,
      region: "Greater Accra",
      district: "Accra Metropolitan",
      town: "Accra",
      managerName: "Audit Manager",
      contactPhone: "+233 24 000 0000",
      initialCapitalGhs: 50000,
      monthlyTargetRevenueGhs: 20000,
    });
    const biz = res.json?.business;
    if (biz) created.push({ id: biz.id, code: biz.code });
    return biz;
  };

  const poultry = await makeBiz("Poultry Farm");
  const block = await makeBiz("Block Factory");
  const restaurant = await makeBiz("Restaurant & Food");
  const wash = await makeBiz("Car Wash");
  const telecom = await makeBiz("Telecom & Digital Services");
  const livestock = await makeBiz("Livestock");
  ok("S0: all 6 clean businesses created", [poultry, block, restaurant, wash, telecom, livestock].every(Boolean));

  await uiLogin();

  // ── Poultry ───────────────────────────────────────────────────────────
  console.log("\n── Poultry Farm (clean) ──");
  ok("P1: opens Poultry module", await openBusiness(poultry.name), poultry.name);
  ok("P2: Production tab opens", await clickTabByText("Production"));
  await waitSel('[data-testid="poultry-master-products"]');
  ok("P3: Master Product List empty state", await page.evaluate(() => {
    const el = document.querySelector('[data-testid="poultry-master-products"]');
    return el && /No products yet/.test(el.textContent || "");
  }));
  ok("P4: production records empty state", await bodyHas("No production records."));

  // ── Block Factory ─────────────────────────────────────────────────────
  console.log("\n── Block Factory (clean) ──");
  ok("B1: opens Block Factory module", await openBusiness(block.name), block.name);
  await sleep(500);
  const blockFilterOpts = await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.textContent.trim() === "All Block Types"));
    return sel ? [...sel.options].map((o) => o.textContent.trim()) : null;
  });
  ok("B2: no sample block types pre-loaded in filter", Array.isArray(blockFilterOpts) && blockFilterOpts.length === 1 && blockFilterOpts[0] === "All Block Types",
    JSON.stringify(blockFilterOpts));
  ok("B3: no production records (empty table)", await bodyHas("No records"), "expected a 'No records' empty table");

  // ── Restaurant ────────────────────────────────────────────────────────
  console.log("\n── Restaurant & Kitchen (clean) ──");
  ok("R1: opens Restaurant module", await openBusiness(restaurant.name), restaurant.name);
  ok("R2: Menu Performance tab opens", await clickTabByText("Menu Performance"));
  ok("R3: menu table empty state", await bodyHas("No records"));

  // ── Car Wash ──────────────────────────────────────────────────────────
  console.log("\n── Car Wash (clean) ──");
  ok("C1: opens Car Wash module", await openBusiness(wash.name), wash.name);
  await clickTid("cw-tab-SERVICES");
  await waitSel('[data-testid="cw-services-card"]');
  ok("C2: service menu empty state", await bodyHas("No records"));

  // ── Telecom ───────────────────────────────────────────────────────────
  console.log("\n── Telecom & Digital Services (clean) ──");
  ok("T1: opens Telecom module", await openBusiness(telecom.name), telecom.name);
  await waitSel('[data-testid="tel-dash-lines-list"]');
  ok("T2: agent-lines empty state", await bodyHas("No agent lines yet"));
  ok("T3: Wi-Fi & Vouchers tab opens", await clickTabByText("Wi-Fi & Vouchers"));
  await waitSel('[data-testid="tel-card-packages"]');
  ok("T4: packages empty state", await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tel-pkg-list"]');
    return el && /No Wi-Fi packages yet/.test(el.textContent || "");
  }));

  // ── Livestock (HERD tab uses SpecializedBusinessView) ─────────────────
  console.log("\n── Livestock (clean) ──");
  ok("L1: opens Livestock module", await openBusiness(livestock.name), livestock.name);
  await waitSel('[data-testid="lk-tab-HERD"]');
  ok("L2: Herd & Grazing tab opens", await clickTabByText("Herd & Grazing"));
  ok("L3: zero-animal herd (no fake '2 Animals')", await bodyHas("Total Tagged Herd") && await bodyHas("0 Animals"));
  ok("L4: vaccination compliance shows empty ('—')", await bodyHas("Vaccination Compliance") && await bodyHas("—"));
  ok("L5: logbook empty state", await bodyHas("No records yet — log the first daily operations entry"));

  // ── Cleanup ───────────────────────────────────────────────────────────
  console.log("\n── Cleanup ──");
  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  await client.end();
  process.exit(failed === 0 ? 0 : 1);
  } finally {
    // Best-effort cleanup on any failure so no test business leaks.
    try { await cleanup(); } catch {}
    try { await browser.close(); } catch {}
    try { await client.end(); } catch {}
  }
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await browser.close(); } catch {}
  try { await client.end(); } catch {}
  process.exit(1);
});
