/**
 * verify-variant-ui.mjs — the Inventory & Stock → Add Stock Item experience in
 * a REAL browser (V2), proving the business-facing flow end to end:
 *
 *   UI-A · the options step is OFF by default: a plain product is registered
 *          with the single quantity field (no extra required fields).
 *   UI-B · with options on, a size × colour matrix is entered in one pass and
 *          the saved product carries rows, a derived total and a storefront
 *          projection the Order Page can render.
 *   UI-C · the product row shows the option badge and the record view offers
 *          "Manage options & stock" (the single quantity field is gone).
 *   UI-D · restocking one combination in the record view updates only that row
 *          (total re-derived, movement trail logged).
 *   UI-E · a plain product can later be given options ("This product also comes
 *          in sizes/colours") and the storefront picks the combinations up.
 *   UI-F · the customer Order Page disables an out-of-stock combination for a
 *          product created through this form.
 *
 * Tagged TEST-VARUI- and purged in the finally block.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const { Client } = req("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const EXE = process.env.CHROME_PATH || "/tmp/al2023/chromium";
const OUT = "/tmp/variant-ui/";
const TAG = "TEST-VARUI";
const stamp = Date.now().toString().slice(-6);
const BIZ = 8; // hardware unit

let passed = 0, failed = 0;
const ok = (a, b, extra = "") => {
  // Accepts both ok("name", cond) and ok(cond, "name").
  const name = typeof a === "string" ? a : String(b);
  const cond = typeof a === "string" ? b : a;
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t}`);

const client = new Client({ connectionString: DB });
const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const q1 = async (sql, params = []) => (await q(sql, params))[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, timeout = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch { /* keep polling */ }
    await sleep(step);
  }
  return false;
}
const tid = (id) => `[data-testid="${id}"]`;

async function typeInto(page, sel, value) {
  const el = await page.$(sel);
  if (!el) throw new Error(`missing ${sel}`);
  await el.click({ clickCount: 3 });
  await el.type(String(value));
}
const clickTestid = async (page, id, timeout = 6000) => {
  // React re-renders can swap nodes between the lookup and the click, so retry.
  const last = Date.now() + timeout;
  for (;;) {
    const el = await page.$(tid(id));
    if (el) {
      try {
        await el.evaluate((b) => b.click());
        return;
      } catch {
        /* detached node — fall through and retry */
      }
    }
    if (Date.now() > last) throw new Error(`missing testid ${id}`);
    await sleep(150);
  }
};
const textOf = async (page, id) => (await page.$(tid(id)))?.evaluate((el) => el.textContent || "") ?? "";

const setInput = async (page, id, value) => {
  await page.$eval(tid(id), (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
};
const submitAndConfirm = async (page) => {
  await clickTestid(page, "shared-add-submit");
  // Inventory registration passes through the shared confirmation gate.
  if (await waitFor(page, async () => (await page.$('[data-testid="shared-confirm-entry-confirm"]')) !== null, 3000)) {
    await clickTestid(page, "shared-confirm-entry-confirm");
  } else {
    await clickTestid(page, "shared-confirm-entry-confirm").catch(() => {});
  }
};

async function purge() {
  try {
    const ids = (await q(`select id from inventory_items where name like '${TAG}%'`)).map((r) => Number(r.id));
    if (!ids.length) return;
    const list = ids.join(",");
    await q(`delete from stock_movements where inventory_id in (${list})`);
    await q(`delete from inventory_variants where inventory_id in (${list})`);
    await q(`delete from inventory_items where id in (${list})`);
    console.log(`\n🧹 purged ${ids.length} test item(s)`);
  } catch (e) { console.error("purge failed:", e.message); }
}

let browser, page;
try {
  await client.connect();
  browser = await puppeteer.launch({
    executablePath: EXE, headless: "shell",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1000"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  // Sign in
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  await page.type(tid("login-email"), OWNER.email);
  await page.type(tid("login-password"), OWNER.pw);
  await page.click(tid("login-submit"));
  ok("owner signs in", await waitFor(page, async () => (await page.$(tid("nav-sidebar"))) !== null, 45000));

  // Open Inventory & Stock
  const opened = await waitFor(page, async () =>
    page.evaluate(() => {
      const sb = document.querySelector('[data-testid="nav-sidebar"]') || document;
      const el = [...sb.querySelectorAll("button, a")].find((b) => /Inventory & Stock/i.test(b.textContent || ""));
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    }),
  );
  ok("Inventory & Stock opens from the sidebar", opened);
  ok("register is ready", await waitFor(page, async () => (await page.$(tid("shared-add-open"))) !== null, 30000));

  // ── UI-A · plain product, options OFF by default ──────────────────────
  section("UI-A · plain product (options OFF → no extra fields)");
  const firstOpen = await waitFor(page, async () => {
    if ((await page.$(tid("inv-options-toggle"))) !== null) return true;
    const btn = await page.$(tid("shared-add-open"));
    if (btn) await btn.evaluate((b) => b.click());
    return false;
  }, 25000);
  ok("Add Stock Item form opens with the options step", firstOpen);
  const toggleText = (await textOf(page, "inv-options-toggle")).trim();
  ok(/^NO$/i.test(toggleText), "options default to NO", toggleText);
  ok((await page.$(tid("inv-variant-editor"))) === null, "no option fields are shown by default");

  const plainName = `${TAG} Plain Hammer ${stamp}`;
  await typeInto(page, tid("inv-name"), plainName);
  await page.select(tid("inv-business-select"), String(BIZ)).catch(() => {});
  await waitFor(page, async () => ((await page.$eval(tid("inv-branch-input"), (el) => el.value)) || "").length > 0, 8000);
  await setInput(page, "inv-qty", 12);
  await submitAndConfirm(page);
  const plainSaved = await waitFor(page, async () => {
    const row = await q1(`select id, tracks_variants from inventory_items where name = $1`, [plainName]);
    return !!row;
  }, 20000);
  ok("plain product saved", plainSaved);
  if (!plainSaved) {
    const state = await page.evaluate(() => ({
      modalOpen: !!document.querySelector('[data-testid="shared-add-submit"]'),
      errors: [...document.querySelectorAll('[class*="rose"]')].map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 3),
      nameValue: document.querySelector('[data-testid="inv-name"]')?.value || null,
      qtyValue: document.querySelector('[data-testid="inv-qty"]')?.value || null,
      branchValue: document.querySelector('[data-testid="inv-branch-input"]')?.value || null,
    }));
    console.error("   ↳ save state:", JSON.stringify(state).slice(0, 500));
    await page.screenshot({ path: `${OUT}plain-save-failed.png` });
  }
  const plainRow = await q1(`select id, quantity, tracks_variants from inventory_items where name = $1`, [plainName]);
  ok(Number(plainRow.quantity) === 12, "plain quantity stored", String(plainRow.quantity));
  ok(plainRow.tracks_variants !== true, "plain product is not variant-tracked");
  const plainVariants = await q1(`select count(*)::int n from inventory_variants where inventory_id = $1`, [plainRow.id]);
  ok(Number(plainVariants.n) === 0, "no variant rows created for a plain product");

  // ── UI-B · variant product registered with a matrix ───────────────────
  section("UI-B · one-pass size × colour entry with per-combination stock");
  await waitFor(page, async () => (await page.$(tid("shared-add-open"))) !== null, 10000);
  const openedForm = await waitFor(page, async () => {
    if ((await page.$(tid("inv-name"))) !== null) return true;
    const btn = await page.$(tid("shared-add-open"));
    if (btn) await btn.evaluate((b) => b.click());
    return false;
  }, 20000);
  ok("Add Stock Item opens for the variant case", openedForm);
  await waitFor(page, async () => (await page.$(tid("inv-options-toggle"))) !== null, 15000);
  const vName = `${TAG} Coverall ${stamp}`;
  await typeInto(page, tid("inv-name"), vName);
  await page.select(tid("inv-business-select"), String(BIZ)).catch(() => {});
  await waitFor(page, async () => ((await page.$eval(tid("inv-branch-input"), (el) => el.value)) || "").length > 0, 8000);
  await clickTestid(page, "inv-options-toggle");
  ok("options editor appears when switched on", await waitFor(page, async () => (await page.$(tid("inv-variant-editor"))) !== null, 10000));
  ok(
    "axis 1 is pre-labelled for the business type",
    await waitFor(page, async () => (await page.$eval(tid("inv-axis1-label"), (el) => el.value)).length > 0, 5000),
  );

  // Axis 1 values: S, M via chips (choose the FREE/LETTER system first so the chips exist)
  await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="inv-size-system"]');
    if (sel) { sel.value = "LETTER"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await sleep(300);
  const chipCandidates = ["S", "M", "L"];
  for (const c of chipCandidates) {
    const sel = tid(`inv-a1-chip-${c}`);
    if (await page.$(sel)) await clickTestid(page, `inv-a1-chip-${c}`);
    else {
      await page.$eval(tid("inv-a1-custom"), (el, v) => {
        el.value = v;
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }, c);
      await sleep(150);
    }
  }
  const colours = ["Black", "White"];
  for (const c of colours) {
    const sel = tid(`inv-a2-chip-${c}`);
    if (await page.$(sel)) await clickTestid(page, `inv-a2-chip-${c}`);
    else {
      await page.$eval(tid("inv-a2-custom"), (el, v) => {
        el.value = v;
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }, c);
      await sleep(150);
    }
  }
  const matrixRows = await page.$$(`${tid("inv-matrix")} tbody tr`);
  ok(matrixRows.length === 6, "matrix generates one row per combination (3 × 2)", `got ${matrixRows.length}`);

  // Rows are generated size-major: S/Black, S/White, M/Black, M/White, L/Black, L/White
  const plan = [10, 6, 15, 12, 8, 0];
  for (let i = 0; i < plan.length; i++) {
    await page.$eval(tid(`inv-matrix-qty-${i}`), (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, plan[i]);
  }
  await sleep(400);
  const total = (await textOf(page, "inv-total")).replace(/\D+/g, "");
  ok(total === "51", "live total shows the sum of the combinations (51)", total);
  const qtyField = await page.$eval(tid("inv-qty"), (el) => el.value);
  ok(qtyField === "51", "the plain quantity field mirrors the matrix total", qtyField);

  await submitAndConfirm(page);
  const variantSaved = await waitFor(page, async () => {
    const row = await q1(`select id from inventory_items where name = $1`, [vName]);
    if (!row) return false;
    const n = await q1(`select count(*)::int n from inventory_variants where inventory_id = $1`, [row.id]);
    return Number(n.n) === 6;
  }, 25000);
  ok("product saved with all 6 combinations", variantSaved);
  const vItem = await q1(`select id, quantity, tracks_variants, option_axis1_label, option_axis2_label from inventory_items where name = $1`, [vName]);
  const vRows = await q(
    `select size, color, quantity, min_stock_threshold, is_active from inventory_variants where inventory_id = $1 order by size, color`,
    [vItem.id],
  );
  ok(Number(vItem.quantity) === 51, "item total is the derived sum (51)", String(vItem.quantity));
  ok(vItem.tracks_variants === true, "item is variant-tracked");
  ok(String(vItem.option_axis1_label).toLowerCase().includes("size"), "axis label stored", String(vItem.option_axis1_label));
  ok(vRows.length === 6 && vRows.every((r) => r.is_active !== false), "6 active rows");
  const bs = vRows.find((r) => r.size === "S" && r.color === "Black");
  const wm = vRows.find((r) => r.size === "M" && r.color === "White");
  ok(Number(bs?.quantity) === 10 && Number(wm?.quantity) === 12, "entered quantities land on the right combinations", `${bs?.quantity}/${wm?.quantity}`);

  // Storefront projection
  const menuRes = await fetch(`${BASE}/api/menu`);
  const menu = await menuRes.json();
  let projection = null;
  for (const b of menu.businesses || []) {
    const p = (b.products || []).find((x) => Number(x.id) === Number(vItem.id));
    if (p) projection = p;
  }
  ok(!!projection?.hasVariants, "storefront lists the product as a variant product");
  ok(Number(projection?.variantOptions?.totalAvailable) === 51, "storefront total matches the register", String(projection?.variantOptions?.totalAvailable));
  ok(Array.isArray(projection?.variantOptions?.sizes) && projection.variantOptions.sizes.length === 3, "storefront exposes the 3 sizes");

  // ── UI-C · the row badge + record view ────────────────────────────────
  section("UI-C · register shows the option badge; record view manages combinations");
  ok("variant badge on the inventory row", await waitFor(page, async () => (await page.$(tid(`inv-variant-badge-${vItem.id}`))) !== null, 20000));
  const badge = await textOf(page, `inv-variant-badge-${vItem.id}`);
  ok(/size/i.test(badge), "badge names the axes", badge);
  await clickTestid(page, `inv-edit-${vItem.id}`);
  ok("record view offers Manage options & stock", await waitFor(page, async () => (await page.$(tid("edit-manage-variants"))) !== null, 15000));
  ok((await page.$(tid("edit-inventory-qty"))) === null, "the single quantity field is gone for a variant product");

  // ── UI-D · restock one combination from the record view ──────────────
  section("UI-D · restocking one combination updates only that row");
  await clickTestid(page, "edit-manage-variants");
  ok("options manager loads the live matrix", await waitFor(page, async () => (await page.$(tid("inv-manage-matrix"))) !== null, 20000));
  const manageRows = await page.$$(`${tid("inv-manage-matrix")} tbody tr`);
  ok(manageRows.length === 6, "manager shows all 6 combinations", `got ${manageRows.length}`);
  // Row order is size-major (S×Black, S×White, M×Black, …) — restock the FIRST row by +5.
  const beforeFirst = Number(vRows.find((r) => r.size === "S" && r.color === "Black")?.quantity);
  await page.$eval(tid("inv-manage-matrix-qty-0"), (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, beforeFirst + 5);
  await sleep(300);
  await clickTestid(page, "inv-variant-editor-save");
  const restocked = await waitFor(page, async () => {
    const r = await q1(
      `select quantity from inventory_variants where inventory_id = $1 and size = 'S' and color = 'Black'`,
      [vItem.id],
    );
    return Number(r?.quantity) === beforeFirst + 5;
  }, 20000);
  ok("the edited combination gained the units", restocked);
  // The aggregate is re-derived inside the same request; poll so we never read
  // it before syncItemAggregate commits.
  const aggOk = await waitFor(page, async () => {
    const r = await q1(`select quantity from inventory_items where id = $1`, [vItem.id]);
    return Number(r?.quantity) === 56;
  }, 15000);
  const afterAgg = await q1(`select quantity from inventory_items where id = $1`, [vItem.id]);
  ok("item total re-derived (56)", aggOk, String(afterAgg?.quantity));
  const others = await q1(
    `select sum(quantity)::int s from inventory_variants where inventory_id = $1 and not (size = 'S' and color = 'Black')`,
    [vItem.id],
  );
  ok(Number(others.s) === 41, "every other combination is untouched (41)", String(others.s));
  const mv = await q1(
    `select delta, variant_id, reason from stock_movements where inventory_id = $1 order by id desc limit 1`,
    [vItem.id],
  );
  ok(Number(mv?.delta) === 5 && mv?.variant_id != null, "movement trail records the exact combination", JSON.stringify(mv));

  // ── UI-E · a plain product can be given options later ────────────────
  section("UI-E · an existing plain product can adopt options");
  await waitFor(page, async () => (await page.$(tid(`inv-edit-${plainRow.id}`))) !== null, 15000);
  await clickTestid(page, `inv-edit-${plainRow.id}`);
  ok("plain record offers the options CTA", await waitFor(page, async () => (await page.$(tid("edit-add-options"))) !== null, 15000));
  await clickTestid(page, "edit-add-options");
  ok("options editor opens for the plain product", await waitFor(page, async () => (await page.$(tid("inv-manage-axis1-label"))) !== null, 15000));
  await page.$eval(tid("inv-manage-axis1-label"), (el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "Colour");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval(tid("inv-manage-a1-custom"), (el) => {
    el.value = "Red";
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await sleep(300);
  await page.$eval(tid("inv-manage-a1-custom"), (el) => {
    el.value = "Blue";
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await sleep(300);
  await page.$eval(tid("inv-manage-matrix-qty-0"), (el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "7");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval(tid("inv-manage-matrix-qty-1"), (el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "5");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(300);
  await clickTestid(page, "inv-variant-editor-save");
  const adopted = await waitFor(page, async () => {
    const r = await q1(`select tracks_variants, quantity from inventory_items where id = $1`, [plainRow.id]);
    const n = await q1(`select count(*)::int n from inventory_variants where inventory_id = $1`, [plainRow.id]);
    return r?.tracks_variants === true && Number(n.n) === 2;
  }, 20000);
  ok("the plain product became variant-tracked with 2 combinations", adopted);
  const adoptedItem = await q1(`select quantity from inventory_items where id = $1`, [plainRow.id]);
  ok(Number(adoptedItem.quantity) === 12, "total is the sum of the new combinations (7 + 5)", String(adoptedItem.quantity));

  // ── UI-F · the Order Page gates the out-of-stock combination ─────────
  section("UI-F · Order Page sells only available combinations");
  const zero = await q1(
    `select id, quantity from inventory_variants where inventory_id = $1 and size = 'L' and color = 'White'`,
    [vItem.id],
  );
  ok("White/L is out of stock as entered (0)", Number(zero.quantity) === 0);
  await page.goto(`${BASE}/order?biz=${BIZ}&p=${vItem.id}`, { waitUntil: "networkidle2", timeout: 60000 });
  const pickerShown = await waitFor(
    page,
    async () =>
      (await page.$(`[data-testid$="-variants-${vItem.id}"]`)) !== null ||
      (await page.$("[data-testid*='-size-']")) !== null,
    25000,
  );
  ok("storefront renders the size/colour picker for the new product", pickerShown);

  // Pick the size first: only then is the empty White/L pair exposed as
  // unselectable — exactly how the Order Page protects the customer.
  const sizeLClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => /-size-/.test(b.getAttribute("data-testid") || "") && (b.textContent || "").trim() === "L",
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  ok("size L can be chosen (the other colours are in stock)", sizeLClicked);
  await sleep(700);
  const white = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => /-color-/.test(b.getAttribute("data-testid") || "") && /white/i.test(b.textContent || ""),
    );
    if (!btn) return null;
    return { disabled: btn.disabled === true, title: btn.getAttribute("title") || "" };
  });
  ok("the sold-out White/L combination is not selectable", white?.disabled === true, JSON.stringify(white));
  ok("the customer sees why it is sold out", /out of stock/i.test(white?.title || ""), String(white?.title));
  await page.screenshot({ path: `${OUT}order-variant.png` });

  console.log(`\n${failed === 0 ? "✅" : "❌"} variant UI suite: ${passed} passed, ${failed} failed`);
} catch (e) {
  failed++;
  console.error("\n❌ suite aborted:", e.message);
  if (page) await page.screenshot({ path: `${OUT}abort.png` }).catch(() => {});
} finally {
  await purge();
  await browser?.close().catch(() => {});
  await client.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}
