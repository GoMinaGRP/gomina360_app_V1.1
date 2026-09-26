// Modal-level mobile/tablet responsiveness audit.
//
// On EVERY navigation surface, clicks every "opener" control (testids like
// cw-open-wash, hw-new-delivery, fm-btn-new-formula, …) and audits the modal
// that appears at PHONE 375px / TABLET 768px:
//   • the modal overlay's interactive elements sit fully inside the viewport
//     (unless inside a legit horizontal scroller)
//   • no horizontal document overflow while the modal is open
//   • the modal actually CLOSES again (Escape / close button)
//
//   node dev-tooling/verify-responsive-modals.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const VIEWPORTS = (process.env.VIEWPORTS || "phone,tablet").split(",");
const ROLES = (process.env.ROLES || "owner,worker").split(",");
const VP = { phone: { width: 375, height: 812, isMobile: true, hasTouch: true }, tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true } };

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageErrors = [];
const isNoise = (t) => /eval\(\) is not supported|React requires eval\(\)|React will never use eval|ResizeObserver loop/.test(t);

const issues = []; // { vp, role, surface, opener, kind, detail }
let modalsChecked = 0, openersTried = 0;
let shotN = 0;

const OPENER_RE = /-open$|-open-|btn-new-|-new$|console-new-note/;
const EXCLUDE_RE = /scan|qr-|delete|remove|cancel|close|signout|logout|export|download|share|pin-|map-|lightbox/;

async function newPage(vp, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VP[vp]);
  page.on("pageerror", (e) => { if (!isNoise(String(e))) pageErrors.push(`[${label}] ${String(e).slice(0, 200)}`); });
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!isNoise(t) && !/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(`[${label}] ${t.slice(0, 200)}`); } });
  return { ctx, page };
}

async function login(page, who) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await page.type('[data-testid="login-email"]', who.email);
  await page.type('[data-testid="login-password"]', who.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** All visible fixed-position layers (backdrops + panels + drawers) that
 *  make up the currently-open modal group. */
const FIXED_LAYERS = () => [...document.querySelectorAll('div[class*="fixed"]')].filter((d) => {
  if (getComputedStyle(d).position !== "fixed") return false;
  if (getComputedStyle(d).pointerEvents === "none") return false;
  const r = d.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});

/** Audit every visible fixed layer: the panel (button-richest layer) must fit
 *  the viewport and no control inside the group may be clipped. */
const auditModal = (page) => page.evaluate(() => {
  const iw = window.innerWidth;
  const insideScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const layers = [...document.querySelectorAll('div[class*="fixed"]')].filter((d) => {
    if (getComputedStyle(d).position !== "fixed" || getComputedStyle(d).pointerEvents === "none") return false;
    const r = d.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const backdrops = layers.filter((d) => /inset-0|inset-x-0/.test(String(d.className)));
  if (!layers.length || !backdrops.length) return { open: false };
  const btnCount = (d) => d.querySelectorAll("button").length;
  const panel = layers.reduce((a, b) => (btnCount(b) > btnCount(a) ? b : a), layers[0]);
  const pr = panel.getBoundingClientRect();
  const clipped = [];
  const seen = new Set();
  for (const layer of layers) {
    for (const el of layer.querySelectorAll("button, a[href], input, select, textarea")) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left >= iw || r.right <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") continue;
      if ((r.right > iw + 2 || r.left < -2) && !insideScroller(el)) {
        clipped.push({ what: el.getAttribute("data-testid") || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`, text: (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 18), left: Math.round(r.left), right: Math.round(r.right) });
        if (clipped.length >= 5) break;
      }
    }
  }
  return { open: true, panel: { left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width) }, iw, clipped, docOverflow: document.documentElement.scrollWidth > iw + 1, scrollable: layers.some((l) => l.scrollHeight >= l.clientHeight) };
});

const closeModal = async (page) => {
  // 1) Escape
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(450);
  if (!(await modalOpen(page))) return true;
  // 2) a close/cancel/X button anywhere in the fixed-layer group
  await page.evaluate(() => {
    const layers = [...document.querySelectorAll('div[class*="fixed"]')].filter((d) => getComputedStyle(d).position === "fixed" && getComputedStyle(d).pointerEvents !== "none" && d.getBoundingClientRect().width > 0);
    const btns = layers.flatMap((l) => [...l.querySelectorAll("button")]);
    const x = btns.find((b) => {
      const t = ((b.getAttribute("data-testid") || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
      const label = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return /close|cancel|back|dismiss|done/.test(t) || b.querySelector("svg.lucide-x") || (/^(cancel|close|done|back|dismiss|×|✕)$/.test(label) && !/delete|remove|purge/.test(label));
    });
    if (x) x.click();
  });
  await sleep(450);
  if (!(await modalOpen(page))) return true;
  // 3) click the backdrop itself at a point where the backdrop IS the topmost
  //    element (safe: the click can only land on the backdrop)
  await page.evaluate(() => {
    const layers = [...document.querySelectorAll('div[class*="fixed"]')].filter((d) => getComputedStyle(d).position === "fixed" && getComputedStyle(d).pointerEvents !== "none" && d.getBoundingClientRect().width > 0);
    const backdrop = layers.find((d) => /inset-0|inset-x-0/.test(String(d.className)));
    if (!backdrop) return;
    for (const [x, y] of [[8, 8], [8, innerHeight / 2], [innerWidth / 2, 8]]) {
      const top = document.elementFromPoint(x, y);
      if (top && (top === backdrop || backdrop.contains(top))) { top.click(); return; }
    }
  });
  await sleep(450);
  return !(await modalOpen(page));
};

const modalOpen = (page) => page.evaluate(() => {
  const layers = [...document.querySelectorAll('div[class*="fixed"]')].filter((d) => getComputedStyle(d).position === "fixed" && getComputedStyle(d).pointerEvents !== "none" && d.getBoundingClientRect().width > 0);
  return layers.some((d) => /inset-0|inset-x-0/.test(String(d.className)));
});

const openers = (page) => page.evaluate((re, ex) => {
  const out = [];
  for (const b of document.querySelectorAll("button[data-testid]")) {
    const tid = b.getAttribute("data-testid");
    if (!new RegExp(re).test(tid) || new RegExp(ex).test(tid)) continue;
    if (b.closest('[data-testid="nav-sidebar"], nav')) continue;
    // not inside an already-open modal
    if (b.closest('div[class*="fixed"]')) continue;
    if (b.getBoundingClientRect().width > 0) out.push({ tid });
  }
  return out.slice(0, 8);
}, OPENER_RE.source, EXCLUDE_RE.source);

const navButtons = (page) => page.evaluate(() => {
  const sb = document.querySelector('[data-testid="nav-sidebar"]') || document.body;
  const out = [];
  for (const b of sb.querySelectorAll("button")) {
    const text = (b.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || b.getBoundingClientRect().width === 0 || /sign out|log ?out/i.test(text)) continue;
    out.push({ text: text.slice(0, 40), tid: b.getAttribute("data-testid") || "" });
  }
  return out;
});

const clickNav = (page, item) => page.evaluate((tid, text) => {
  const sb = document.querySelector('[data-testid="nav-sidebar"]') || document.body;
  for (const el of sb.querySelectorAll("button")) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if ((tid && el.getAttribute("data-testid") === tid) || (!tid && t.slice(0, 40) === text)) { el.click(); return true; }
  }
  return false;
}, item.tid, item.text);

async function sweepModals(page, vp, role) {
  const nav = await navButtons(page);
  const surfaces = nav.length ? nav : [{ text: "Worker Dashboard", tid: "" }];
  for (const item of surfaces) {
    if (nav.length) {
      if (!(await clickNav(page, item))) continue;
      await sleep(2200);
    }
    for (const op of await openers(page)) {
      openersTried++;
      const clicked = await page.evaluate((tid) => {
        const el = document.querySelector(`button[data-testid="${tid}"]`);
        if (el) { el.click(); return true; }
        return false;
      }, op.tid);
      if (!clicked) continue;
      await sleep(950);
      const m = await auditModal(page);
      if (!m.open) continue; // inline section, not a modal
      modalsChecked++;
      const where = `${vp}/${role} · ${item.text} · ${op.tid}`;
      if (m.panel.left < -2 || m.panel.right > m.iw + 2) issues.push({ where, kind: "modal panel wider than viewport", detail: `L${m.panel.left} R${m.panel.right} vw${m.iw}` });
      if (m.docOverflow) issues.push({ where, kind: "document overflow with modal open", detail: `scrollW>${m.iw}` });
      for (const c of m.clipped) issues.push({ where, kind: "clipped control in modal", detail: `${c.what}${c.text ? ` "${c.text}"` : ""} L${c.left}/R${c.right}/vw${m.iw}` });
      if (issues.length && issues.slice(-1)[0].where === where) {
        shotN++;
        await page.screenshot({ path: `/home/user/modal-${vp}-${String(shotN).padStart(2, "0")}.png` });
      }
      const closed = await closeModal(page);
      if (!closed) {
        issues.push({ where, kind: "modal would not close", detail: "Escape + close button both failed" });
        await page.reload({ waitUntil: "networkidle0", timeout: 60000 }).catch(() => {});
        await sleep(2500);
        if (!(await page.evaluate(() => !!document.querySelector('[data-testid="login-screen"]')))) {
          // still signed in; re-navigate to this surface
          if (nav.length) { await clickNav(page, item); await sleep(2000); }
        } else {
          await login(page, role === "owner" ? OWNER : AKUA);
          if (nav.length) { await clickNav(page, item); await sleep(2000); }
        }
      }
    }
  }
}

try {
  for (const vp of VIEWPORTS) {
    for (const role of ROLES) {
      console.log(`\n══ MODALS ${vp.toUpperCase()} ${VP[vp].width}px · ${role} ══`);
      const { ctx, page } = await newPage(vp, `${vp}:${role}`);
      await login(page, role === "owner" ? OWNER : AKUA);
      await sweepModals(page, vp, role);
      await ctx.close();
    }
  }
} catch (err) {
  console.error("FATAL", err);
} finally {
  await browser.close();
}

console.log(`\n══ MODAL AUDIT: ${modalsChecked} modals opened & audited (${openersTried} openers tried) ══`);
if (issues.length === 0) console.log("✅ ZERO modal issues: every modal fits, closes, nothing clipped.");
else {
  console.log(`❌ ${issues.length} modal issues:\n`);
  for (const i of issues) console.log(`  • [${i.kind}] ${i.where} — ${i.detail}`);
}
if (pageErrors.length) { console.log(`\nPage errors (${pageErrors.length}):`); pageErrors.slice(0, 8).forEach((e) => console.log(" •", e)); }
else console.log("\nPage errors: none");

import { writeFileSync } from "node:fs";
writeFileSync("/home/user/modal-audit-report.json", JSON.stringify({ modalsChecked, openersTried, issues, pageErrors }, null, 2));
process.exit(issues.length || pageErrors.length ? 1 : 0);
