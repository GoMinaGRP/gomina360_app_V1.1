/**
 * verify-farm-advisor-ui.mjs — browser verification of the Farm Advisor UI.
 *
 *   A · OWNER: the "Farm Advisory" sidebar entry opens the Advisory console;
 *       an advisor can be invited and granted scoped access from the UI.
 *   B · ADVISOR (desktop 1366×900): a dedicated read-only workspace renders —
 *       farm picker, read-only chip, KPI strip, every tab, the AI digest,
 *       the note composer; NO sidebar, NO enterprise modules.
 *   C · ADVISOR files a note from the UI and it appears in the thread.
 *   D · ADVISOR (mobile 390×844): the same workspace is usable — picker,
 *       tabs and composer visible and tappable, no horizontal overflow.
 *   E · OWNER sees the advisor's note in their Advisory console and can
 *       acknowledge it, and revoking access from the UI works.
 *   F · Zero page errors anywhere.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-farm-advisor-ui.mjs
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const STAMP = Date.now();
const ADVISOR_NAME = `Dr. UI Advisor ${STAMP}`;
const ADVISOR_EMAIL = `ui.advisor.${STAMP}@example.com`;
const OWNER = { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" };

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name} — ${extra}`); }
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageErrors = [];
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
// Each actor gets an isolated browser context: the session token lives in
// localStorage, so sharing a context would carry the owner's session over.
const newPage = async (viewport, touch = false) => {
  const ctx = await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
  const p = await ctx.newPage();
  await p.setViewport({ ...viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const signIn = async (p, creds) => {
  await p.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await p.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await p.type('[data-testid="login-email"]', creds.email);
  await p.type('[data-testid="login-password"]', creds.password);
  await Promise.all([p.click('[data-testid="login-submit"]'), sleep(3500)]);
};
const has = (p, sel) => p.evaluate((s) => !!document.querySelector(s), sel);

const db = new Client({ connectionString: DB });
await db.connect();
let advisorId = null, advisorPassword = null;

try {
  /* ── A · Owner console ───────────────────────────────────────────────── */
  const owner = await newPage({ width: 1366, height: 900 });
  await signIn(owner, OWNER);
  ok("A1 owner signed in", await has(owner, '[data-testid="nav-sidebar"]'));
  ok("A2 Farm Advisory sidebar entry exists", await has(owner, '[data-testid="advisory-tab"]'));
  await owner.click('[data-testid="advisory-tab"]');
  await owner.waitForSelector('[data-testid="advisory-console"]', { timeout: 20000 });
  ok("A3 Advisory console opens", await has(owner, '[data-testid="advisory-console"]'));
  ok("A4 farm picker rendered", await has(owner, '[data-testid="advisory-farm-picker"]'));

  // Pick the poultry farm explicitly.
  const poultry = await owner.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid^="advisory-farm-"]')];
    const b = btns.find((x) => /poultry|farm/i.test(x.textContent || "")) || btns[0];
    b?.click();
    return b?.getAttribute("data-testid") || null;
  });
  ok("A5 a farm can be selected", !!poultry, String(poultry));
  await sleep(2500);

  await owner.click('[data-testid="advisory-open-grant"]');
  await owner.waitForSelector('[data-testid="advisory-grant-panel"]', { timeout: 10000 });
  await owner.type('[data-testid="advisory-new-name"]', ADVISOR_NAME);
  await owner.type('[data-testid="advisory-new-email"]', ADVISOR_EMAIL);
  await owner.click('[data-testid="advisory-create-advisor"]');
  await owner.waitForSelector('[data-testid="advisory-created-password"]', { timeout: 20000 });
  const pwText = await owner.$eval('[data-testid="advisory-created-password"]', (e) => e.textContent || "");
  advisorPassword = (pwText.match(/password:\s*([^\s]+)/i) || [])[1] || null;
  ok("A6 owner can invite an advisor from the UI", !!advisorPassword, pwText.slice(0, 120));

  const row = await db.query("select id from users where email = $1", [ADVISOR_EMAIL]);
  advisorId = row.rows[0]?.id || null;
  ok("A7 advisor account persisted with ADVISOR role",
    !!advisorId && (await db.query("select role from users where id=$1", [advisorId])).rows[0].role === "ADVISOR");

  await sleep(1200);
  await owner.select('[data-testid="advisory-pick-advisor"]', String(advisorId));
  await owner.click('[data-testid="advisory-grant-submit"]');
  await owner.waitForSelector('[data-testid="advisory-grants"] [data-testid^="advisory-grant-"]', { timeout: 20000 });
  const grantLive = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="advisory-grant-state-"]')].some((e) => /LIVE/.test(e.textContent || "")));
  ok("A8 grant created and shown LIVE", grantLive);
  const defaults = await db.query("select show_costs, can_export, scopes from advisor_assignments where user_id = $1", [advisorId]);
  ok("A9 secure defaults persisted (costs hidden, export off, no CCTV)",
    defaults.rows[0]?.show_costs === false && defaults.rows[0]?.can_export === false &&
    !(defaults.rows[0]?.scopes || []).includes("PHOTOS_CCTV"), JSON.stringify(defaults.rows[0]));

  /* ── B · Advisor workspace (desktop) ─────────────────────────────────── */
  const adv = await newPage({ width: 1366, height: 900 });
  await signIn(adv, { email: ADVISOR_EMAIL, password: advisorPassword });
  await adv.waitForSelector('[data-testid="advisor-workspace"]', { timeout: 30000 });
  ok("B1 advisor lands in the advisory workspace", await has(adv, '[data-testid="advisor-workspace"]'));
  ok("B2 no staff sidebar for the advisor", !(await has(adv, '[data-testid="nav-sidebar"]')));
  ok("B3 read-only status is stated in the UI", await has(adv, '[data-testid="advisor-readonly-chip"]'));
  ok("B4 granted farm listed", await has(adv, '[data-testid^="advisor-farm-"]'));
  await sleep(2500);
  ok("B5 AI advisory digest rendered", await has(adv, '[data-testid="adv-digest"]'));
  ok("B6 benchmark metrics rendered", await adv.evaluate(() => document.querySelectorAll('[data-testid^="adv-metric-"]').length >= 4));

  const tabs = await adv.evaluate(() => [...document.querySelectorAll('[data-testid^="advisor-tab-"]')].map((b) => b.getAttribute("data-testid")));
  ok("B7 every advisory tab is present", tabs.length >= 6, JSON.stringify(tabs));
  for (const t of tabs) {
    await adv.click(`[data-testid="${t}"]`);
    await sleep(500);
    const errored = await adv.evaluate(() => document.body.innerText.includes("Application error"));
    ok(`B8 tab ${t.replace("advisor-tab-", "")} renders`, !errored);
  }

  /* ── C · Advisor files a note ────────────────────────────────────────── */
  await adv.click('[data-testid="advisor-tab-NOTES"]');
  await adv.waitForSelector('[data-testid="adv-notes-panel"]', { timeout: 15000 });
  ok("C1 notes panel available to the advisor", await has(adv, '[data-testid="adv-notes-panel"]'));
  ok("C2 composer available to the advisor", await has(adv, '[data-testid="adv-note-composer"]'));
  await adv.evaluate((title) => {
    const t = document.querySelector('[data-testid="adv-note-title"]');
    const b = document.querySelector('[data-testid="adv-note-body"]');
    const set = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    if (t) set(t, title);
    if (b) set(b, "Litter in house two is damp and the birds were panting during the midday walk-through. Improve ventilation and flush the drinker lines within forty-eight hours, then re-weigh a sample.");
  }, `UI advisory note ${STAMP}`);
  await adv.click('[data-testid="adv-note-submit"]');
  await sleep(3000);
  const noteRow = await db.query("select id, status, ai_severity from advisor_notes where title = $1", [`UI advisory note ${STAMP}`]);
  ok("C3 note saved from the UI", noteRow.rows.length === 1, JSON.stringify(noteRow.rows));
  ok("C4 note shown in the advisor's thread",
    await adv.evaluate((s) => document.body.innerText.includes(`UI advisory note ${s}`), STAMP));

  /* ── D · Mobile ──────────────────────────────────────────────────────── */
  const m = await newPage({ width: 390, height: 844 }, true);
  await signIn(m, { email: ADVISOR_EMAIL, password: advisorPassword });
  await m.waitForSelector('[data-testid="advisor-workspace"]', { timeout: 30000 });
  ok("D1 workspace renders on a phone", await has(m, '[data-testid="advisor-workspace"]'));
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("D2 no horizontal overflow on mobile", overflow <= 2, `overflow ${overflow}px`);
  const tapTargets = await m.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="advisor-tab-"]')].map((b) => b.getBoundingClientRect().height));
  ok("D3 tab targets are tappable (≥28px)", tapTargets.length > 0 && tapTargets.every((h) => h >= 28), JSON.stringify(tapTargets));
  await m.click('[data-testid="advisor-tab-NOTES"]');
  await sleep(2000);
  ok("D4 notes composer reachable on mobile", await has(m, '[data-testid="adv-note-composer"]'));

  /* ── E · Owner acknowledges + revokes ────────────────────────────────── */
  await owner.reload({ waitUntil: "networkidle2" });
  await owner.waitForSelector('[data-testid="advisory-tab"]', { timeout: 30000 });
  await owner.click('[data-testid="advisory-tab"]');
  await owner.waitForSelector('[data-testid="advisory-console"]', { timeout: 20000 });
  await sleep(3000);
  const noteId = noteRow.rows[0]?.id;
  // Actions live inside the note's thread — open it first (as a user would).
  if (noteId && (await has(owner, `[data-testid="adv-note-thread-${noteId}"]`))) {
    await owner.click(`[data-testid="adv-note-thread-${noteId}"]`);
    await sleep(1200);
  }
  ok("E1 owner sees the advisor's note",
    await owner.evaluate((s) => document.body.innerText.includes(`UI advisory note ${s}`), STAMP));
  if (noteId && (await has(owner, `[data-testid="adv-ack-${noteId}"]`))) {
    await owner.click(`[data-testid="adv-ack-${noteId}"]`);
    await sleep(2500);
    const after = await db.query("select status from advisor_notes where id = $1", [noteId]);
    ok("E2 owner can acknowledge from the UI", after.rows[0]?.status === "ACKNOWLEDGED", JSON.stringify(after.rows[0]));
  } else ok("E2 owner can acknowledge from the UI", false, "acknowledge button missing");

  const grantId = (await db.query("select id from advisor_assignments where user_id = $1", [advisorId])).rows[0]?.id;
  if (grantId && (await has(owner, `[data-testid="advisory-toggle-${grantId}"]`))) {
    await owner.click(`[data-testid="advisory-toggle-${grantId}"]`);
    await sleep(2500);
    const g = await db.query("select is_active from advisor_assignments where id = $1", [grantId]);
    ok("E3 owner can revoke access from the UI", g.rows[0]?.is_active === false, JSON.stringify(g.rows[0]));
  } else ok("E3 owner can revoke access from the UI", false, "revoke button missing");

  await adv.reload({ waitUntil: "networkidle2" }).catch(() => {});
  await sleep(3000);
  const advLockedOut = await adv.evaluate(() =>
    !!document.querySelector('[data-testid="login-screen"]') || !!document.querySelector('[data-testid="advisor-no-access"]'));
  ok("E4 revoked advisor loses the workspace", advLockedOut);

  /* ── F · Errors ──────────────────────────────────────────────────────── */
  ok("F1 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  fail++; failures.push(`harness crash: ${e.message}`);
  console.error(e);
} finally {
  try {
    if (advisorId) {
      await db.query("delete from advisor_note_replies where note_id in (select id from advisor_notes where author_user_id = $1)", [advisorId]);
      await db.query("delete from advisor_notes where author_user_id = $1", [advisorId]);
      await db.query("delete from advisor_visits where advisor_user_id = $1", [advisorId]);
      await db.query("delete from advisor_assignments where user_id = $1", [advisorId]);
      await db.query("delete from notifications where user_id = $1", [advisorId]);
      await db.query("delete from organization_members where user_id = $1", [advisorId]).catch(() => {});
      await db.query("delete from users where id = $1", [advisorId]);
    }
    await db.query("delete from advisor_notes where title like $1", [`%${STAMP}%`]);
    await db.query("delete from audit_trail where action like 'ADVISOR%'");
    await db.query("delete from ai_insights where title like 'Advisory Digest%'");
  } catch (e) { console.log(`cleanup note: ${e.message}`); }
  await db.end();
  await browser.close();
  console.log(`\n═══ RESULT: ${pass}/${pass + fail} passed ═══`);
  if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(fail ? 1 : 0);
}
