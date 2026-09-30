/**
 * verify-notification-actions-ui.mjs
 * End-to-end browser verification of GoMina 360 Notification Bell,
 * dropdown interactions, deep-link routing, and card focus/highlighting.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: "Owner@GoMina26" };

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const results = [];
const pageErrors = [];

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✔" : "✖"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await pg.connect();
  console.log("=== GOMINA 360 NOTIFICATION BELL & ACTIONS UI E2E ===");

  // 1. Setup seed notifications in database for Owner
  const [ownerRow] = (await pg.query("SELECT id, assigned_business_id FROM users WHERE email = $1", [OWNER.email])).rows;
  if (!ownerRow) throw new Error("Owner user not found");
  const [bizRow] = (await pg.query("SELECT id FROM businesses LIMIT 1")).rows;
  const businessId = ownerRow.assigned_business_id || (bizRow ? bizRow.id : 1);

  // Insert a test approval request
  const [appReq] = (await pg.query(
    "INSERT INTO approval_requests (owner_id, business_id, branch_code, action, target_type, target_id, target_label, amount_ghs, requested_by_user_id, requested_by_name, requested_by_role, status, created_at) VALUES (1, $1, 'POULTRY-01', 'EXPENSE_CREATE', 'TRANSACTION', 9901, 'Urgent Vet Feed Procurement', 850, $2, 'Worker Akosua', 'WORKER', 'PENDING', NOW()) RETURNING id",
    [businessId, ownerRow.id]
  )).rows;

  // Insert approval notification
  const [appNotif] = (await pg.query(
    "INSERT INTO notifications (user_id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, is_read, created_at) VALUES ($1, 'APPROVAL_REQUESTED', 'Expense Request: Urgent Vet Feed', 'Worker Akosua requested GHS 850 for Vet Feed', 'approval_requests', $2, $3, $4, 'POULTRY-01', false, NOW()) RETURNING id",
    [ownerRow.id, appReq.id, `approval:${appReq.id}`, businessId]
  )).rows;

  // Insert a customer tracking record and order notification
  const [orderRow] = (await pg.query(
    "INSERT INTO customer_trackings (tracking_code, customer_name, customer_phone, destination_address, status, payment_status, total_ghs, business_id, created_at) VALUES ('TRK-BELL-7788', 'Ama Serwaa', '+233200998877', 'East Legon, Accra', 'CONFIRMED', 'PAID', 320, $1, NOW()) RETURNING id",
    [businessId]
  )).rows;

  const [orderNotif] = (await pg.query(
    "INSERT INTO notifications (user_id, type, title, body, record_type, record_id, record_ref, business_id, branch_code, is_read, created_at) VALUES ($1, 'ONLINE_ORDER_RECEIVED', 'New Online Order TRK-BELL-7788', 'Customer Ama Serwaa placed an order of GHS 320', 'customer_trackings', $2, 'TRK-BELL-7788', $3, 'POULTRY-01', false, NOW()) RETURNING id",
    [ownerRow.id, orderRow.id, businessId]
  )).rows;

  // 2. Launch browser
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 }
  });

  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(`[PAGEERROR] ${e.message || e}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      const text = m.text();
      if (!/401|403|Failed to load resource|favicon/.test(text)) {
        pageErrors.push(`[CONSOLE_ERR] ${text}`);
      }
    }
  });

  const waitSel = (sel, timeout = 25000) => page.waitForSelector(sel, { timeout });
  const clickTid = async (tid) => {
    await waitSel(`[data-testid="${tid}"]`);
    await page.$eval(`[data-testid="${tid}"]`, (e) => e.click());
  };
  const setTid = async (tid, val) => {
    await waitSel(`[data-testid="${tid}"]`);
    await page.evaluate((s, v) => {
      const el = document.querySelector(s);
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, `[data-testid="${tid}"]`, val);
  };

  try {
    // 3. Navigate to app & login
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitSel('[data-testid="login-email"]');
    await setTid("login-email", OWNER.email);
    await setTid("login-password", OWNER.pass);
    await clickTid("login-submit");

    await waitSel("[data-testid='notif-bell']", 30000);
    ok("Successfully logged in and notification bell button is visible in header", true);

    // 4. Check Bell Badge
    const unreadBadge = await waitSel("[data-testid='notif-badge']", 10000);
    const unreadText = await page.evaluate(el => el.textContent?.trim(), unreadBadge);
    ok(`Notification unread badge is rendered with active count (${unreadText})`, !!unreadBadge && Number(unreadText) > 0);

    // 5. Open Notification Dropdown
    await clickTid("notif-bell");
    await waitSel("[data-testid='notif-panel']", 5000);
    ok("Notification panel dropdown opened on bell click", true);

    // Check target badges
    const targetBadges = await page.$$eval("[data-testid='notification-target-tag']", els => els.map(e => e.textContent?.trim()));
    ok("Target action badges rendered for notifications", targetBadges.length > 0 && targetBadges.some(b => b.includes("Approval") || b.includes("Order")));
    console.log("    Found target badges:", targetBadges.slice(0, 4));

    // 6. Click on the Expense Approval Notification
    const notifItem = await waitSel(`[data-testid='notif-item-${appNotif.id}']`, 5000);
    ok("Approval notification row is visible in panel", !!notifItem);
    await page.$eval(`[data-testid='notif-item-${appNotif.id}']`, (e) => e.click());

    // 7. Verify routing to Action Center / Approvals and card focus
    await sleep(2000);
    const approvalCard = await waitSel(`[data-testid='approval-card-${appReq.id}']`, 10000);
    ok("Deep link navigated to Action Center / Approvals and displayed target approval card", !!approvalCard);

    // Verify card highlight
    const cardClasses = await page.$eval(`[data-testid='approval-card-${appReq.id}']`, el => el.className);
    ok("Approval request card has focus highlight ring applied", cardClasses.includes("ring-2") && cardClasses.includes("ring-indigo-500"));

    // 8. Re-open Bell and Click Order Notification
    await clickTid("notif-bell");
    await waitSel("[data-testid='notif-panel']", 5000);

    const orderNotifItem = await waitSel(`[data-testid='notif-item-${orderNotif.id}']`, 5000);
    ok("Order notification row is visible in panel", !!orderNotifItem);
    await page.$eval(`[data-testid='notif-item-${orderNotif.id}']`, (e) => e.click());

    // 9. Verify routing to Customer Tracking Panel and order focus
    await sleep(2000);
    const trackingSearch = await waitSel("[data-testid='ct-search']", 10000);
    const searchValue = await page.evaluate(el => el.value, trackingSearch);
    ok("Customer Tracking search pre-populated with tracking code 'TRK-BELL-7788'", searchValue.includes("TRK-BELL-7788"));

    // Check no unexpected page errors occurred
    ok("Zero page errors or unhandled console exceptions encountered", pageErrors.length === 0, pageErrors.join(", "));

  } finally {
    await browser.close();
    // Cleanup test fixtures
    await pg.query("DELETE FROM notifications WHERE id IN ($1, $2)", [appNotif.id, orderNotif.id]);
    await pg.query("DELETE FROM approval_requests WHERE id = $1", [appReq.id]);
    await pg.query("DELETE FROM customer_trackings WHERE id = $1", [orderRow.id]);
    await pg.end();
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nUI E2E Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("UI E2E failed with error:", e);
  process.exit(1);
});
