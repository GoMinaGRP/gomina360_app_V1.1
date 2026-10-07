#!/usr/bin/env node
/**
 * roles-picker-evidence.mjs — post-fix visual evidence for the roles &
 * permissions reconciliation: BOTH user-creation surfaces now offer the same
 * registry-driven role list, externals are grouped apart, and the capability
 * rows carry one canonical set of `perm-*` hooks.
 *
 * Screenshots:  /home/user/gomina360_app_V1.1/docs/evidence/roles-picker-*.png
 * Run:  node dev-tooling/audit/roles-picker-evidence.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = "/home/user/gomina360_app_V1.1/docs/evidence";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const login = async (email, password) => {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json().catch(() => ({})))?.sessionToken || null;
};
const owner = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
if (!owner) { console.error("owner login failed"); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1500, height: 1040 },
});
const page = await browser.newPage();
page.on("dialog", (d) => d.dismiss().catch(() => {}));
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate((t) => sessionStorage.setItem("gomina_session_token", t), owner);
await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
await sleep(2500);

const readOptions = () =>
  page.evaluate(() => {
    const sel = document.querySelector("[data-testid='usr-create-role']");
    if (!sel) return null;
    const out = [];
    for (const child of sel.children) {
      if (child.tagName === "OPTGROUP") {
        for (const o of child.children) out.push({ group: child.label, value: o.value, label: o.textContent });
      } else out.push({ group: null, value: child.value, label: child.textContent });
    }
    return { selected: sel.value, options: out };
  });

const clickByText = async (re, tag = "button") =>
  page.evaluate(
    (reSrc, tagName) => {
      const rx = new RegExp(reSrc, "i");
      const el = [...document.querySelectorAll(tagName)].find((b) => rx.test(b.textContent || ""));
      el?.click();
      return !!el;
    },
    re.source,
    tag,
  );

const openEnterprise = async () => {
  // The sidebar row is labelled "Enterprise Users" (rail group: Administration).
  await clickByText(/Enterprise Users/);
  await sleep(2500);
  // "Register" opens the create modal
  const opened = await clickByText(/Register New Account|Register|Add User/i);
  await sleep(1400);
  return opened;
};

let report = {};

// ── 1. Enterprise Users → Register ──────────────────────────────────────────
await openEnterprise();
report.enterpriseCreate = await readOptions();
const createTestids = await page.evaluate(() =>
  [...document.querySelectorAll("[data-testid^='perm-']")].map((e) => e.getAttribute("data-testid")),
);
report.enterpriseCreatePerms = createTestids;
await page.screenshot({ path: `${OUT}/roles-picker-enterprise-create.png`, fullPage: false });
await clickByText(/^\s*(Cancel|Close)\s*$/i);
await sleep(700);

// Edit an existing user → the SAME picker + editor
report.editOpened = await clickByText(/^\s*(Edit|Manage)\s*$/i);
await sleep(1500);
report.enterpriseEdit = await page.evaluate(() => {
  const sel = document.querySelector("[data-testid='usr-edit-role']");
  return sel ? { selected: sel.value, options: [...sel.options].map((o) => `${o.value}:${o.textContent}`) } : null;
});
report.enterpriseEditPerms = await page.evaluate(() =>
  [...document.querySelectorAll("[data-testid^='perm-']")].map((e) => e.getAttribute("data-testid")),
);
await page.screenshot({ path: `${OUT}/roles-picker-enterprise-edit.png` });

// ── 2. Users & Access console → New user ────────────────────────────────────
await clickByText(/^\s*(Cancel|Close)\s*$/i);
await sleep(700);
// Open the Users & Access console from the top-right key button.
// Users & Access lives on the unit roster (Manage Sales Persons) — the same
// button a Branch Manager uses. The OWNER reaches it because the gate is
// `canSeeEnterpriseUsers`, not the raw delegate flag.
await clickByText(/Manage Sales Persons/i);
await sleep(2500);
report.consoleOpened = await page.evaluate(() => {
  const el = document.querySelector("[data-testid='open-user-access-bm']");
  el?.click();
  return !!el;
});
await sleep(2000);
report.consoleCreateOpened = await clickByText(/^\s*(Add|New|Create)\s*$/i) ||
  (await page.evaluate(() => {
    const el = document.querySelector("[data-testid='user-create-open']");
    el?.click();
    return !!el;
  }));
await sleep(1500);
await page.click("[data-testid='user-create-open']").catch(() => {});
await sleep(1200);
report.consoleCreate = await page.evaluate(() => {
  const sel = document.querySelector("[data-testid='user-form-role']");
  return sel ? { selected: sel.value, options: [...sel.options].map((o) => `${o.value}:${o.textContent}`) } : null;
});
report.consoleCreatePerms = await page.evaluate(() =>
  [...document.querySelectorAll("[data-testid^='perm-']")].map((e) => e.getAttribute("data-testid")),
);
await page.screenshot({ path: `${OUT}/roles-picker-console-create.png` });

// role filter on the Enterprise directory must list every role
await clickByText(/^\s*Cancel\s*$/i);
await sleep(700);
report.filter = await page.evaluate(() => {
  const sel = [...document.querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => o.value === "FARM_ADVISOR"),
  );
  return sel ? [...sel.options].map((o) => `${o.value}:${o.textContent}`) : null;
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
