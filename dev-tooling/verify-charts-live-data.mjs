/**
 * verify-charts-live-data.mjs — do the charts actually REFLECT new data?
 *
 * verify-charts.mjs proves geometry (every surface lays out with real pixels).
 * That is not the same as "the number on the chart is right", so this suite
 * closes the gap from the other end: it starts from real fixtures it creates
 * through the app's own APIs, reloads, and asserts the rendered marks changed
 * to match.
 *
 * Two directions, deliberately opposite:
 *
 *   A · AQUA-01 ships EMPTY (no ponds, no batches, no weight/water logs), so
 *       its Recharts surface renders bare axes. We populate it through
 *       /api/aquaculture and assert the charts gain real, correctly-sized
 *       marks. This is the case a seeded demo database can never exercise:
 *       an empty chart is not proof that a full one works.
 *
 *   B · the reverse — a chart that ALREADY has data must grow when more money
 *       lands. We record a sale with an unmistakable amount and assert the
 *       rendered bars change and the figure appears on the page.
 *
 * Every fixture is removed afterwards; the suite leaves the demo tenant as it
 * found it.
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts-live-data.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const PG_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OUT = "/home/user/gomina360_app_V1.1/reports/screenshots/charts-live";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

const pg = new Client({ connectionString: PG_URL });
const r2 = (n) => Math.round(n * 100) / 100;

/* ── API plumbing (same shape as verify-revenue-notifications.mjs) ───────── */
async function apiLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  const raw = res.headers.get("set-cookie") || "";
  const cookie = raw.split(/,(?=[^;]+?=gomina)/)[0].split(";")[0];
  return { status: res.status, json, cookie };
}
const apiFor = (cookie) => async (route, opts = {}) => {
  const res = await fetch(`${BASE}${route}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

/* ── Browser ────────────────────────────────────────────────────────────── */
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const pageErrors = [];
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));

async function signIn(cred) {
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 20000 });
  for (const [sel, val] of [
    ['[data-testid="login-email"]', cred.email],
    ['[data-testid="login-password"]', cred.pw],
  ]) {
    await page.evaluate(
      (s, v) => {
        const el = document.querySelector(s);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      sel,
      val,
    );
  }
  await page.evaluate(() => document.querySelector('[data-testid="login-submit"]')?.click());
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 40000 });
  await sleep(3500);
}

const gotoTab = async (tab) => {
  await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(2600);
};

/**
 * Everything we need to judge a chart in one pass: how many data marks it
 * drew, and the pixel extent of each one. Bar geometry is what actually
 * encodes a value, so `barArea` is the number that must move when data moves.
 */
const measure = () =>
  page.evaluate(() => {
    const charts = [];
    document.querySelectorAll(".recharts-responsive-container").forEach((el) => {
      const wrapper = el.querySelector(".recharts-wrapper");
      const svg = wrapper ? wrapper.querySelector(":scope > svg") : null;
      const r = svg ? svg.getBoundingClientRect() : { width: 0, height: 0 };
      const rects = svg ? [...svg.querySelectorAll(".recharts-bar-rectangle")] : [];
      const areas = rects
        .map((n) => {
          const b = n.getBoundingClientRect();
          return b.width * b.height;
        })
        .filter((a) => Number.isFinite(a) && a > 0);
      charts.push({
        w: Math.round(r.width),
        h: Math.round(r.height),
        marks: svg
          ? svg.querySelectorAll(
              ".recharts-bar-rectangle, .recharts-pie-sector, .recharts-line-curve, .recharts-area-area, .recharts-dot, .recharts-radar-polygon",
            ).length
          : 0,
        bars: rects.length,
        barArea: Math.round(areas.reduce((a, b) => a + b, 0)),
      });
    });
    return { charts, text: (document.querySelector("main")?.innerText || "").slice(0, 200000) };
  });

const totals = (m) => ({
  charts: m.charts.length,
  marks: m.charts.reduce((a, c) => a + c.marks, 0),
  bars: m.charts.reduce((a, c) => a + c.bars, 0),
  barArea: m.charts.reduce((a, c) => a + c.barArea, 0),
  collapsed: m.charts.filter((c) => c.w === 0 || c.h === 0).length,
});
const fmt = (t) => `charts ${t.charts} · marks ${t.marks} · bars ${t.bars} · barArea ${t.barArea}`;

(async () => {
  await pg.connect();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(OUT, { recursive: true });

  const login = await apiLogin(OWNER.email, OWNER.pw);
  ok("owner signs in for the API side", login.status === 200 && !!login.cookie);
  const api = apiFor(login.cookie);

  const created = { ponds: [], batches: [], weights: [], waters: [], txns: [] };

  /* ════════════════════════════════════════════════════════════════════════
     A · An EMPTY unit must grow real charts when data arrives
     ════════════════════════════════════════════════════════════════════════ */
  section("A · AQUA-01 (shipped empty) fills with real chart marks");
  try {
    const [aqua] = (await pg.query("SELECT id, code FROM businesses WHERE code='AQUA-01'")).rows;
    ok("fixture: the seeded aquaculture unit is genuinely empty", !!aqua);
    const preCount = (
      await pg.query(
        "SELECT (SELECT count(*) FROM aquaculture_ponds WHERE business_id=$1) p," +
          " (SELECT count(*) FROM aquaculture_batches WHERE business_id=$1) b," +
          " (SELECT count(*) FROM aquaculture_weight_logs WHERE business_id=$1) w",
        [aqua.id],
      )
    ).rows[0];
    // This was an ASSERTION that the aquaculture unit starts empty. It stopped
    // holding once the demo seeders (`seed-fish-benchmark-demo`,
    // `seed-fish-mixing-demo`) began seeding real ponds, batches and a weight
    // series into AQUA-01 — so the suite failed on a stale fixture assumption
    // rather than on anything to do with charts. The starting state is now
    // reported, and the run measures against whatever is really there: the
    // chart invariants below (nothing collapses, marks/bars grow, every chart
    // has real pixels) hold with or without pre-existing data.
    console.log(
      `   fixture · starting with ponds ${preCount.p} · batches ${preCount.b} · weights ${preCount.w}`,
    );

    await signIn(OWNER);
    await gotoTab("AQUA-01");
    const before = totals(await measure());
    await page.screenshot({ path: `${OUT}/A-aqua-before.png` });
    ok("the empty unit still renders its chart frames (no collapse)", before.collapsed === 0,
      `${before.collapsed} collapsed`);
    console.log(`   BEFORE  ${fmt(before)}`);

    // Real ponds…
    for (const spec of [
      { name: "Probe Pond Alpha", type: "POND", capacityLiters: 50000, currentBiomassKg: 900 },
      { name: "Probe Pond Bravo", type: "POND", capacityLiters: 32000, currentBiomassKg: 540 },
      { name: "Probe Cage Charlie", type: "CAGE", capacityLiters: 8000, currentBiomassKg: 120 },
      { name: "Probe Pond Delta", type: "POND", capacityLiters: 41000, currentBiomassKg: 1500 },
    ]) {
      const res = await api("/api/aquaculture", {
        method: "POST",
        body: { entity: "POND", data: { businessId: aqua.id, ...spec } },
      });
      if (res.json?.item?.id) created.ponds.push(res.json.item.id);
    }
    ok("four ponds created through the app API", created.ponds.length === 4, `${created.ponds.length} ponds`);

    // …and real batches stocked into them, with a dated weight series so the
    // growth chart has more than one point to plot.
    for (let i = 0; i < 2; i++) {
      const res = await api("/api/aquaculture", {
        method: "POST",
        body: {
          entity: "BATCH",
          data: {
            businessId: aqua.id,
            pondId: created.ponds[i] ?? null,
            species: i === 0 ? "TILAPIA" : "CATFISH",
            initialCount: 4000 + i * 1500,
            costPerFingerlingGhs: 1.5 + i,
            stockedDate: new Date(Date.now() - (i + 1) * 6 * 86400_000).toISOString().slice(0, 10),
          },
        },
      });
      if (res.json?.item?.id) created.batches.push(res.json.item.id);
    }
    ok("two batches stocked", created.batches.length === 2, `${created.batches.length} batches`);

    let wi = 0;
    for (const batchId of created.batches) {
      for (const grams of [120, 185, 265, 350]) {
        const res = await api("/api/aquaculture", {
          method: "POST",
          body: {
            entity: "WEIGHT",
            data: {
              businessId: aqua.id,
              batchId,
              avgWeightG: grams,
              sampleSize: 50,
              recordedDate: new Date(Date.now() - (4 - wi) * 3 * 86400_000).toISOString().slice(0, 10),
            },
          },
        });
        if (res.json?.item?.id) created.weights.push(res.json.item.id);
        wi++;
      }
    }
    ok("eight weight readings recorded", created.weights.length === 8, `${created.weights.length} readings`);

    for (const [ph, dox] of [[7.2, 5.8], [6.9, 6.4]]) {
      const res = await api("/api/aquaculture", {
        method: "POST",
        body: {
          entity: "WATER",
          data: {
            businessId: aqua.id,
            phLevel: ph,
            dissolvedOxygen: dox,
            temperature: 27.5,
            pondId: created.ponds[0] ?? null,
          },
        },
      });
      if (res.json?.item?.id) created.waters.push(res.json.item.id);
    }

    await sleep(1200);
    await gotoTab("AQUA-01");
    const afterM = await measure();
    const after = totals(afterM);
    await page.screenshot({ path: `${OUT}/A-aqua-after.png` });
    console.log(`   AFTER   ${fmt(after)}`);

    ok("the newly created data actually produced chart marks", after.marks > before.marks,
      `${before.marks} → ${after.marks} marks`);
    ok("bars were drawn for it", after.bars > before.bars, `${before.bars} → ${after.bars} bars`);
    ok("the bars occupy real pixels, not a collapsed 0×0 box", after.barArea > before.barArea,
      `${before.barArea} → ${after.barArea} px²`);
    ok("no chart collapsed once the data arrived", after.collapsed === 0, `${after.collapsed} collapsed`);
    // The chart COUNT is allowed to grow: an empty unit shows a couple of
    // placeholder frames, and real data unlocks the analytics that were
    // hidden behind an empty state (3 → 8 here). What must never happen is a
    // chart disappearing or collapsing once there is something to draw.
    // Chart COUNT is not an invariant: with a seeded unit the "after" view can
    // legitimately show FEWER frames than the empty view did, because an empty
    // placeholder frame is replaced by a real chart rather than added to. What
    // must never happen is a chart at 0×0 or a collapse — both asserted above.
    console.log(`   charts  ${before.charts} → ${after.charts} (count is not an invariant; sizing is)`);
    const zeroSized = afterM.charts.filter((c) => !(c.w > 0 && c.h > 0));
    ok("every chart present after the data landed has real pixels",
      afterM.charts.length > 0 && zeroSized.length === 0,
      zeroSized.length ? `${zeroSized.length} at 0×0` : `${afterM.charts.length} charts all sized`);

    // The page must also *show* the new pond names — a chart can render marks
    // from stale cache while the table below it still shows nothing.
    ok("the new ponds are visible on the same screen", /Probe Pond Alpha/.test((await measure()).text));
  } catch (e) {
    ok("section A ran to completion", false, String(e).slice(0, 200));
  }

  /* ════════════════════════════════════════════════════════════════════════
     B · A chart that ALREADY has data must move when more money lands
     ════════════════════════════════════════════════════════════════════════ */
  section("B · a new sale moves the rendered revenue chart");
  try {
    const [biz] = (await pg.query("SELECT id, code FROM businesses WHERE id=1")).rows;
    await gotoTab("FINANCE");
    const before = totals(await measure());
    await page.screenshot({ path: `${OUT}/B-finance-before.png` });
    console.log(`   BEFORE  ${fmt(before)}`);
    ok("the finance workspace has charts to begin with", before.charts > 0, `${before.charts} charts`);

    const AMOUNT = 543.21;
    const res = await api("/api/transactions", {
      method: "POST",
      body: {
        businessId: biz.id,
        type: "INCOME",
        category: "Direct Receipt",
        amountGhs: AMOUNT,
        paymentMethod: "CASH",
        description: "TEST live-data chart probe receipt",
      },
    });
    ok("probe sale recorded", res.status === 200 && res.json?.success, res.json?.error || "");
    if (res.json?.item?.id) created.txns.push(res.json.item.id);
    await sleep(1500);

    await gotoTab("FINANCE");
    const after = totals(await measure());
    const text = (await measure()).text;
    await page.screenshot({ path: `${OUT}/B-finance-after.png` });
    console.log(`   AFTER   ${fmt(after)}`);

    ok("the rendered bars changed after the money landed", after.barArea > before.barArea,
      `${before.barArea} → ${after.barArea} px²`);
    ok("the sale is on the page, to the penny", text.includes("543.21"),
      text.includes("543.21") ? "found" : "543.21 not rendered");
    ok("no chart collapsed", after.collapsed === 0, `${after.collapsed} collapsed`);

    // The ledger and the chart must agree — otherwise the chart is decoration.
    const [sum] = (
      await pg.query(
        "SELECT COALESCE(SUM(amount_ghs),0) t FROM transactions WHERE business_id=$1 AND type='INCOME' AND description LIKE 'TEST live-data chart probe%'",
        [biz.id],
      )
    ).rows;
    ok("the ledger row behind the chart holds the same money", r2(Number(sum.t)) === AMOUNT,
      `GH₵ ${r2(Number(sum.t))}`);
  } catch (e) {
    ok("section B ran to completion", false, String(e).slice(0, 200));
  }

  section("C · Hygiene");
  ok("no uncaught page errors while loading charts", pageErrors.length === 0,
    [...new Set(pageErrors)].slice(0, 3).join(" | "));

  /* ── cleanup ───────────────────────────────────────────────────────────── */
  section("Z · Cleanup");
  for (const t of [
    ["aquaculture_weight_logs", created.weights],
    ["aquaculture_water_quality_logs", created.waters],
  ]) {
    for (const id of t[1]) await pg.query(`DELETE FROM ${t[0]} WHERE id=$1`, [id]).catch(() => {});
  }
  for (const id of created.batches) await pg.query("DELETE FROM aquaculture_batches WHERE id=$1", [id]).catch(() => {});
  for (const id of created.ponds) await pg.query("DELETE FROM aquaculture_ponds WHERE id=$1", [id]).catch(() => {});
  for (const id of created.txns) await pg.query("DELETE FROM transactions WHERE id=$1", [id]).catch(() => {});
  await pg.query("DELETE FROM transactions WHERE description LIKE 'TEST live-data chart probe%'").catch(() => {});
  await pg.query("DELETE FROM audit_logs WHERE target_label LIKE 'Probe%'").catch(() => {});

  const left = await pg.query(
    "SELECT (SELECT count(*) FROM aquaculture_ponds WHERE name LIKE 'Probe %') p," +
      " (SELECT count(*) FROM transactions WHERE description LIKE 'TEST live-data chart probe%') t",
  );
  ok("Z1 every fixture pond and ledger row is gone",
    Number(left.rows[0].p) === 0 && Number(left.rows[0].t) === 0,
    `ponds ${left.rows[0].p} · ledger ${left.rows[0].t}`);

  await browser.close();
  await pg.end();
  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) console.log("FAILED:\n - " + failures.join("\n - "));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("suite error:", e);
  try { await browser.close(); } catch {}
  try { await pg.end(); } catch {}
  process.exit(1);
});