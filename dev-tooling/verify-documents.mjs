// Verify suite — R4 Document Vault (CAPABILITY-AUDIT-REPORT §3):
//   uploads (mime/size validation, tenant scoping, permissions), the list vs
//   full-file contract, generated vet reports & delivery notes (real PDFs),
//   PATCH corrections, and the 30/7/0-day expiry sweep with dedupe.
// Restores every touched row.
//
// Run: node dev-tooling/verify-documents.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const GM = { email: "abena.gm@gomina360.com", pw: process.env.GM_PW || "GoMina@User2" };

const BIZ = 1; // POULTRY-01
const day = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA");
// 1x1 transparent PNG
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const client = new pg.Client(DB);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed ${cred.email}: ${JSON.stringify(j)}`);
  return j.sessionToken;
}
async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const suiteStart = new Date();
const fx = { docIds: [], trackingId: null };

async function cleanup() {
  for (const id of fx.docIds) {
    await q(`delete from business_documents where id = $1`, [id]).catch(() => {});
  }
  await q(`delete from business_documents where title like 'DocVault Suite%' or file_name like 'docvault-suite%'`);
  const stale = (await q(`select id from business_documents where title like 'DocVault Suite%' or file_name like 'docvault-suite%'`)).map((r) => r.id);
  for (const id of stale) await q(`delete from business_documents where id = $1`, [id]).catch(() => {});
  const myDocs = (await q(`select id from business_documents where title like 'DocVault Suite%'`)).map((r) => r.id);
  await q(`delete from notifications where record_ref = any($1::text[])`, [myDocs.flatMap((id) => [`doc-expiry:${id}:30`, `doc-expiry:${id}:7`, `doc-expiry:${id}:0`])]).catch(() => {});
  for (const id of myDocs) await q(`delete from system_markers where key like $1`, [`doc-expiry:${id}:%`]).catch(() => {});
  if (fx.trackingId) await q(`delete from customer_trackings where id = $1`, [fx.trackingId]).catch(() => {});
}

try {
  await cleanup(); // crashed-run sweep
  const ownerTok = await apiLogin(OWNER);
  const workerTok = await apiLogin(WORKER);
  const gmTok = await apiLogin(GM);
  ok("logins (owner/worker/gm)", ownerTok && workerTok && gmTok);

  // ── 1. Upload validation ──
  const noTitle = await api("POST", "/api/documents", ownerTok, { action: "UPLOAD", businessId: BIZ, docType: "LICENCE_PERMIT", fileData: PNG_1PX });
  ok("upload without a title rejected", noTitle.status === 400);
  const badType = await api("POST", "/api/documents", ownerTok, { action: "UPLOAD", businessId: BIZ, docType: "NOT_A_TYPE", title: "DocVault Suite Bad", fileData: PNG_1PX });
  ok("upload with unknown docType rejected", badType.status === 400);
  const badMime = await api("POST", "/api/documents", ownerTok, { action: "UPLOAD", businessId: BIZ, docType: "OTHER", title: "DocVault Suite BadMime", fileData: "data:text/plain;base64,aGVsbG8=" });
  ok("non-image/non-pdf mime rejected", badMime.status === 400);
  const badDate = await api("POST", "/api/documents", ownerTok, { action: "UPLOAD", businessId: BIZ, docType: "OTHER", title: "DocVault Suite BadDate", fileData: PNG_1PX, expiresOn: "next tuesday" });
  ok("malformed expiry date rejected", badDate.status === 400);
  const bigB64 = "data:image/png;base64," + "A".repeat(Math.ceil(2.6 * 1024 * 1024 * 4 / 3));
  const tooBig = await api("POST", "/api/documents", ownerTok, { action: "UPLOAD", businessId: BIZ, docType: "OTHER", title: "DocVault Suite Big", fileData: bigB64 });
  ok("files over 2.5 MB rejected", tooBig.status === 400 && /too large/i.test(tooBig.json?.error || ""));

  // ── 2. Successful uploads (three expiry windows + one far-future) ──
  const up1 = await api("POST", "/api/documents", ownerTok, {
    action: "UPLOAD", businessId: BIZ, docType: "LICENCE_PERMIT", title: "DocVault Suite Licence (30d)",
    fileData: PNG_1PX, fileName: "docvault-suite-licence.png", issuedOn: day(-340), expiresOn: day(25), notes: "Operating licence",
  });
  ok("upload succeeds", up1.status === 200 && up1.json?.document?.id > 0);
  ok("upload response never echoes the file payload", up1.json?.document?.fileData === undefined);
  fx.docIds.push(up1.json?.document?.id);

  const up7 = await api("POST", "/api/documents", ownerTok, {
    action: "UPLOAD", businessId: BIZ, docType: "INSURANCE", title: "DocVault Suite Insurance (7d)",
    fileData: PNG_1PX, expiresOn: day(5),
  });
  fx.docIds.push(up7.json?.document?.id);
  const up0 = await api("POST", "/api/documents", ownerTok, {
    action: "UPLOAD", businessId: BIZ, docType: "CERTIFICATE", title: "DocVault Suite Certificate (today)",
    fileData: PNG_1PX, expiresOn: day(0),
  });
  fx.docIds.push(up0.json?.document?.id);
  const upFar = await api("POST", "/api/documents", ownerTok, {
    action: "UPLOAD", businessId: BIZ, docType: "CONTRACT", title: "DocVault Suite Contract (far)",
    fileData: PNG_1PX, expiresOn: day(200),
  });
  fx.docIds.push(upFar.json?.document?.id);
  const upBiz8 = await api("POST", "/api/documents", ownerTok, {
    action: "UPLOAD", businessId: 8, docType: "OTHER", title: "DocVault Suite Biz8", fileData: PNG_1PX,
  });
  fx.docIds.push(upBiz8.json?.document?.id);
  ok("five documents filed (4× biz1 + 1× biz8)", [up1, up7, up0, upFar, upBiz8].every((u) => u.status === 200));

  // ── 3. List vs full-file contract ──
  const list = await api("GET", `/api/documents?businessId=${BIZ}`, ownerTok);
  ok("list is scoped to the unit and hides payloads", list.json?.success && (list.json.documents || []).every((d) => d.fileData === undefined) && (list.json.documents || []).length === 4);
  ok("summary counts expiring ≤30d", list.json?.summary?.expiringSoon === 3, JSON.stringify(list.json?.summary));
  const full = await api("GET", `/api/documents?id=${fx.docIds[0]}`, ownerTok);
  ok("single fetch returns the full data URL", full.json?.document?.fileData === PNG_1PX);
  const byType = await api("GET", `/api/documents?businessId=${BIZ}&docType=INSURANCE`, ownerTok);
  ok("docType filter works", (byType.json?.documents || []).length === 1 && byType.json.documents[0].docType === "INSURANCE");
  const expiring = await api("GET", `/api/documents?businessId=${BIZ}&expiring=1`, ownerTok);
  ok("expiring filter returns only ≤30d documents", (expiring.json?.documents || []).length === 3);

  // ── 4. Tenant scoping & permissions ──
  const wList = await api("GET", "/api/documents", workerTok);
  ok("worker's unfiltered list stays inside their scope", (wList.json?.documents || []).every((d) => Number(d.businessId) === 1));
  const wForeign = await api("GET", `/api/documents?id=${fx.docIds[4]}`, workerTok);
  ok("worker cannot fetch another unit's document (403)", wForeign.status === 403);
  const wUploadForeign = await api("POST", "/api/documents", workerTok, { action: "UPLOAD", businessId: 8, docType: "OTHER", title: "DocVault Suite W", fileData: PNG_1PX });
  ok("worker cannot file documents for another unit (403)", wUploadForeign.status === 403);
  const wUploadOwn = await api("POST", "/api/documents", workerTok, { action: "UPLOAD", businessId: BIZ, docType: "OTHER", title: "DocVault Suite Worker Doc", fileData: PNG_1PX });
  ok("worker can file documents for their own unit", wUploadOwn.status === 200);
  fx.docIds.push(wUploadOwn.json?.document?.id);
  const wDeleteOwnerDoc = await api("DELETE", `/api/documents?id=${fx.docIds[0]}`, workerTok);
  ok("worker cannot delete a manager's document (403)", wDeleteOwnerDoc.status === 403);
  const wDeleteOwn = await api("DELETE", `/api/documents?id=${wUploadOwn.json?.document?.id}`, workerTok);
  ok("uploader can delete their own document", wDeleteOwn.json?.success);
  fx.docIds = fx.docIds.filter((id) => id !== wUploadOwn.json?.document?.id);

  // ── 5. Generated vet report (from poultry health record, biz 1) ──
  const vetRecordId = (await q("select id from poultry_health_records where business_id=$1 and record_type='VACCINATION' limit 1", [BIZ]))[0]?.id || 1;
  const vet = await api("POST", "/api/documents", ownerTok, { action: "GENERATE_VET_REPORT", healthRecordId: vetRecordId });
  ok("vet report generated from the health log", vet.status === 200 && vet.json?.document?.docType === "VET_REPORT");
  fx.docIds.push(vet.json?.document?.id);
  const vetFull = await api("GET", `/api/documents?id=${vet.json?.document?.id}`, ownerTok);
  const vetPdf = Buffer.from(String(vetFull.json?.document?.fileData || "").split(",")[1] || "", "base64").toString("latin1");
  ok("vet report is a real PDF", vetPdf.startsWith("%PDF-") && vetPdf.includes("%%EOF"));
  ok("vet report carries the report heading and content", vetPdf.includes("Veterinary Report") && (/Vaccination|VACCINATION/i.test(vetPdf) || /Health/i.test(vetPdf)), vetFull.json?.document?.title);
  const vetAgain = await api("POST", "/api/documents", ownerTok, { action: "GENERATE_VET_REPORT", healthRecordId: vetRecordId });
  ok("re-generating replaces instead of duplicating", vetAgain.json?.success && vetAgain.json?.replaced === true && vetAgain.json?.document?.id === vet.json?.document?.id);
  const wVet = await api("POST", "/api/documents", workerTok, { action: "GENERATE_VET_REPORT", healthRecordId: 999999 });
  ok("unknown health record 404s", wVet.status === 404);

  // ── 6. Generated delivery note (from a delivered order) ──
  const [tracking] = (await q(
    `insert into customer_trackings (business_id, branch_code, branch_name, customer_id, customer_name, customer_phone, tracking_code, items, total_ghs, status, fulfillment_type, destination_address, driver_name, created_at)
     values ($1,'POULTRY-01','POULTRY-01',null,'DocVault Suite Customer','+233 20 555 0001','GM-DOCVAULT-T1','[{"description":"Eggs (crate)","quantity":2,"unitPrice":27.5,"total":55}]'::jsonb,55,'DELIVERED','DELIVERY','12 Palm Street, Kanda','Yaw Driver', now() - '2 days'::interval) returning id`,
    [BIZ],
  ));
  fx.trackingId = tracking.id;
  const dn = await api("POST", "/api/documents", ownerTok, { action: "GENERATE_DELIVERY_NOTE", trackingId: tracking.id });
  ok("delivery note generated from the order", dn.status === 200 && dn.json?.document?.docType === "DELIVERY_NOTE");
  fx.docIds.push(dn.json?.document?.id);
  const dnFull = await api("GET", `/api/documents?id=${dn.json?.document?.id}`, ownerTok);
  const dnPdf = Buffer.from(String(dnFull.json?.document?.fileData || "").split(",")[1] || "", "base64").toString("latin1");
  ok("delivery note is a real PDF with the order details", dnPdf.startsWith("%PDF-") && dnPdf.includes("Delivery Note") && dnPdf.includes("GM-DOCVAULT-T1") && dnPdf.includes("Eggs"));
  ok("delivery note carries the receive-by signature block", dnPdf.includes("Received by"));
  const dnAgain = await api("POST", "/api/documents", ownerTok, { action: "GENERATE_DELIVERY_NOTE", trackingId: tracking.id });
  ok("re-generating the delivery note replaces", dnAgain.json?.replaced === true);

  // ── 7. PATCH corrections ──
  const patch = await api("PATCH", "/api/documents", ownerTok, { id: fx.docIds[3], title: "DocVault Suite Contract (renamed)", notes: "Amended 2026" });
  ok("manager edits title/notes", patch.json?.success && patch.json?.document?.title === "DocVault Suite Contract (renamed)");
  const wPatch = await api("PATCH", "/api/documents", workerTok, { id: fx.docIds[3], title: "hijack" });
  ok("worker cannot edit a manager's document (403)", wPatch.status === 403);

  // ── 8. Expiry sweep (30 / 7 / 0 windows, dedupe) ──
  const daily = await api("GET", "/api/cron/daily?force=1", ownerTok);
  ok("daily ops runs the doc-expiry step", daily.json?.ran === true && (daily.json?.steps || []).some((s) => s.step === "doc-expiry" && s.ok), (daily.json?.steps || []).map((s) => `${s.step}${s.ok ? "" : "!"}`).join(","));
  const notif30 = await q(`select count(*)::int as n from notifications where record_ref = $1`, [`doc-expiry:${fx.docIds[0]}:30`]);
  const notif7 = await q(`select count(*)::int as n from notifications where record_ref = $1`, [`doc-expiry:${fx.docIds[1]}:7`]);
  const notif0 = await q(`select count(*)::int as n from notifications where record_ref = $1`, [`doc-expiry:${fx.docIds[2]}:0`]);
  const notifFar = await q(`select count(*)::int as n from notifications where record_ref = $1`, [`doc-expiry:${fx.docIds[3]}:30`]);
  ok("25-day document warned in the 30-day window", notif30[0].n >= 1, `n=${notif30[0].n}`);
  ok("5-day document warned in the 7-day window", notif7[0].n >= 1, `n=${notif7[0].n}`);
  ok("document expiring today warned URGENT", notif0[0].n >= 1 && (await q(`select priority from notifications where record_ref = $1 limit 1`, [`doc-expiry:${fx.docIds[2]}:0`]))[0]?.priority === "URGENT");
  ok("200-day document not warned yet", notifFar[0].n === 0);
  const markers = await q(`select key from system_markers where key like 'doc-expiry:%'`);
  const myMarkers = markers.filter((m) => fx.docIds.slice(0, 3).some((id) => m.key.startsWith(`doc-expiry:${id}:`)));
  ok("one marker per warned window", myMarkers.length === 3, myMarkers.map((m) => m.key).join(", "));
  const before = (await q(`select count(*)::int as n from notifications where record_ref like 'doc-expiry:%'`))[0].n;
  await api("GET", "/api/cron/daily?force=1", ownerTok);
  const after = (await q(`select count(*)::int as n from notifications where record_ref like 'doc-expiry:%'`))[0].n;
  ok("re-running the sweep never re-warns", before === after, `${before} → ${after}`);

  // ── 9. DELETE ──
  const del = await api("DELETE", `/api/documents?id=${fx.docIds[0]}`, ownerTok);
  ok("owner deletes a document", del.json?.success);
  fx.docIds = fx.docIds.filter((id) => id !== fx.docIds[0]);
  const gone = await api("GET", `/api/documents?id=${up1.json?.document?.id}`, ownerTok);
  ok("deleted document 404s", gone.status === 404);
} catch (e) {
  console.error("SUITE ERROR:", e);
  failures++;
} finally {
  await cleanup();
  await client.end();
}

console.log(`\n${failures === 0 ? "🌟" : "💥"} documents: ${checks.length - failures}/${checks.length} checks passed${failures ? ` (${failures} FAILED)` : ""}`);
process.exit(failures ? 1 : 0);
