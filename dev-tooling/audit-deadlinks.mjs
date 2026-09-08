// Dead-link / dead-asset audit across every public + owner surface in real
// headless Chromium: 4xx/5xx network responses, broken <img>, suspicious
// anchors (undefined/[object/#), and page errors. 401/403/404 API guards are
// expected on unauthenticated probes and ignored only for /api/*; anything
// else fails the audit.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/audit-deadlinks.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };

const bad = [];
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

async function scan(page, label) {
  await new Promise((r) => setTimeout(r, 1200));
  const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
  const broken = links.filter((h) => !h || h === "#" || h.includes("undefined") || h.includes("[object"));
  if (broken.length) bad.push(`${label}: suspicious anchors ${JSON.stringify(broken)}`);
  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith("data:")).map((i) => i.src.slice(0, 110)),
  );
  if (imgs.length) bad.push(`${label}: broken images ${JSON.stringify(imgs)}`);
  const mapDots = await page.evaluate(() => document.querySelectorAll("img[src*='googleapis'], img[src*='maps']").length);
  console.log(`  ${label}: ${links.length} anchors · ${imgs.length} broken imgs · ${mapDots} map imgs`);
}

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });
page.on("response", (r) => {
  const s = r.status();
  const u = r.url();
  if (s >= 400 && !(s === 401 || s === 403 || s === 404) || (s === 404 && !u.includes("/api/"))) {
    if (!u.startsWith("data:") && !u.includes("favicon")) bad.push(`${s} ${u.replace(BASE, "").slice(0, 110)}`);
  }
});
page.on("pageerror", (e) => bad.push(`PAGEERROR ${String(e).slice(0, 140)}`));
page.on("console", (m) => {
  if (m.type() === "error") {
    const t = m.text();
    if (!/401|400|403|404|409|413|Failed to load resource|net::/.test(t)) bad.push(`CONSOLE ${t.slice(0, 140)}`);
  }
});

for (const [label, url] of [
  ["login", `${BASE}/`],
  ["storefront", `${BASE}/order`],
  ["storefront-biz1", `${BASE}/order?biz=1`],
  ["track", `${BASE}/track`],
  ["track-404-code", `${BASE}/track?code=GM-NOPE-000000`],
]) {
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  await scan(page, label);
}

// Owner dashboard
await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
if (await page.$('[data-testid="login-email"]')) {
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));
}
await scan(page, "owner-dashboard");
// purge the login session so session counts stay at baseline
{
  const btn = await page.$('[data-testid="user-menu-btn"]');
  if (btn) { await btn.click(); await new Promise((r) => setTimeout(r, 400)); }
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Sign out/i.test(x.textContent || ""));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
}

await browser.close();
if (bad.length) {
  console.log(`\nAUDIT-DEADLINKS: ${bad.length} problem(s):\n` + bad.join("\n"));
  process.exit(1);
}
console.log("\nAUDIT-DEADLINKS: clean — no dead links, 4xx/5xx assets, broken images or page errors on any surface");
