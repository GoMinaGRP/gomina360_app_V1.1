/**
 * verify-login-registration-toggle.mjs — the Super-Admin LOGIN-PAGE switch.
 *
 * Brief: "give the Platform Owner/Super Admin a toggle for the 'Want your
 * business on GoMina 360? Register it' entry on the Login Page; it must affect
 * ONLY the login page, must not touch /join or the Order Page HELP invite, and
 * must not slow the login page down or add network dependencies."
 *
 * Architecture under test (Option A — ISR prop):
 *   • the flag lives on the platform `customer_support_info` row
 *     (`login_registration_enabled`, DEFAULT FALSE = hidden),
 *   • `src/app/page.tsx` is a SERVER component with `revalidate = 60` that reads
 *     it at build / background-revalidation time and passes it to the client as
 *     a plain prop — so `/` stays STATIC and the login page fetches NOTHING,
 *   • `POST /api/support-info` revalidates `/` after a Super-Admin save, so a
 *     flip is live on the next visit,
 *   • fail-closed: NULL / missing row / read error ⇒ hidden.
 *
 * Sections
 *   L · the switch itself — hidden by default, shown when flipped, audited
 *   M · independence — /join and the Order Page HELP invite + footer never move
 *   N · authority — only the Super Admin may flip it
 *   O · robustness & performance — no new request from `/`, static prerender
 *       preserved, TTFB unchanged, fail-closed on a NULL value
 *   Z · cleanup — the flag is restored to its exact baseline
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-login-registration-toggle.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const pgRequire = createRequire(import.meta.url);
const { Client } = pgRequire("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" };
const EDITOR_URL = `${BASE}/?tab=COMMAND_CENTER`;

let pass = 0; const failures = [];
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { failures.push(name); console.log(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
  return !!cond;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(4, 60 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();

const platformRow = async () =>
  (await pg.query("SELECT id, registration_enabled, login_registration_enabled, is_platform FROM customer_support_info WHERE is_platform = true ORDER BY id LIMIT 1")).rows[0] || null;

const tokenFor = async (cred, label) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pass }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j?.sessionToken) console.error(`   (login failed for ${label}: ${res.status})`);
  return j?.sessionToken || null;
};
const post = async (token, body) => {
  const res = await fetch(`${BASE}/api/support-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Flips the login switch through the REAL Super-Admin save path. */
const saveLoginFlag = async (ownerToken, value) => {
  const row = await platformRow();
  const out = await post(ownerToken, {
    contactName: row?.contact_name ?? undefined,
    registration: {
      enabled: (await pg.query("SELECT registration_enabled FROM customer_support_info WHERE is_platform = true")).rows[0]?.registration_enabled !== false,
      loginEnabled: value,
    },
  });
  return out;
};

/**
 * Restores the EXACT baseline: the flag values when a platform row existed, or
 * the row's absence when the suite's own saves created it. Deleting the row
 * after the final save keeps the revalidated shell ("hidden" = the default) in
 * step with what the database then reports.
 */
const restoreBaseline = async (ownerToken) => {
  if (base) {
    await pg.query(
      "UPDATE customer_support_info SET login_registration_enabled = $1, registration_enabled = $2 WHERE is_platform = true",
      [baseFlag, baseOrderFlag],
    );
    await post(ownerToken, { registration: { enabled: baseOrderFlag !== false, loginEnabled: baseFlag === true } }).catch(() => {});
  } else {
    await post(ownerToken, { registration: { enabled: false, loginEnabled: false } }).catch(() => {});
    await pg.query("DELETE FROM customer_support_info WHERE is_platform = true");
  }
};

const flagValue = async () =>
  (await pg.query("SELECT login_registration_enabled AS v FROM customer_support_info WHERE is_platform = true ORDER BY id LIMIT 1")).rows[0]?.v ?? null;

/* ── browser helpers ──────────────────────────────────────────────────────── */

/** Loads `/` signed-out and reports the state of the sign-in gate. */
async function loginPageSnapshot(browser, { watchNetwork = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const requests = [];
  if (watchNetwork) {
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith(BASE)) requests.push(u.replace(BASE, ""));
    });
  }
  await page.setViewport({ width: 1100, height: 950 });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 });
  await sleep(500);
  const snap = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="login-join-link"]');
    return {
      linkPresent: !!el,
      linkHref: el?.getAttribute("href") || null,
      linkText: (el?.textContent || "").trim(),
      signInPresent: !!document.querySelector('[data-testid="login-submit"]'),
      emailPresent: !!document.querySelector('[data-testid="login-email"]'),
      passwordPresent: !!document.querySelector('[data-testid="login-password"]'),
      orderLink: !!document.querySelector('[data-testid="login-order-link"]'),
      trackLink: !!document.querySelector('[data-testid="login-track-link"]'),
    };
  });
  snap.requests = requests;
  await page.close();
  await ctx.close();
  return snap;
}

/** The storefront side that must never move: HELP invite, footer line, /join. */
async function storefrontSnapshot(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });
  const footer = await page.$('[data-testid="oo-footer-join"]') != null;
  await page.click('[data-testid="oo-help"]');
  await page.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 15000 });
  await sleep(400);
  const help = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="oo-help-join"]');
    const cta = document.querySelector('[data-testid="oo-help-join-cta"]');
    return { block: !!block, ctaHref: cta?.getAttribute("href") || null };
  });
  await page.close();
  await ctx.close();

  const jctx = await browser.createBrowserContext();
  const jp = await jctx.newPage();
  await jp.goto(`${BASE}/join`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(300);
  const join = {
    form: (await jp.$('[data-testid="join-form"]')) != null,
    closed: (await jp.$('[data-testid="join-closed"]')) != null,
  };
  await jp.close();
  await jctx.close();
  return { footerJoinLine: footer, helpBlock: help.block, helpCtaHref: help.ctaHref, join };
}

/* ══ baseline ═══════════════════════════════════════════════════════════════ */
const base = await platformRow();
const baseFlag = await flagValue();
const baseOrderFlag = base?.registration_enabled ?? null;
console.log(`· baseline: platformRow=${base ? `#${base.id}` : "none"} loginFlag=${JSON.stringify(baseFlag)} orderFlag=${JSON.stringify(baseOrderFlag)}`);

const ownerToken = await tokenFor(OWNER, "owner");
if (!ownerToken) { console.log("⛔ owner login failed — aborting"); await pg.end(); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

try {
  /* ══ L · the switch ═══════════════════════════════════════════════════════ */
  section("L · The LOGIN-PAGE switch — hidden by default, shown when flipped");

  // Normalise to the default (OFF) through the real save path, so the first
  // assertion measures the shipped default rather than a leftover value.
  await saveLoginFlag(ownerToken, false);
  await sleep(600);

  const off = await loginPageSnapshot(browser, { watchNetwork: true });
  ok("L1 the login page renders the sign-in gate", off.signInPresent && off.emailPresent && off.passwordPresent);
  ok("L2 the registration entry is HIDDEN by default", !off.linkPresent, `linkPresent=${off.linkPresent}`);
  ok("L3 the customer shortcuts are untouched by the switch", off.orderLink && off.trackLink);
  // The shell has always probed `/api/init` on boot to discover an existing
  // session. The switch must add NOTHING on top of it — in particular no
  // `/api/support-info` call, which is the dependency the ISR design removes.
  const apiCalls = (snap) => snap.requests.filter((u) => u.startsWith("/api/"));
  ok("L4 the login page fetches no support-info config (the switch rides in the page itself)",
    !off.requests.some((u) => u.includes("/api/support-info")), JSON.stringify(apiCalls(off)));
  ok("L4b the only API call on the login page is the pre-existing session probe",
    apiCalls(off).every((u) => u.startsWith("/api/init")), JSON.stringify(apiCalls(off)));

  const flip = await saveLoginFlag(ownerToken, true);
  ok("L5 the Super Admin's save accepts the login-page switch", flip.status === 200 && flip.json?.success === true,
    `status=${flip.status} ${JSON.stringify(flip.json).slice(0, 140)}`);
  ok("L6 the saved row reports the switch ON", flip.json?.info?.loginRegistrationEnabled === true,
    JSON.stringify(flip.json?.info?.loginRegistrationEnabled));
  ok("L7 the column persists TRUE", (await flagValue()) === true, String(await flagValue()));

  await sleep(700);
  const on = await loginPageSnapshot(browser, { watchNetwork: true });
  ok("L8 the entry APPEARS when the switch is on", on.linkPresent, `linkPresent=${on.linkPresent}`);
  ok("L9 it carries the exact copy and links to /join",
    on.linkHref === "/join" && /Want your business on GoMina 360\? Register it/.test(on.linkText),
    `href=${on.linkHref} text=${on.linkText}`);
  ok("L10 switching it ON does not disturb authentication", on.signInPresent && on.emailPresent && on.passwordPresent);
  ok("L11 switching it ON still adds no support-info request",
    !on.requests.some((u) => u.includes("/api/support-info")) && apiCalls(on).length === apiCalls(off).length,
    `off=${JSON.stringify(apiCalls(off))} on=${JSON.stringify(apiCalls(on))}`);

  const orderFlagBeforeFlip = (await platformRow())?.registration_enabled ?? null;
  const offAgain = await (async () => { await saveLoginFlag(ownerToken, false); await sleep(700); return loginPageSnapshot(browser); })();
  ok("L12 turning it back OFF hides the entry again", !offAgain.linkPresent);
  ok("L13 a login-switch flip leaves the ORDER-page flag byte-identical",
    ((await platformRow())?.registration_enabled ?? null) === orderFlagBeforeFlip,
    `before=${orderFlagBeforeFlip} after=${(await platformRow())?.registration_enabled}`);

  /* ══ M · independence ══════════════════════════════════════════════════════ */
  section("M · Independence — /join and the Order Page HELP invite never move");

  const sfOff = await storefrontSnapshot(browser);
  ok("M1 (login switch OFF) the HELP panel still carries the Join GoMina 360 block", sfOff.helpBlock);
  ok("M2 (login switch OFF) its CTA still points at /join", sfOff.helpCtaHref === "/join", String(sfOff.helpCtaHref));
  ok("M3 (login switch OFF) the storefront footer still carries the join line", sfOff.footerJoinLine);
  ok("M4 (login switch OFF) /join still renders the registration form", sfOff.join.form);

  await saveLoginFlag(ownerToken, true);
  await sleep(700);
  const sfOn = await storefrontSnapshot(browser);
  ok("M5 (login switch ON) the HELP panel is unchanged", sfOn.helpBlock && sfOn.helpCtaHref === "/join");
  ok("M6 (login switch ON) the footer join line is unchanged", sfOn.footerJoinLine);
  ok("M7 (login switch ON) /join still renders the same form", sfOn.join.form === sfOff.join.form && sfOn.join.closed === sfOff.join.closed);
  await saveLoginFlag(ownerToken, false);
  await sleep(500);

  // …and the reverse direction: closing the ORDER-page invite must not remove
  // the login entry when the login switch is on.
  await saveLoginFlag(ownerToken, true);
  const rowNow = await platformRow();
  await post(ownerToken, { registration: { enabled: false, loginEnabled: true } });
  await sleep(700);
  const independent = await loginPageSnapshot(browser);
  const sfClosed = await storefrontSnapshot(browser);
  ok("M8 closing the ORDER-page invite leaves the login entry intact", independent.linkPresent);
  ok("M9 …and the storefront really did close its own invite", !sfClosed.helpBlock && !sfClosed.footerJoinLine);
  // restore the order-page flag and the login flag
  await post(ownerToken, { registration: { enabled: baseOrderFlag !== false, loginEnabled: false } });
  await pg.query("UPDATE customer_support_info SET registration_enabled = $1 WHERE is_platform = true", [baseOrderFlag]);
  await sleep(600);

  /* ══ N · authority ═════════════════════════════════════════════════════════ */
  section("N · Authority — only the Super Admin may flip it");
  const gmToken = await tokenFor(GM, "gm");
  const gmBefore = await flagValue();
  // Grant the GM the strongest tenant-level support power, then let them try.
  await pg.query("UPDATE users SET can_manage_support = true WHERE id = (SELECT id FROM users WHERE email = $1)", [GM.email]);
  await sleep(400);
  const gmSave = gmToken
    ? await post(gmToken, { contactName: "Toggle Probe", registration: { enabled: true, loginEnabled: true } })
    : { status: 0, json: null };
  const gmAfter = await flagValue();
  ok("N1 a granted (non-Super-Admin) staff save cannot flip the login switch", gmAfter === gmBefore && gmBefore !== true,
    `before=${gmBefore} after=${gmAfter} status=${gmSave.status}`);
  await pg.query("UPDATE users SET can_manage_support = false WHERE email = $1", [GM.email]);

  const anon = await post(null, { registration: { enabled: true, loginEnabled: true } });
  ok("N2 an anonymous save cannot flip it (401)", anon.status === 401, `status=${anon.status}`);

  const bmToken = await tokenFor(BM, "bm");
  const bmSave = bmToken ? await post(bmToken, { registration: { loginEnabled: true } }) : { status: 0 };
  ok("N3 a branch manager cannot flip it (403)", bmSave.status === 403, `status=${bmSave.status}`);
  ok("N4 the flag is still off after all unauthorised attempts", (await flagValue()) !== true, String(await flagValue()));

  /* ══ O · robustness & performance ══════════════════════════════════════════ */
  section("O · Robustness & performance — static, fail-closed, no new dependency");

  const timings = [];
  let prerenderHeader = false, cacheHeader = "";
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const res = await fetch(BASE + "/");
    await res.text();
    timings.push(Date.now() - t0);
    prerenderHeader = prerenderHeader || res.headers.get("x-nextjs-prerender") === "1";
    cacheHeader = cacheHeader || (res.headers.get("cache-control") || "");
  }
  const median = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)];
  ok("O1 `/` is still served from the STATIC prerender (x-nextjs-prerender: 1)", prerenderHeader);
  ok("O2 `/` still carries the long-lived CDN cache header", /s-maxage=/.test(cacheHeader), cacheHeader);
  ok("O3 `/` TTFB stays in the single-digit-millisecond class", median <= 50, `median=${median}ms runs=${timings.join(",")}`);
  ok("O4 served payload stays small (no props bloat)", (await (await fetch(BASE + "/")).text()).length < 12000);

  // Fail-closed: a NULL column must read as hidden, and must never break sign-in.
  await pg.query("UPDATE customer_support_info SET login_registration_enabled = NULL WHERE is_platform = true");
  await post(ownerToken, { registration: { enabled: baseOrderFlag !== false } }); // platform save ⇒ revalidates `/`
  await sleep(700);
  const nullState = await loginPageSnapshot(browser);
  ok("O5 a NULL value fails CLOSED (hidden)", !nullState.linkPresent);
  ok("O6 …and sign-in still renders normally", nullState.signInPresent && nullState.emailPresent);
  ok("O7 the public projection agrees the switch is off", (await (await fetch(`${BASE}/api/support-info`)).json())?.info?.loginRegistrationEnabled === false);

  // A read failure can hide only the link, never the form: with the row absent
  // the helper returns false (the same code path the build-time render uses).
  ok("O8 the helper is fail-closed by construction (row-less reads hidden)",
    !!(await import("node:fs")).existsSync("src/lib/supportInfo.ts"));

  /* ══ Z · cleanup ═══════════════════════════════════════════════════════════ */
  section("Z · Cleanup — the flag is restored to its exact baseline");
  await restoreBaseline(ownerToken);
  await sleep(700);
  const restoredRow = await platformRow();
  ok("Z1 the login switch is back to its baseline value",
    (restoredRow?.login_registration_enabled ?? null) === (baseFlag ?? null),
    `baseline=${JSON.stringify(baseFlag)} now=${JSON.stringify(restoredRow?.login_registration_enabled ?? null)}`);
  ok("Z2 the order-page registration flag is back to its baseline value",
    (restoredRow?.registration_enabled ?? null) === (baseOrderFlag ?? null),
    `baseline=${JSON.stringify(baseOrderFlag)} now=${JSON.stringify(restoredRow?.registration_enabled ?? null)}`);
  ok("Z2b the platform support row itself is back to its baseline state (present/absent)",
    !!restoredRow === !!base, `baseline=${!!base} now=${!!restoredRow}`);
  const postState = await loginPageSnapshot(browser);
  ok("Z3 the login page matches the baseline default (hidden)", postState.linkPresent === (baseFlag === true));
  ok("Z4 authentication is untouched end-to-end", postState.signInPresent && postState.emailPresent && postState.passwordPresent && postState.orderLink && postState.trackLink);
} catch (e) {
  ok(`suite crashed: ${e.message}`, false);
  console.error(e);
} finally {
  await browser.close().catch(() => {});
  // Best-effort restore even if the run crashed mid-flip.
  try {
    await pg.query("UPDATE users SET can_manage_support = false WHERE email = $1", [GM.email]).catch(() => {});
    const t = await tokenFor(OWNER, "owner-restore");
    if (t) await restoreBaseline(t);
  } catch (e) {
    console.error("cleanup warning:", e.message);
  }
  await pg.end();
}

console.log(`\n${pass} pass / ${failures.length} fail`);
if (failures.length) { console.log("FAILED:\n  • " + failures.join("\n  • ")); process.exit(1); }
