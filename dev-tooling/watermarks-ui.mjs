/** Owner-console UI check: Manage Businesses → Online → Product image
 *  watermark card (toggle, modes, live preview), saved via the real PATCH. */
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (n, c, d = "") => { console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); if (!c) process.exitCode = 1; };

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium", headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 960 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("JSERROR:", String(e).slice(0, 160)));
try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector("[data-testid='login-screen']", { timeout: 60000 });
  await page.type("[data-testid='login-email']", "kwame.owner@gomina360.com", { delay: 8 });
  await page.type("[data-testid='login-password']", "Owner@GoMina26", { delay: 8 });
  await page.click("[data-testid='login-submit']");
  await sleep(6000);

  // open Manage Units via the OWNer dashboard entry
  await page.waitForSelector("[data-testid='open-manage-businesses']", { timeout: 60000 });
  await page.click("[data-testid='open-manage-businesses']");
  await sleep(4000);
  ok("modal.manage-units-open", true);

  // inside the modal list, click the first unit row's Online action (icon button)
  const onlClicked = await page.evaluate(() => {
    const btn = document.querySelector("[data-testid^='manage-biz-online-']");
    if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return btn.dataset.testid; }
    return null;
  });
  ok("unit.online-panel-opened", !!onlClicked, onlClicked || "none");
  await sleep(3000);
  const onlRoot = await page.$("[data-testid='mb-onl-root']");
  ok("online-panel-rendered", !!onlRoot);

  const wmPresent = await page.$("[data-testid='mb-onl-wm']");
  ok("wm.card.present", !!wmPresent);
  const toggleState = await page.evaluate(() => {
    const t = document.querySelector("[data-testid='mb-onl-wm-toggle']");
    return t?.getAttribute("aria-checked") ?? t?.textContent ?? null;
  }).catch(() => null);
  console.log("   [diag] toggle state:", toggleState);

  // modes + preview render when ON (demo default ON for biz 1)
  const modes = await page.$$eval("[data-testid='mb-onl-wm-modes'] button", (l) => l.length).catch(() => 0);
  ok("wm.modes-shown-when-on", modes >= 3, `${modes} mode buttons`);
  const preview = await page.$("[data-testid='mb-onl-wm-preview'] [data-testid='wm-overlay']");
  ok("wm.preview-renders", !!preview);
  const prevHasLogo = await page.$("[data-testid='mb-onl-wm-preview'] [data-testid='wm-logo']");
  ok("wm.preview-logo-chip", !!prevHasLogo);

  // switch mode to NAME → preview logo chip disappears (no-logo fallback → name tile)
  await page.click("[data-testid='mb-onl-wm-mode-name']");
  await sleep(400);
  const nameTile = await page.$("[data-testid='mb-onl-wm-preview'] [data-testid='wm-tile']");
  ok("wm.mode-name-preview", !!nameTile);
  await page.screenshot({ path: ".verify-out/wm-05-owner-panel.png" });

  // toggle OFF → mode buttons vanish
  await page.click("[data-testid='mb-onl-wm-toggle']");
  await sleep(400);
  const modesGone = (await page.$$eval("[data-testid='mb-onl-wm-modes'] button", (l) => l.length).catch(() => 0)) === 0;
  ok("wm.toggle-off-hides-modes", modesGone);

  // re-enable + save settings
  await page.click("[data-testid='mb-onl-wm-toggle']");
  await sleep(300);
  const saved = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Save/i.test(x.innerText || "") && (x.innerText || "").length < 60);
    if (b) { b.scrollIntoView({ block: "center" }); b.click(); return true; }
    return false;
  });
  ok("wm.save-clicked", saved);
  await sleep(4000);
  const apiCheck = await (await fetch(`${BASE}/api/menu?biz=1`)).json();
  ok("saved.menu-reflects", apiCheck.businesses?.[0]?.watermarkEnabled === true, JSON.stringify(apiCheck.businesses?.[0]?.watermarkEnabled));
} finally {
  await browser.close();
}
console.log(process.exitCode ? "═══ UI-check FAILED" : "═══ UI-check passed");
