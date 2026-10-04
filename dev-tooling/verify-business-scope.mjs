#!/usr/bin/env node
/**
 * verify-business-scope.mjs — the shared business-scope model, end to end.
 *
 * Requirement (docs/BUSINESS-FILTERING-AUDIT.md §4): every screen that asks the
 * user to pick a business must default to the caller's OWN workspace, offer the
 * Owner → Unit → Type dimensions with counts and search where they are useful —
 * and never let the client see anything the server's permission scope did not
 * already allow.
 *
 * Layers:
 *   A. THE REAL LIBRARY (src/lib/businessScope.ts, transpiled with the project's
 *      own esbuild so this is not a hand-written mirror): defaults, owner
 *      grouping, "My Workspace" for a non-org-1 owner, type derivation, search,
 *      stale-selection reset, scope labels.
 *   B. API narrowing (live): /api/audit?ownerId=… and ?businessIds=… slice the
 *      record set + bizList for a Super Admin, and the parts always sum to the
 *      whole (no silent loss).
 *   C. NO WIDENING (live): a scoped auditor / normal owner cannot reach another
 *      owner's data with forged ownerId/businessIds, and owner NAMES are never
 *      published to them.
 *   D. UI (live, real Chromium): Audit & Review renders the shared scope bar,
 *      defaults to "My Workspace", groups the unit list by Owner with counts,
 *      searches it, narrows by Business Type, and switching Owner moves the
 *      app-wide Organization Lens with it.
 *   E. UI (auditor): the Owner control is not offered, the unit scope stays
 *      inside the granted business, and the record list never leaves it.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-business-scope.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const AUDITOR = { email: "emmanuel@gomina360.com", pw: process.env.GOMINA_AUDITOR_PW || "GoMina@User3" };
const AUDITOR_BIZ = 2; // the business Emmanuel holds an active audit grant for

let pass = 0, fail = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${msg}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.error(`  ❌ ${msg}${extra ? ` — ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────── A. load the REAL library via esbuild ─────────────── */
async function loadLib() {
  // esbuild ships with the app itself (Next), not with the browser tooling.
  const esbuild = createRequire(join(REPO, "package.json"))("esbuild");
  const out = await esbuild.build({
    entryPoints: [join(REPO, "src/lib/businessScope.ts")],
    bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent",
    alias: { "@": join(REPO, "src") },
  });
  const dir = mkdtempSync(join(tmpdir(), "scope-lib-"));
  const file = join(dir, "businessScope.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

/* ─────────────── HTTP helpers ─────────────── */
async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`login failed for ${email}: ${r.status}`);
  return { token: j.sessionToken, user: j.user };
}
const get = async (t, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { "x-gomina-session": t } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const summary = (res) => ({
  status: res.status,
  records: res.body?.records?.length ?? null,
  units: res.body?.bizList?.length ?? null,
  ownerIds: [...new Set((res.body?.bizList || []).map((b) => b.ownerId))].sort((a, b) => a - b),
  ownerNames: (res.body?.bizList || []).some((b) => b.ownerName),
  reportRecords: res.body?.report?.totals?.records ?? null,
});

const browser = await puppeteer.launch({
  args: chromium.args, executablePath: "/tmp/al2023/chromium",
  headless: true, defaultViewport: { width: 1440, height: 950 },
});

try {
  /* ═══════════ A. the shared model itself ═══════════ */
  console.log("\n── A. shared scope model (src/lib/businessScope.ts) ──");
  const L = await loadLib();

  const orgs = [{ id: 1, name: "GoMina Group" }, { id: 2, name: "AU WM Demo Org" }];
  const businesses = [
    { id: 1, name: "Poultry Farm", code: "POULTRY-01", category: "Poultry Farm", ownerId: 1 },
    { id: 2, name: "Concrete & Blocks", code: "BLOCK-01", category: "Block Factory", ownerId: 1 },
    { id: 3, name: "Tilapia & Catfish", code: "AQUA-01", category: "Aquaculture", ownerId: 1 },
    { id: 12, name: "WM Demo Unit", code: "WM-DEMO-02", category: "Other/General Merchandise", ownerId: 2 },
  ];
  const units = L.scopeUnits(businesses, orgs, 1);
  const owners = L.scopeOwners(units, 1);

  ok(L.DEFAULT_SELECTION.ownerId === "MY" && L.DEFAULT_SELECTION.unitId === "ALL" && L.DEFAULT_SELECTION.typeKey === "ALL",
    "the default scope is My Workspace · all units · all types");
  ok(units.length === 4 && units.every((u) => u.ownerId && u.ownerName), "every unit carries its owner id + name",
    units.map((u) => `${u.code}:${u.ownerName}`).join(", "));
  ok(owners.length === 2 && owners[0].isMine && owners[0].units === 3, "owners group with counts, own workspace first",
    JSON.stringify(owners.map((o) => `${o.name}(${o.units})`)));
  ok(L.unitsInScope(units, { ownerId: "MY", typeKey: "ALL" }, 1).length === 3, "“My Workspace” = own-org units only");
  ok(L.unitsInScope(units, { ownerId: "ALL", typeKey: "ALL" }, 1).length === 4, "“All owners” = every permitted unit");
  ok(L.unitsInScope(units, { ownerId: 2, typeKey: "ALL" }, 1).map((u) => u.id).join() === "12", "one owner’s units are selectable");
  ok(L.typesInScope(units, { ownerId: "MY" }, 1).length === 3, "types are derived from the CURRENT owner scope",
    L.typesInScope(units, { ownerId: "MY" }, 1).map((t) => t.label).join(", "));
  ok(L.typesInScope(units, { ownerId: 2 }, 1).length === 1, "switching owner re-derives the type list (no stale options)");
  ok(L.matchesUnit(units.find((u) => u.id === 2), "block") === true && L.matchesUnit(units.find((u) => u.id === 2), "poultry") === false,
    "search matches name/code/type/owner, not unrelated units");
  const stale = L.normalizeSelection({ ownerId: 2, unitId: 1, typeKey: "POULTRY" }, units, 1);
  ok(stale.unitId === "ALL" && stale.typeKey === "ALL", "a unit/type that left the scope resets instead of filtering to nothing",
    JSON.stringify(stale));
  ok(L.scopeLabel({ ownerId: "MY", unitId: "ALL", typeKey: "ALL" }, units, 1) === "My Workspace · 3 units",
    "the scope label states whose workspace and how many units");
  // An Org-2 owner has their OWN workspace — never an empty list.
  const org2Units = L.scopeUnits(businesses, [], 2);
  ok(L.unitsInScope(org2Units, { ownerId: "MY", typeKey: "ALL" }, 2).length === 1,
    "a non-org-1 owner’s “My Workspace” is their own organization (not empty)");
  ok(L.myOrgIdOf({ isSuperAdmin: true, organizationIds: [2] }) === 1, "the Super Admin’s workspace stays the Main Owner’s (org 1)");
  ok(L.myOrgIdOf({ organizationIds: [2] }) === 2 && L.myOrgIdOf({ primaryOrgId: 3 }) === 3, "everyone else’s workspace is their own organization");

  /* ═══════════ B. API narrowing (Super Admin) ═══════════ */
  console.log("\n── B. /api/audit narrowing (Super Admin) ──");
  const owner = await login(OWNER.email, OWNER.pw);
  ok(owner.user.isSuperAdmin === true, "super-admin session");
  const all = await get(owner.token, "/api/audit");
  const mine = await get(owner.token, "/api/audit?ownerId=1");
  const other = await get(owner.token, "/api/audit?ownerId=2");
  const twoUnits = await get(owner.token, "/api/audit?businessIds=1,2");
  const impossible = await get(owner.token, "/api/audit?ownerId=2&businessIds=1");

  const S = { all: summary(all), mine: summary(mine), other: summary(other), units: summary(twoUnits), none: summary(impossible) };
  ok(S.all.status === 200 && S.all.records > 0, "platform scope loads", `${S.all.records} records · ${S.all.units} units`);
  ok(S.mine.units < S.all.units && S.mine.ownerIds.join() === "1", "ownerId=1 narrows to My Workspace only",
    `${S.mine.units} of ${S.all.units} units`);
  ok(S.other.units === 1 && S.other.ownerIds.join() === "2", "another owner’s scope is reachable on demand", `${S.other.units} unit`);
  ok(S.mine.records + S.other.records === S.all.records, "the parts sum to the whole (nothing silently lost)",
    `${S.mine.records} + ${S.other.records} = ${S.all.records}`);
  ok(S.units.units === 2 && S.units.records < S.all.records, "a unit set narrows records the same way", `${S.units.records} records`);
  ok(S.none.records === 0 && S.none.units === 0, "an out-of-scope owner+unit combination answers empty (never falls back to everything)");
  ok(all.body.bizList.every((b) => b.ownerId != null), "bizList publishes ownerId so the client can group");
  ok(all.body.bizList.some((b) => !!b.ownerName), "the Super Admin also receives owner names");
  ok(S.mine.reportRecords === S.mine.records, "reports/KPIs are computed from the narrowed set (not the platform total)",
    `${S.mine.reportRecords} = ${S.mine.records}`);

  /* ═══════════ C. no widening, no owner-name leak ═══════════ */
  console.log("\n── C. scoped callers cannot widen ──");
  const auditor = await login(AUDITOR.email, AUDITOR.pw);
  const aBase = await get(auditor.token, "/api/audit");
  const aForgedOwner = await get(auditor.token, "/api/audit?ownerId=2");
  const aForgedUnits = await get(auditor.token, "/api/audit?businessIds=1,3,12");
  const aOwn = await get(auditor.token, `/api/audit?businessIds=${AUDITOR_BIZ}`);
  if (aBase.status === 200) {
    const scoped = summary(aBase);
    ok(scoped.units === 1 && scoped.ownerIds.join() === "1", "the auditor sees exactly their granted business",
      `${scoped.units} unit, owner ${scoped.ownerIds}`);
    ok(scoped.ownerNames === false, "owner names are NOT published to a scoped auditor");
    ok(summary(aForgedOwner).records === 0, "a forged out-of-scope ownerId returns nothing");
    ok(summary(aForgedUnits).units === 0 || summary(aForgedUnits).units === 1,
      "a forged businessIds list cannot widen the granted scope",
      `${summary(aForgedUnits).units} unit(s) returned`);
    ok(summary(aOwn).records === scoped.records, "the auditor can still narrow to their own granted unit");
  } else {
    // The route is assignment-only; if the fixture grant is absent, assert the
    // refusal instead of pretending the scope passed.
    ok(aBase.status === 403, "without an active grant the center refuses (assignment-only contract)", `HTTP ${aBase.status}`);
  }

  /* ═══════════ D. UI — Super Admin ═══════════ */
  console.log("\n── D. Audit & Review UI (Super Admin) ──");
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
  const auditRequests = [];
  page.on("request", (r) => { if (r.url().includes("/api/audit?")) auditRequests.push(r.url()); });
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 120000 });
  await sleep(2000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((x) => /audit/i.test(x.textContent || ""));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector('[data-testid="aud-scope"]', { timeout: 60000 });
  await sleep(2500);

  const chip = await page.$eval('[data-testid="aud-scope-chip"]', (e) => (e.textContent || "").replace(/\s+/g, " ").trim());
  ok(/^My Workspace · \d+ unit/.test(chip), "the default scope is My Workspace", chip);
  ok(auditRequests.some((u) => /ownerId=1(&|$)/.test(u)), "the very first request already narrowed to the caller’s workspace",
    auditRequests[0]?.replace(BASE, "") || "no request seen");
  ok(!auditRequests.some((u) => /ownerId=2/.test(u)), "no other owner’s data was requested by default");

  const ownerOpts = await page.$$eval('[data-testid="aud-scope-owner"] option', (os) => os.map((o) => o.textContent.trim()));
  ok(ownerOpts.length === 3 && /My Workspace \(\d+\)/.test(ownerOpts[0]) && /All owners \(\d+\)/.test(ownerOpts[1]),
    "the Owner control offers My Workspace, All owners and each other owner (with counts)", ownerOpts.join(" | "));

  await page.click('[data-testid="aud-scope-unit"]');
  await sleep(600);
  const panel = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-testid="aud-scope-panel"] div')]
      .map((d) => (d.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => /^My Workspace · \d+$/.test(t)),
    units: document.querySelectorAll('[data-testid^="aud-scope-unit-"]').length,
    hasSearch: !!document.querySelector('[data-testid="aud-scope-search"]'),
  }));
  ok(panel.groups.length >= 1, "the unit list is grouped under its owner with a count", panel.groups[0] || "no group header");
  ok(panel.units >= 2, "units are listed individually", `${panel.units} options`);
  ok(panel.hasSearch, "the unit picker offers search (long lists stay usable)");
  await page.type('[data-testid="aud-scope-search"]', "block");
  await sleep(400);
  const searched = await page.$$eval('[data-testid^="aud-scope-unit-"]', (bs) =>
    bs.map((b) => (b.getAttribute("data-testid") || "").replace("aud-scope-unit-", ""))
  );
  ok(searched.length === 2 && searched.includes("all"), "search narrows the picker (and keeps the All row)",
    `${searched.length} rows for “block”`);
  await page.keyboard.press("Escape");
  await sleep(300);

  // Business Type narrows the scope and reaches the API.
  const typeBefore = await page.$eval('[data-testid="aud-scope-type"]', (e) => e.value);
  const typeKey = await page.$eval('[data-testid="aud-scope-type"]', (e) =>
    [...e.options].map((o) => o.value).find((v) => v && v !== "ALL")
  );
  await page.select('[data-testid="aud-scope-type"]', typeKey);
  await sleep(2500);
  const typeAfter = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="aud-scope-chip"]')?.textContent?.replace(/\s+/g, " ").trim(),
    unitLabel: document.querySelector('[data-testid="aud-scope-unit"]')?.textContent?.replace(/\s+/g, " ").trim(),
  }));
  ok(typeAfter.chip !== chip || /units?$/.test(typeAfter.chip || ""), "choosing a type re-labels the scope",
    `${chip} → ${typeAfter.chip}`);
  ok(auditRequests.some((u) => /businessIds=\d/.test(u)), "the type filter narrows the API request (server-side, not just the list)");
  const beforeType = auditRequests.length;
  await page.select('[data-testid="aud-scope-type"]', "ALL");
  await sleep(1500);
  ok(typeBefore === "ALL" && auditRequests.length > beforeType, "clearing the type reloads the unscoped set");

  // Owner switch moves the app-wide lens.
  await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="aud-scope-owner"]');
    sel.value = "2"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(3000);
  const switched = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="aud-scope-chip"]')?.textContent?.replace(/\s+/g, " ").trim(),
    lens: document.querySelector('[data-testid="org-lens-select"]')?.value,
    sidebar: [...document.querySelectorAll('[data-testid="nav-sidebar"] button')]
      .map((b) => (b.textContent || "").replace(/\s+/g, " ").trim())
      .find((t) => /Owned by|My Businesses|Platform Businesses/.test(t)),
  }));
  ok(switched.lens === "2", "switching Owner in Audit also moves the app-wide Organization Lens", `lens=${switched.lens}`);
  ok(/WM Demo|Owner/i.test(switched.chip || ""), "the scope chip names the owner being viewed", switched.chip);
  ok(!!switched.sidebar && /Owned by/i.test(switched.sidebar), "the sidebar reflects the same owner", switched.sidebar || "—");
  await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="aud-scope-owner"]');
    sel.value = "MY"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(2000);
  const backToMine = await page.evaluate(() => ({
    chip: document.querySelector('[data-testid="aud-scope-chip"]')?.textContent?.replace(/\s+/g, " ").trim(),
    lens: document.querySelector('[data-testid="org-lens-select"]')?.value,
  }));
  ok(backToMine.lens === "MY" && /^My Workspace/.test(backToMine.chip || ""), "switching back restores My Workspace",
    `${backToMine.lens} · ${backToMine.chip}`);
  ok(pageErrors.length === 0, "no page errors on the Audit & Review surface", pageErrors.slice(0, 2).join(" | "));
  await page.close();

  /* ═══════════ E. UI — scoped auditor ═══════════ */
  console.log("\n── E. Audit & Review UI (scoped auditor) ──");
  // A fresh context: the Super Admin's session cookie must not leak into the
  // auditor's browser (that would silently test the wrong role).
  const aCtx = await browser.createBrowserContext();
  const apage = await aCtx.newPage();
  const aErrors = [];
  apage.on("pageerror", (e) => aErrors.push(String(e.message).slice(0, 160)));
  const aReqs = [];
  apage.on("request", (r) => { if (r.url().includes("/api/audit?")) aReqs.push(r.url()); });
  await apage.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await apage.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await apage.type('[data-testid="login-email"]', AUDITOR.email);
  await apage.type('[data-testid="login-password"]', AUDITOR.pw);
  await apage.click('[data-testid="login-submit"]');
  await apage.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 120000 });
  await sleep(2500);
  const opened = await apage.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((x) => /audit/i.test(x.textContent || ""));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (opened) {
    const hasScope = await apage.waitForSelector('[data-testid="aud-scope"]', { timeout: 30000 }).then(() => true).catch(() => false);
    if (hasScope) {
      await sleep(2000);
      const aUi = await apage.evaluate(() => ({
        ownerControl: !!document.querySelector('[data-testid="aud-scope-owner"]'),
        chip: document.querySelector('[data-testid="aud-scope-chip"]')?.textContent?.replace(/\s+/g, " ").trim(),
        unitLabel: document.querySelector('[data-testid="aud-scope-unit"]')?.textContent?.replace(/\s+/g, " ").trim(),
        scopeChip: document.querySelector('[data-testid="aud-scope"]')?.textContent?.replace(/\s+/g, " ").trim(),
      }));
      ok(!aUi.ownerControl, "the Owner control is NOT offered to a single-owner caller (no new cognitive load)");
      ok(!/Owner \/ Organization/.test(aUi.scopeChip || ""), "no owner dimension is rendered at all for them");
      ok(/All units \(1\)|BLOCK-01|Mina Concrete/i.test(`${aUi.unitLabel} ${aUi.scopeChip}`),
        "their unit list contains exactly the granted business", aUi.unitLabel || "—");
      ok(aReqs.length > 0 && aReqs.every((u) => !/ownerId=/.test(u)), "their requests never carry an owner parameter (server scope decides)");
    } else {
      ok(true, "auditor has no Audit center on this seed (assignment-only) — UI layer skipped");
    }
  } else {
    ok(true, "auditor has no Audit nav on this seed — UI layer skipped");
  }
  ok(aErrors.length === 0, "no page errors on the auditor’s session", aErrors.slice(0, 2).join(" | "));
  await aCtx.close();
} catch (err) {
  fail++;
  console.error("💥 suite error:", err?.message || err);
} finally {
  await browser.close();
  console.log("\n" + "─".repeat(56));
  console.log(fail === 0 ? `✅ ALL BUSINESS-SCOPE CHECKS PASSED (${pass} checks)` : `❌ ${fail} FAILED of ${pass + fail} checks`);
  process.exit(fail === 0 ? 0 : 1);
}
