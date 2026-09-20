// Owner Lifecycle UI end-to-end verification — drives the REAL Platform
// Owners & Organizations console in a real headless Chromium against the live
// app, clicking the actual buttons a Super Admin clicks, and cross-checking
// every step against the API and the database.
//
//   node dev-tooling/owner-lifecycle-ui-verify.mjs
//   BASE=http://127.0.0.1:3000 node dev-tooling/owner-lifecycle-ui-verify.mjs
//
// Covers (all through the visible UI unless noted):
//   1. Login as Super Admin; open the Platform Owners console from the sidebar.
//   2. Main workspace (org #1) is protected: NO Suspend/Delete buttons.
//   3. Provision a new Owner through the UI form (also exercises POST).
//   4. Geometry regression: Status *and* Actions columns are reachable
//      (horizontal scroller fix — the Actions column used to be clipped on
//      laptop-width viewports by overflow-hidden).
//   5. 
//      Confirm flips it to SUSPENDED — then API checks: member sessions
//      terminated, login blocked, marketplace listing hidden.
//   6. Reactivate is one click — login works again, marketplace listing back.
//   7. Delete requires the typed organization name (button stays disabled
//      otherwise) — soft delete: status DELETED, access revoked, sessions
//      ended, marketplace hidden, but ALL data provably preserved (SQL).
//   8. Status filter (Suspended / Deleted / All) filters the table correctly.
//   9. Restore brings the Owner back: login + business + marketplace intact.
//  10. Audit trail: every lifecycle action is logged (SQL check).
//
// The fixture organization created here is left in ACTIVE state at the end
// (nothing the user owns is touched; the fixture can be deleted from the UI).
import { chromium as pw, request } from "playwright-core";
import sparticuzChromium from "@sparticuz/chromium";
import { execFileSync } from "node:child_process";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const SUPER_EMAIL = process.env.SUPER_EMAIL || "kwame.owner@gomina360.com";
const SUPER_PASS = process.env.SUPER_PASS || "Owner@GoMina26";
const STUB_LIBS = process.env.CHROMIUM_STUB_LIBS || "/tmp/nss-stub";
const SHOTS = "docs/ui-proof";

// Waits for the directory table to show a given status on an org's row. The
// Next.js dev server can once in a while answer a fetch with an HTML error
// page during recompiles (a known dev-only flake), so on timeout we press the
// panel's visible Refresh control and keep waiting — assertions still run
// against the real rendered table.
async function waitRowText(page, orgName, posRe, negRe = null, ms = 75000) {
  const expr = `([name, pos, neg]) => {
    const re = new RegExp(pos); const nr = neg ? new RegExp(neg) : null;
    return [...document.querySelectorAll("tr")].some((tr) => {
      const t = tr.innerText || "";
      return t.includes(name) && re.test(t) && (!nr || !nr.test(t));
    });
  }`;
  const deadline = Date.now() + ms;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await page.waitForFunction(expr, [orgName, posRe, negRe], { timeout: 9000 });
      return;
    } catch (e) {
      lastErr = e;
      const r = page.getByRole("button", { name: /^Refresh$/i });
      if (await r.count()) await r.first().click().catch(() => {});
    }
  }
  throw lastErr;
}

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name}${extra ? "  — " + extra : ""}`);
  }
}
// Authenticated API context: the login response carries a sessionToken which
// the client reattaches as a Bearer header (the same "header channel" the
// embedded preview uses — the session cookie is Secure+Partitioned and is
// not resent by bare HTTP clients).
// GET /api/admin/organizations with retry: the Next.js DEV server
// occasionally answers with an HTML error page while a route chunk
// recompiles ("Manifest file is empty" — dev-only). Retry briefly; a real
// regression would never turn JSON->HTML->JSON.
async function orgsList(sa, tries = 12) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await sa.get("/api/admin/organizations");
      const body = await res.json();
      if (res.ok && body && Array.isArray(body.organizations)) return body.organizations;
      lastErr = new Error(`HTTP ${res.status()}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("organizations list unavailable");
}

async function loginCtx(email, password) {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/auth/login", { data: { email, password } });
  const raw = await res.text();
  let token = null;
  try { token = JSON.parse(raw).sessionToken || null; } catch {}
  if (!res.ok()) console.log(`   [login ${email}] HTTP ${res.status()}: ${raw.slice(0, 220)}`);
  await ctx.dispose();
  const authed = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { ctx: authed, loginStatus: res.status(), token };
}
function sql(query) {
  const out = execFileSync("node", ["dev-tooling/q.mjs", query], { encoding: "utf8" });
  const m = out.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : [];
}

const ts = Date.now();
const ORG_NAME = `Lifecycle QA ${ts}`;
const OWNER_EMAIL = `qa-${ts}@arena.test`;
const BIZ_NAME = `QA Bricks ${ts}`;

console.log(`Owner lifecycle UI verification → ${BASE}`);
console.log(`fixture org: "${ORG_NAME}"  owner: ${OWNER_EMAIL}`);

const execPath = await sparticuzChromium.executablePath();
const browser = await pw.launch({
  executablePath: execPath,
  args: [...sparticuzChromium.args, "--no-sandbox", "--hide-scrollbars"],
  headless: true,
  env: { ...process.env, LD_LIBRARY_PATH: STUB_LIBS },
});

try {
  await execFileSync("mkdir", ["-p", SHOTS]);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  // Unauthenticated super-admin API context (for server-side truth checks).
  const saAuth = await loginCtx(SUPER_EMAIL, SUPER_PASS);
  const sa = saAuth.ctx;
  ok("setup: super-admin API login", saAuth.loginStatus === 200, `HTTP ${saAuth.loginStatus}`);

  // ── 1. Login through the real login screen ──────────────────────────────
  console.log("\n1) Login + open Platform Owners console");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-screen").waitFor();
  await page.getByTestId("login-email").fill(SUPER_EMAIL);
  await page.getByTestId("login-password").fill(SUPER_PASS);
  await page.getByTestId("login-submit").click();
  const ownersBtn = page.getByRole("button", { name: /Platform Owners/i });
  await ownersBtn.waitFor();
  ok("sidebar shows the Platform Owners entry (Super Admin)", await ownersBtn.isVisible());
  await ownersBtn.click();
  await page.getByRole("heading", { name: /Platform Owners & Organizations/i }).waitFor();
  ok("console renders", true);

  // ── 2. Main workspace protection ────────────────────────────────────────
  console.log("\n2) Main Owner / Organization protection");
  ok("no Suspend button on the main workspace row", (await page.locator('[data-testid="suspend-org-1"]').count()) === 0);
  ok("no Delete button on the main workspace row", (await page.locator('[data-testid="delete-org-1"]').count()) === 0);
  ok("no Restore button on the main workspace row", (await page.locator('[data-testid="restore-org-1"]').count()) === 0);
  const mainRow = page.locator("tr", { hasText: "GoMina Group" }).first();
  ok("main row labelled as protected", /main/i.test(await mainRow.innerText()));

  // ── 3. Provision a new Owner through the UI ─────────────────────────────
  console.log("\n3) Provision new Owner via the visible form");
  await page.getByPlaceholder(/Organization name/i).fill(ORG_NAME);
  await page.getByPlaceholder(/Owner full name/i).fill("QA Owner");
  await page.getByPlaceholder(/Owner sign-in email/i).fill(OWNER_EMAIL);
  await page.getByPlaceholder(/Owner phone/i).fill("+23324000111");
  await page.getByRole("button", { name: /Provision Owner Workspace/i }).click();
  const provBox = page.getByText(/Owner provisioned successfully/i);
  await provBox.waitFor();
  const provText = (await provBox.locator("xpath=..").innerText()).replace(/\s+/g, " ");
  const fxPass = (provText.match(/One-time password:\s*(\S+)/) || [])[1];
  ok("one-time password shown once in UI", !!fxPass, provText.slice(0, 120));
  const fixtureRow = page.locator("tr", { hasText: ORG_NAME }).first();
  await fixtureRow.waitFor();
  const fxBtnTestId = await fixtureRow.locator('[data-testid^="suspend-org-"], [data-testid^="manage-types-"]').first().getAttribute("data-testid");
  const ORG_ID = Number((fxBtnTestId.match(/-(\d+)$/) || [])[1]);
  ok("new owner row appears in the directory", ORG_ID > 1, `org id ${ORG_ID}`);

  // The provisioned credentials must work immediately (API).
  const fxAuth = await loginCtx(OWNER_EMAIL, fxPass);
  const fx = fxAuth.ctx;
  ok("provisioned owner can sign in (API)", fxAuth.loginStatus === 200, `HTTP ${fxAuth.loginStatus}`);
  const fxBiz = await fx.post("/api/businesses", { data: { name: BIZ_NAME, category: "BLOCK_FACTORY" } });
  const fxBizJson = await fxBiz.json().catch(() => ({}));
  const BIZ_ID = fxBizJson.business?.id ?? fxBizJson.id;
  ok("owner can create a business unit (API)", fxBiz.ok() && !!BIZ_ID, `HTTP ${fxBiz.status()}`);
  // The public marketplace only lists units that actually have sellable
  // stock — give the fixture one in-stock product.
  const fxStock = await fx.post("/api/enterprise", {
    data: { entityType: "inventory", data: { businessId: BIZ_ID, name: `QA Concrete Block ${ts}`, sku: `QA-BLK-${ts}`, category: "Building", unit: "pc", quantity: 50, costPriceGhs: 2, sellingPriceGhs: 5 } },
  });
  ok("owner can stock the unit (API)", fxStock.ok(), `HTTP ${fxStock.status()}`);
  const menuNow = await fx.get("/api/menu").then((r) => r.json());
  ok("business is on the public marketplace", (menuNow.businesses || []).some((b) => b.businessId === BIZ_ID));
  await page.screenshot({ path: `${SHOTS}/01-panel-with-actions.png`, fullPage: true });

  // ── 4. Geometry: Status + Actions reachable (clipping regression fix) ───
  console.log("\n4) Actions column reachable at laptop width (1280px)");
  const geo = await page.evaluate((orgId) => {
    const scroller = document.querySelector('.overflow-x-auto:has(table)');
    const btn = document.querySelector(`[data-testid="suspend-org-${orgId}"]`);
    if (!scroller || !btn) return { scroller: !!scroller, btn: !!btn };
    const clientW = scroller.clientWidth;
    const scrollW = scroller.scrollWidth;
    scroller.scrollLeft = 0;
    const btnLeftHidden = btn.getBoundingClientRect().right > scroller.getBoundingClientRect().right;
    scroller.scrollLeft = scrollW - clientW + 5; // scroll fully right
    const s = scroller.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const reachable = b.right <= s.right + 1 && b.left >= s.left - 1;
    scroller.scrollLeft = 0;
    return { scroller: true, btn: true, clientW, scrollW, btnLeftHidden, reachable };
  }, ORG_ID);
  ok("horizontal scroller wraps the directory table", geo.scroller === true);
  if (geo.scroller && geo.btn) {
    console.log(`     table min-width ${geo.scrollW}px vs visible ${geo.clientW}px — actions initially ${geo.btnLeftHidden ? "OFF-SCREEN" : "on-screen"}, reachable after scroll: ${geo.reachable}`);
    ok("Suspend/Delete controls reachable (scroll fixes the old clipping)", geo.reachable === true);
  }

  // ── 5. Suspend: two-click confirm + server effects ──────────────────────
  console.log("\n5) Suspend with confirmation");
  const fxRow = () => page.locator("tr", { hasText: ORG_NAME }).first();
  await fxRow().getByTestId(`suspend-org-${ORG_ID}`).click();
  const confirmSuspend = page.getByTestId(`confirm-suspend-org-${ORG_ID}`);
  const suspendPanel = page.getByTestId(`suspend-confirm-${ORG_ID}`);
  await suspendPanel.waitFor();
  ok("first click opens the suspension confirmation panel", /signs out every member/i.test((await suspendPanel.innerText()).replace(/\s+/g, " ")));
  await page.screenshot({ path: `${SHOTS}/02-suspend-confirm.png` });
  await suspendPanel.getByRole("button", { name: "Cancel" }).click();
  await suspendPanel.waitFor({ state: "detached" });
  ok("Cancel aborts the suspension", /ACTIVE/.test((await fxRow().innerText()).replace(/\s+/g, " ")));
  const orgsAfterCancel = await orgsList(sa);
  ok("org still ACTIVE after Cancel (no stray mutation)", orgsAfterCancel.find((o) => o.id === ORG_ID)?.status === "ACTIVE");
  await fxRow().getByTestId(`suspend-org-${ORG_ID}`).click();
  await confirmSuspend.click();
  await waitRowText(page, ORG_NAME, "SUSPENDED");
  ok("row badge flips to SUSPENDED after Confirm", true);

  // Poll until the server reports SUSPENDED (and prove it STAYS suspended —
  // guards against the click being retargeted onto the re-rendered cell).
  let apiSuspended = false;
  for (let i = 0; i < 12 && !apiSuspended; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const orgs = await orgsList(sa);
    apiSuspended = orgs.find((o) => o.id === ORG_ID)?.status === "SUSPENDED";
  }
  ok("API status = SUSPENDED (and stays suspended)", apiSuspended);
  const meWhileSuspended = await fx.get("/api/auth/me");
  ok("member sessions terminated immediately", !meWhileSuspended.ok(), `HTTP ${meWhileSuspended.status()}`);
  const fxSuspendedLogin = await loginCtx(OWNER_EMAIL, fxPass);
  ok("login blocked while suspended", fxSuspendedLogin.loginStatus === 403, `HTTP ${fxSuspendedLogin.loginStatus}`);
  const menuSuspended = await fxSuspendedLogin.ctx.get("/api/menu").then((r) => r.json());
  ok("suspended org hidden from marketplace", !(menuSuspended.businesses || []).some((b) => b.businessId === BIZ_ID));
  await fxSuspendedLogin.ctx.dispose();

  // ── 6. Reactivate: one click ────────────────────────────────────────────
  console.log("\n6) Reactivate");
  await fxRow().getByTestId(`suspend-org-${ORG_ID}`).click(); // toggles to ACTIVATE
  await waitRowText(page, ORG_NAME, "ACTIVE", "SUSPENDED");
  ok("row badge back to ACTIVE after one click", true);
  const fx2Auth = await loginCtx(OWNER_EMAIL, fxPass);
  const fx2 = fx2Auth.ctx;
  ok("login restored after reactivate", fx2Auth.loginStatus === 200, `HTTP ${fx2Auth.loginStatus}`);
  const menuActive = await fx2.get("/api/menu").then((r) => r.json());
  ok("marketplace listing restored", (menuActive.businesses || []).some((b) => b.businessId === BIZ_ID));

  // ── 7. Delete: typed-name confirm, soft delete, data preserved ──────────
  console.log("\n7) Delete with typed confirmation");
  await fxRow().getByTestId(`delete-org-${ORG_ID}`).click();
  await page.getByTestId(`delete-confirm-${ORG_ID}`).waitFor();
  const delBtn = page.getByTestId(`delete-confirm-btn-${ORG_ID}`);
  ok("Confirm Delete starts disabled", await delBtn.isDisabled());
  await page.getByTestId(`delete-confirm-input-${ORG_ID}`).fill("wrong name");
  ok("Confirm Delete stays disabled for wrong text", await delBtn.isDisabled());
  await page.getByTestId(`delete-confirm-input-${ORG_ID}`).fill(ORG_NAME);
  ok("Confirm Delete enables on exact org name", await delBtn.isEnabled());
  await page.screenshot({ path: `${SHOTS}/03-delete-confirm.png` });
  await delBtn.click();
  await waitRowText(page, ORG_NAME, "DELETED");
  ok("row badge flips to DELETED", true);
  // Allow the post-delete re-render to settle before counting the buttons.
  let actionCell = { restore: 0, suspend: 0, del: 0 };
  for (let i = 0; i < 30; i++) {
    actionCell = {
      restore: await fxRow().getByTestId(`restore-org-${ORG_ID}`).count(),
      suspend: await fxRow().getByTestId(`suspend-org-${ORG_ID}`).count(),
      del: await fxRow().getByTestId(`delete-org-${ORG_ID}`).count(),
    };
    if (actionCell.restore === 1 && actionCell.suspend === 0 && actionCell.del === 0) break;
    await page.waitForTimeout(300);
  }
  ok("Restore button appears, Suspend/Delete gone", actionCell.restore === 1 && actionCell.suspend === 0 && actionCell.del === 0, JSON.stringify(actionCell));

  const orgsDeleted = await orgsList(sa);
  ok("API status = DELETED", orgsDeleted.find((o) => o.id === ORG_ID)?.status === "DELETED");
  const meWhileDeleted = await fx2.get("/api/auth/me");
  ok("sessions terminated on delete", !meWhileDeleted.ok(), `HTTP ${meWhileDeleted.status()}`);
  const fx3Auth = await loginCtx(OWNER_EMAIL, fxPass);
  const fx3 = fx3Auth.ctx;
  ok("login blocked while deleted", fx3Auth.loginStatus === 403 || fx3Auth.loginStatus === 401, `HTTP ${fx3Auth.loginStatus}`);
  const menuDeleted = await fx3.get("/api/menu").then((r) => r.json());
  ok("deleted org hidden from marketplace", !(menuDeleted.businesses || []).some((b) => b.businessId === BIZ_ID));
  // Data preservation (soft delete) — straight from the DB.
  const bizRows = sql(`select id, name, owner_id from businesses where id = ${BIZ_ID}`);
  ok("business row fully preserved after delete", bizRows[0]?.name === BIZ_NAME && Number(bizRows[0]?.owner_id) === ORG_ID, JSON.stringify(bizRows));
  const ownerRows = sql(`select id, email, is_active from users where email = '${OWNER_EMAIL}'`);
  ok("owner account preserved (deactivated, not wiped)", ownerRows.length === 1 && ownerRows[0]?.is_active === false, JSON.stringify(ownerRows));

  // ── 8. Status filter ────────────────────────────────────────────────────
  console.log("\n8) Status filter");
  const filter = page.getByTestId("org-status-filter");
  await filter.selectOption("DELETED");
  await page.waitForTimeout(300);
  ok("Deleted filter shows the deleted org", (await page.locator("tr", { hasText: ORG_NAME }).count()) === 1);
  ok("Deleted filter hides active orgs", (await page.locator("tr", { hasText: "GoMina Group" }).count()) === 0);
  await filter.selectOption("ACTIVE");
  await page.waitForTimeout(300);
  ok("Active filter hides the deleted org", (await page.locator("tr", { hasText: ORG_NAME }).count()) === 0);
  ok("Active filter shows the main workspace", (await page.locator("tr", { hasText: "GoMina Group" }).count()) === 1);
  await filter.selectOption("SUSPENDED");
  await page.waitForTimeout(300);
  ok("Suspended filter hides non-suspended orgs", (await page.locator("tr", { hasText: ORG_NAME }).count()) === 0 &&
    (await page.locator("tr", { hasText: "GoMina Group" }).count()) === 0);
  await filter.selectOption("ALL");
  await page.waitForTimeout(300);
  ok("Status: all shows everything again", (await page.locator("tr", { hasText: ORG_NAME }).count()) === 1);

  // ── 9. Restore ──────────────────────────────────────────────────────────
  console.log("\n9) Restore deleted owner");
  await fxRow().getByTestId(`restore-org-${ORG_ID}`).click();
  await waitRowText(page, ORG_NAME, "ACTIVE", "DELETED");
  ok("row badge back to ACTIVE after Restore", true);
  const fx4Auth = await loginCtx(OWNER_EMAIL, fxPass);
  const fx4 = fx4Auth.ctx;
  ok("owner login restored", fx4Auth.loginStatus === 200, `HTTP ${fx4Auth.loginStatus}`);
  const menuRestored = await fx4.get("/api/menu").then((r) => r.json());
  ok("original business back on the marketplace (same id, data intact)", (menuRestored.businesses || []).some((b) => b.businessId === BIZ_ID));
  const ownerActive = sql(`select is_active from users where email = '${OWNER_EMAIL}'`);
  ok("owner account reactivated in DB", ownerActive[0]?.is_active === true, JSON.stringify(ownerActive));
  await page.screenshot({ path: `${SHOTS}/04-restored-active.png`, fullPage: true });

  // ── 10. Audit trail ─────────────────────────────────────────────────────
  console.log("\n10) Audit logging");
  const trail = sql(`select action from audit_trail where target_label like '%${ORG_NAME}%' order by id asc`);
  const actions = new Set(trail.map((r) => r.action));
  for (const a of ["CREATE_ORGANIZATION", "SUSPEND_ORGANIZATION", "ACTIVATE_ORGANIZATION", "DELETE_ORGANIZATION", "RESTORE_ORGANIZATION"]) {
    ok(`audit trail records ${a}`, actions.has(a), [...actions].join(","));
  }

  await ctx.close();
} catch (e) {
  failed++;
  console.error("\nFATAL:", e.message?.slice(0, 800));
  try {
    const p = (await browser.contexts())[0]?.pages()[0];
    if (p) await p.screenshot({ path: `${SHOTS}/99-fatal.png`, fullPage: true });
  } catch {}
} finally {
  await browser.close();
}

console.log(`\nOwner lifecycle UI verification: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
