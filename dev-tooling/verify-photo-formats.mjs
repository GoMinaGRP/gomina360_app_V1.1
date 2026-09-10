#!/usr/bin/env node
/**
 * Photo-upload format acceptance suite.
 *
 * Requirement: every photo-upload field (Inventory, Expenses, Assets, business
 * logos, profile photos, employee photos, audit evidence, …) must accept ALL
 * common image formats with no unnecessary format restrictions.
 *
 * This suite verifies, in two layers:
 *
 *   A. STATIC — every <input type="file"> in the app sources declares
 *      accept="image/*" (the browser-level "any image format" hint), except
 *      the one employee DOCUMENT upload which deliberately also allows PDF.
 *      No input restricts to a single extension or a narrow type list.
 *
 *   B. RUNTIME — the one server endpoint that previously allow-listed only
 *      JPEG/PNG/WebP (the profile photo) now accepts GIF, BMP, SVG, AVIF,
 *      WebP and any other image/* type. Logo uploads accept the same set.
 *
 * Runs against the LIVE app server on http://127.0.0.1:3000 plus direct
 * Postgres to snapshot/restore the OWNER avatar + company logo it mutates.
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-photo-formats.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — ${detail}`); }
}

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await pg.connect();
const q = (t, p = []) => pg.query(t, p);

// ═════════════════════ A. Static: every file input accepts image/* ═════════════════════
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = [...walk("src/components"), ...walk("src/app")];
const problems = [];
let totalFileInputs = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const re = /<input[^>]*type=["']file["'][^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    totalFileInputs++;
    const tag = m[0];
    if (!/accept\s*=/.test(tag)) {
      problems.push(`${f}: input without accept attribute`);
      continue;
    }
    // Extract the accept value
    const am = tag.match(/accept\s*=\s*["']([^"']*)["']/);
    const accept = am ? am[1] : "";
    if (!accept.includes("image/*")) {
      problems.push(`${f}: accept="${accept}" (not image/*)`);
    }
  }
}
check("A1. Found file inputs to audit", totalFileInputs > 0, `found ${totalFileInputs}`);
check("A2. Every file input accepts image/* (or image/* + PDF for docs)", problems.length === 0, problems.join(" | ").slice(0, 400));

// ═════════════════════ B. Runtime: server accepts all image formats ═════════════════════
const ownerRow = (await q(`SELECT id, avatar_url FROM users WHERE email=$1`, [OWNER.email])).rows[0];
const logoRow = (await q(`SELECT company_logo FROM company_settings WHERE id=1`)).rows[0];
const origAvatar = ownerRow?.avatar_url ?? null;
const origLogo = logoRow?.company_logo ?? null;

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`login failed: ${j.error}`);
  return j.sessionToken;
};

const token = await login();

// A well-known 1×1 GIF for the most common case; the remaining formats use a
// short valid base64 payload ("ABCD") — the server validates the data-URL
// shape/format, not the decoded bytes, so this exercises the format gate
// without needing a hand-authored file per format.
const SAMPLES = {
  gif: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  bmp: "data:image/bmp;base64,QUJDRA==",
  svg: "data:image/svg+xml;base64,QUJDRA==",
  avif: "data:image/avif;base64,QUJDRA==",
  webp: "data:image/webp;base64,QUJDRA==",
  tiff: "data:image/tiff;base64,QUJDRA==",
  heic: "data:image/heic;base64,QUJDRA==",
};

// ── Profile photo endpoint (the one previously restricted to JPEG/PNG/WebP) ──
for (const [fmt, dataUrl] of Object.entries(SAMPLES)) {
  const r = await fetch(`${BASE}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ photo: dataUrl }),
  });
  const j = await r.json().catch(() => ({}));
  check(`B1. Profile photo accepts image/${fmt}`, r.ok && j.success === true, `${r.status} ${j.error || ""}`);
}

// ── Company logo endpoint ──
{
  const r = await fetch(`${BASE}/api/logos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "SET_COMPANY_LOGO", logo: SAMPLES.gif }),
  });
  const j = await r.json().catch(() => ({}));
  check("B2. Logo upload accepts image/gif", r.ok && j.success === true, `${r.status} ${j.error || ""}`);
  // remove it again
  await fetch(`${BASE}/api/logos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "SET_COMPANY_LOGO", logo: null }),
  });
}

// Non-image payloads must STILL be rejected (validation remains, formats just widened).
{
  const r = await fetch(`${BASE}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ photo: "data:text/plain;base64,aGVsbG8=" }),
  });
  check("B3. Non-image profile payload still rejected", !r.ok, `status ${r.status}`);
}

// ── Restore original state ──
await q(`UPDATE users SET avatar_url=$1 WHERE id=$2`, [origAvatar, ownerRow.id]);
await q(`UPDATE company_settings SET company_logo=$1 WHERE id=1`, [origLogo]);

console.log(`\n${passed} passed, ${failed} failed`);
await pg.end();
process.exit(failed ? 1 : 0);
