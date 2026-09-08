// Post-deploy smoke shot: logs into the live production deployment, captures
// the owner Command Center, asserts zero page errors, and cleans up the
// login session so session counts stay at baseline.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/shot-production-live.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const { Client } = req("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await pg.connect();
const sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM user_sessions`)).rows[0].m;

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::|401|400|403|404|409/.test(m.text())) errs.push(m.text()); });

await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
if (await page.$('[data-testid="login-email"]')) {
  await page.type('[data-testid="login-email"]', "kwame.owner@gomina360.com");
  await page.type('[data-testid="login-password"]', process.env.GOMINA_OWNER_PW || "Owner@GoMina26");
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3500));
}
await page.screenshot({ path: "/home/user/production-live.png" });
await browser.close();
await pg.query(`DELETE FROM user_sessions WHERE id > ${sessMax}`);
await pg.end();

if (errs.length) { console.log(`PAGE ERRORS: ${errs.join(" | ").slice(0, 300)}`); process.exit(1); }
console.log("production-live.png captured · ZERO page errors");
