/**
 * seed-platform-request-demo.mjs — one clearly-marked DEMO platform request so
 * the Platform Owners → Platform requests console (and the Super Admin's bell)
 * have something real to show on a fresh deployment.
 *
 * Goes through the REAL public API (`POST /api/platform-requests`) — the same
 * call the storefront Help/Contact panel and /join page make — so the demo row
 * exercises validation, the honeypot, the throttle and the notification path
 * exactly as a genuine submission would.
 *
 * Idempotent: skips when a DEMO request already exists.
 * Run: node dev-tooling/seed-platform-request-demo.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const MARK = "DEMO ·";

const pg = new Client({ connectionString: DB });
await pg.connect();

const existing = await pg.query(
  `SELECT reference, status FROM platform_requests WHERE contact_name LIKE $1 OR business_name LIKE $1 LIMIT 1`,
  [`${MARK}%`],
);
if (existing.rows.length) {
  console.log(`✔ DEMO platform request already present (${existing.rows[0].reference} · ${existing.rows[0].status}) — skipping`);
  await pg.end();
  process.exit(0);
}

const payload = {
  purpose: "JOIN_PLATFORM",
  businessName: `${MARK} Sunyani Provisions`,
  contactName: `${MARK} Yaw Boateng`,
  contactEmail: "demo.provisions@example.com",
  contactPhone: "0551234567",
  businessType: "HARDWARE_STORE",
  location: "Sunyani, Bono Region",
  message:
    `${MARK} I run a hardware shop and a small poultry pen. I would like to sell online, ` +
    `track stock and see my daily profit in one place. Please call me to arrange a walkthrough.`,
  source: "join",
};

const res = await fetch(`${BASE}/api/platform-requests`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.77" },
  body: JSON.stringify(payload),
});
const data = await res.json().catch(() => ({}));
if (!res.ok || !data.success) {
  console.error(`✗ seed failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  await pg.end();
  process.exit(1);
}

console.log(
  data.reference
    ? `✔ DEMO platform request created — reference ${data.reference} (PENDING; the Super Admin's bell was notified)`
    : `✔ DEMO platform request already covered by an open request (no duplicate created)`,
);
console.log("  Open: Platform Owners → Platform requests (sign in as the Super Admin).");
await pg.end();
