// Verify suite — R2 Procurement chain (CAPABILITY-AUDIT-REPORT §4):
//   Requisition (draft → policy-gated approval) → competing quotes →
//   award (PO raised from quote, siblings rejected) → advance → GRN →
//   invoice 3-way match → payment (ON_CREDIT books the expense exactly
//   once; ON_RECEIPT keeps booking at GRN) → supplier performance,
//   plus low-stock → auto-drafted requisition and tenant scoping.
// Restores every touched row.
//
// Run: node dev-tooling/verify-procurement-chain.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const BM = { email: "emmanuel@gomina360.com", pw: process.env.BM_PW || "GoMina@User3" };
const GM = { email: "abena.gm@gomina360.com", pw: process.env.GM_PW || "GoMina@User2" };

let BIZ = -1; // GoMina Hardware & Building Materials Depot (org 1) — resolved by code
let NAILS = -1; // Common Wire Nails 3in — fixture for both GRN + low-stock, resolved by SKU
// (ids change whenever HARDWARE-01 is re-provisioned by verify-hardware-audit's
//  destructive phase — resolve at runtime instead of hard-coding.)

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

// Resolve fixtures by stable business/sku codes (ids drift across re-provisions).
BIZ = (await q1(`select id from businesses where code='HARDWARE-01'`))?.id ?? -1;
NAILS = (await q1(`select id from inventory_items where business_id=$1 and sku='HARDWARE-01-NAILS-3IN'`, [BIZ]))?.id ?? -1;

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
const created = { reqIds: [], quoteIds: [], poIds: [], invoiceIds: [], paymentIds: [], trxIds: [], grnIds: [], draftedReqIds: [] };
let nailsOrig = null;

async function cleanup() {
  // Policies (default state: none for this action)
  await q(`delete from approval_policies where action = 'PURCHASE_REQUISITION'`);
  // Approval requests + their notifications from this run
  await q(
    `delete from approval_requests where created_at >= $1 and action in ('PURCHASE_REQUISITION','PURCHASE_ORDER')`,
    [suiteStart],
  );
  await q(`delete from notifications where created_at >= $1 and (record_ref like 'approval:%' or record_ref like 'low-stock:%')`, [suiteStart]);
  // Chain rows (children first)
  await q(`delete from supplier_payments where id = any($1::int[])`, [created.paymentIds]).catch(() => {});
  await q(`delete from supplier_invoices where id = any($1::int[])`, [created.invoiceIds]).catch(() => {});
  await q(`delete from supplier_quotes where id = any($1::int[])`, [created.quoteIds]).catch(() => {});
  await q(`delete from purchase_requisitions where id = any($1::int[])`, [created.draftedReqIds]).catch(() => {});
  await q(`delete from purchase_requisitions where notes = 'procurement chain suite'`);
  // sweep artifacts (incl. crashed runs): today's auto-drafts + their markers
  await q(`delete from purchase_requisitions where notes like 'Auto-drafted by the daily low-stock sweep%' and created_at >= $1`, [suiteStart]);
  await q(`delete from system_markers where key like 'low-stock-pr:%'`);
  await q(`delete from supplier_quotes where notes = 'procurement chain suite'`);
  await q(`delete from supplier_invoices where notes = 'procurement chain suite'`);
  // Payments/invoices/quotes/POs a crashed earlier run may have left
  await q(`delete from supplier_payments where note = 'procurement chain suite'`);
  await q(`delete from supplier_invoices where invoice_number like 'PCS-%'`);
  await q(`delete from supplier_quotes where supplier_name in ('Chain Suite Supplier A','Chain Suite Supplier B')`);
  await q(`delete from purchase_requisitions where requested_by_name = 'Kwame Owner' and notes = 'procurement chain suite'`);
  const stalePOs = (await q(`select id from supplier_orders where notes like 'Awarded from quotation SQ-%' or notes like '%procurement chain suite%'`)).map((r) => r.id);
  const allPOs = [...new Set([...created.poIds, ...stalePOs])];
  if (allPOs.length) {
    await q(`delete from goods_receipts where supplier_order_id = any($1::int[])`, [allPOs]).catch(() => {});
    await q(`delete from supplier_orders where id = any($1::int[])`, [allPOs]).catch(() => {});
  }
  await q(
    `delete from transactions where business_id = $2 and created_at >= $1 and (description like '[PO:%' or category in ('Supplier Procurement','Supplier Payment'))`,
    [suiteStart, BIZ],
  );
  // Restore fixture stock
  if (nailsOrig) {
    await q(`update inventory_items set quantity = $1, status = $2 where id = $3`, [nailsOrig.qty, nailsOrig.status, NAILS]);
  }
}

try {
  await cleanup(); // crashed-run sweep
  const ownerTok = await apiLogin(OWNER);
  const workerTok = await apiLogin(WORKER);
  const bmTok = await apiLogin(BM);
  const gmTok = await apiLogin(GM);
  ok("logins (owner/worker/bm/gm)", ownerTok && workerTok && bmTok && gmTok);

  nailsOrig = (await q1(`select quantity as qty, status from inventory_items where id = $1`, [NAILS])) || null;
  ok("fixture: hardware nails item present", !!nailsOrig, `qty ${nailsOrig?.qty}`);

  // ── 1. GET register exposes the R2 sections, scoped + with the catalogue ──
  const reg = await api("GET", `/api/procurement?businessId=${BIZ}`, ownerTok);
  ok("GET register (owner, biz 8) succeeds", reg.status === 200 && reg.json?.success);
  ok(
    "GET register returns requisitions/quotes/invoices/payments/performance/inventory",
    Array.isArray(reg.json?.requisitions) && Array.isArray(reg.json?.quotes) && Array.isArray(reg.json?.invoices) &&
      Array.isArray(reg.json?.payments) && Array.isArray(reg.json?.supplierPerformance) && Array.isArray(reg.json?.inventory),
  );
  ok("GET register inventory catalogue lists the unit's stock", (reg.json?.inventory || []).some((i) => Number(i.id) === NAILS));

  // ── 2. Tenant scoping: worker (biz 1) cannot touch biz 8; BM (biz 1) never sees biz 8 rows ──
  const wCreate = await api("POST", "/api/procurement", workerTok, {
    action: "REQUISITION_CREATE", businessId: BIZ,
    lines: [{ inventoryId: NAILS, description: "nails", quantity: 1 }],
  });
  ok("worker from another unit cannot create requisitions (403)", wCreate.status === 403);
  const bmReg = await api("GET", "/api/procurement", bmTok);
  ok(
    "BM's register never leaks other units' requisitions/invoices",
    bmReg.json?.success &&
      (bmReg.json.requisitions || []).every((r) => Number(r.businessId) === 1) &&
      (bmReg.json.invoices || []).every((r) => Number(r.businessId) === 1),
  );

  // ── 3. Requisition: create (draft) + validation ──
  const badReq = await api("POST", "/api/procurement", ownerTok, { action: "REQUISITION_CREATE", businessId: BIZ, lines: [] });
  ok("requisition without lines rejected", badReq.status === 400);
  const badQty = await api("POST", "/api/procurement", ownerTok, {
    action: "REQUISITION_CREATE", businessId: BIZ,
    lines: [{ inventoryId: NAILS, description: "nails", quantity: 0 }],
  });
  ok("requisition with zero quantity rejected", badQty.status === 400);

  const req1 = await api("POST", "/api/procurement", ownerTok, {
    action: "REQUISITION_CREATE", businessId: BIZ,
    lines: [{ inventoryId: NAILS, description: "Common Wire Nails 3in (25kg Box)", quantity: 10, unit: "Boxes", estUnitCostGhs: 380 }],
    needBy: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    notes: "procurement chain suite",
  });
  ok("requisition created as DRAFT", req1.status === 200 && req1.json?.requisition?.status === "DRAFT");
  const pr1 = req1.json?.requisition;
  ok("requisition number is per-org sequence PR-YYYY-####", /^PR-\d{4}-\d{4,}$/.test(pr1?.reqNumber || ""), pr1?.reqNumber);
  created.reqIds.push(pr1?.id);

  const badSubmit = await api("POST", "/api/procurement", ownerTok, { action: "REQUISITION_SUBMIT", id: 999999 });
  ok("submitting an unknown requisition 404s", badSubmit.status === 404);

  // ── 4. Ungated submit (no policy → auto-approve, default-off doctrine) ──
  const sub1 = await api("POST", "/api/procurement", ownerTok, { action: "REQUISITION_SUBMIT", id: pr1.id });
  ok("ungated submit → APPROVED immediately", sub1.status === 200 && sub1.json?.requisition?.status === "APPROVED" && !sub1.json?.pendingApproval);

  // ── 5. Gated submit (policy on PURCHASE_REQUISITION) ──
  const pol = await api("POST", "/api/approvals", ownerTok, {
    op: "POLICY_CREATE", action: "PURCHASE_REQUISITION", thresholdAmountGhs: 100, approverRole: "OWNER",
  });
  ok("policy created for PURCHASE_REQUISITION ≥ GH₵ 100", pol.json?.success, `policy id ${pol.json?.policy?.id}`);
  // The OWNER is never blocked by their own policy — use the GM as the
  // requesting user for the gated path.
  const req2 = await api("POST", "/api/procurement", gmTok, {
    action: "REQUISITION_CREATE", businessId: BIZ,
    lines: [{ inventoryId: 10, description: "Emulsion Paint 20L Bucket", quantity: 2, unit: "Buckets", estUnitCostGhs: 340 }],
    notes: "procurement chain suite",
  });
  const pr2 = req2.json?.requisition;
  created.reqIds.push(pr2?.id);
  ok("GM can draft a requisition in any unit of the org", req2.status === 200 && !!pr2);
  const sub2 = await api("POST", "/api/procurement", gmTok, { action: "REQUISITION_SUBMIT", id: pr2.id });
  ok("gated submit → PENDING_APPROVAL", sub2.status === 200 && sub2.json?.requisition?.status === "PENDING_APPROVAL" && sub2.json?.pendingApproval === true);
  const ar = await q1(
    `select * from approval_requests where target_type = 'PURCHASE_REQUISITION' and target_id = $1 order by id desc`,
    [pr2.id],
  );
  ok("approval request created for the requisition", !!ar && ar.status === "PENDING", `request #${ar?.id}`);
  ok("requisition row links the approval request", Number((await q1(`select approval_request_id from purchase_requisitions where id = $1`, [pr2.id])).approval_request_id) === Number(ar?.id));
  const appr = await api("POST", "/api/approvals", ownerTok, { op: "DECIDE", requestId: ar.id, decision: "APPROVE" });
  ok("owner approves the requisition", appr.json?.success);
  const pr2After = await q1(`select status, decided_by_name from purchase_requisitions where id = $1`, [pr2.id]);
  ok("approval effect: requisition APPROVED with decider recorded", pr2After.status === "APPROVED" && /Kwame/i.test(pr2After.decided_by_name || ""));

  // Requisition cancel path (draft)
  const req3 = await api("POST", "/api/procurement", ownerTok, {
    action: "REQUISITION_CREATE", businessId: BIZ,
    lines: [{ inventoryId: 11, description: "uPVC Pipe 110mm", quantity: 4, estUnitCostGhs: 65 }],
    notes: "procurement chain suite",
  });
  created.reqIds.push(req3.json?.requisition?.id);
  const canc = await api("POST", "/api/procurement", ownerTok, { action: "REQUISITION_CANCEL", id: req3.json?.requisition?.id });
  ok("draft requisition cancelled", canc.json?.requisition?.status === "CANCELLED");

  // ── 6. Quotes: two competitors against requisition 1 ──
  const badQuote = await api("POST", "/api/procurement", ownerTok, {
    action: "QUOTE_ADD", businessId: BIZ, requisitionId: pr1.id, supplierName: "Chain Suite Supplier A",
    lines: [{ inventoryId: NAILS, description: "nails", quantity: 10, unitCostGhs: 0 }],
  });
  ok("quote with zero-cost lines still registers (costs may be unknown)", badQuote.json?.success); // qty>0 is the hard rule

  const qa = await api("POST", "/api/procurement", ownerTok, {
    action: "QUOTE_ADD", businessId: BIZ, requisitionId: pr1.id, supplierName: "Chain Suite Supplier A",
    lines: [{ inventoryId: NAILS, description: "Common Wire Nails 3in (25kg Box)", quantity: 10, unitCostGhs: 385 }],
    leadTimeDays: 5, paymentTerms: "Net 30", notes: "procurement chain suite",
  });
  ok("quote A registered", qa.status === 200 && qa.json?.quote?.status === "QUOTED");
  const quoteA = qa.json?.quote;
  created.quoteIds.push(quoteA?.id);
  ok("quote number is per-org sequence SQ-YYYY-####", /^SQ-\d{4}-\d{4,}$/.test(quoteA?.quoteNumber || ""), quoteA?.quoteNumber);
  ok("quote total computed", Math.abs(Number(quoteA?.totalGhs) - 3850) < 0.01, `GH₵ ${quoteA?.totalGhs}`);

  const qb = await api("POST", "/api/procurement", ownerTok, {
    action: "QUOTE_ADD", businessId: BIZ, requisitionId: pr1.id, supplierId: 2,
    lines: [{ inventoryId: NAILS, description: "Common Wire Nails 3in (25kg Box)", quantity: 10, unitCostGhs: 379 }],
    leadTimeDays: 8, notes: "procurement chain suite",
  });
  ok("quote B registered against catalogue supplier", qb.json?.success && Number(qb.json?.quote?.supplierId) === 2);
  const quoteB = qb.json?.quote;
  created.quoteIds.push(quoteB?.id);

  // ── 7. Award quote B → PO raised, siblings rejected, requisition ORDERED ──
  const sel = await api("POST", "/api/procurement", ownerTok, { action: "QUOTE_SELECT", id: quoteB.id, paymentMode: "ON_CREDIT" });
  ok("quote selected", sel.status === 200 && sel.json?.quote?.status === "SELECTED");
  const po = sel.json?.order;
  created.poIds.push(po?.id);
  ok("PO raised from the quote's lines", !!po && po.status === "RAISED" && Array.isArray(po.items) && po.items.length === 1 && Number(po.items[0].inventoryId) === NAILS);
  ok("PO carries ON_CREDIT payment mode", po?.paymentMode === "ON_CREDIT");
  ok("PO total equals quote total", Math.abs(Number(po?.totalGhs) - 3790) < 0.01, `GH₵ ${po?.totalGhs}`);
  const sibA = await q1(`select status from supplier_quotes where id = $1`, [quoteA.id]);
  ok("sibling quote auto-rejected", sibA.status === "REJECTED");
  const pr1After = await q1(`select status, supplier_order_id from purchase_requisitions where id = $1`, [pr1.id]);
  ok("requisition → ORDERED and linked to the PO", pr1After.status === "ORDERED" && Number(pr1After.supplier_order_id) === Number(po.id));
  const quoteB2 = await q1(`select status, supplier_order_id from supplier_quotes where id = $1`, [quoteB.id]);
  ok("quote row links its PO", Number(quoteB2.supplier_order_id) === Number(po.id));
  const reSelect = await api("POST", "/api/procurement", ownerTok, { action: "QUOTE_SELECT", id: quoteB.id });
  ok("re-selecting a decided quote 409s", reSelect.status === 409);

  // ── 8. Advance the PO to ARRIVED, then post the goods receipt ──
  for (const st of ["SENT", "SHIPPED", "IN_TRANSIT", "ARRIVED"]) {
    await api("POST", "/api/procurement", ownerTok, { action: "ADVANCE", businessId: BIZ, id: po.id, status: st });
  }
  const poArrived = await q1(`select status from supplier_orders where id = $1`, [po.id]);
  ok("PO advanced RAISED → ARRIVED", poArrived.status === "ARRIVED");
  const nailsBefore = Number(nailsOrig.qty);
  const rcv = await api("POST", "/api/procurement", ownerTok, { action: "RECEIVE", businessId: BIZ, id: po.id, reference: "chain-suite-grn" });
  ok("goods receipt posted", rcv.status === 200 && rcv.json?.order?.status === "RECEIVED");
  const nailsAfter = Number((await q1(`select quantity from inventory_items where id = $1`, [NAILS])).quantity);
  ok("GRN lands stock into the unit's inventory (+10 boxes)", nailsAfter === nailsBefore + 10, `${nailsBefore} → ${nailsAfter}`);
  const grnTrx = await q(
    `select * from transactions where business_id = $1 and category = 'Supplier Procurement' and description like $2`,
    [BIZ, `[PO:${po.purchaseNumber}]%`],
  );
  ok("ON_CREDIT PO books NO expense at GRN", grnTrx.length === 0, `${grnTrx.length} trx found`);

  // ── 9. Invoices: 3-way match (MATCHED / VARIANCE / PENDING) ──
  const invMatch = await api("POST", "/api/procurement", ownerTok, {
    action: "INVOICE_REGISTER", businessId: BIZ, supplierOrderId: po.id,
    invoiceNumber: `PCS-M-${Date.now()}`, invoiceDate: new Date().toISOString().slice(0, 10),
    amountGhs: 3790, notes: "procurement chain suite",
  });
  ok("matching invoice → MATCHED", invMatch.status === 200 && invMatch.json?.invoice?.status === "MATCHED");
  const inv1 = invMatch.json?.invoice;
  created.invoiceIds.push(inv1?.id);
  ok("invoice mirrors the PO's payment mode", inv1?.paymentMode === "ON_CREDIT");
  ok(
    "match result carries the 3-way snapshot",
    inv1?.matchResult?.poNumber === po.purchaseNumber && Math.abs(Number(inv1?.matchResult?.varianceGhs)) < 0.01 && Number(inv1?.matchResult?.receivedQty) === 10,
  );
  const dupInv = await api("POST", "/api/procurement", ownerTok, {
    action: "INVOICE_REGISTER", businessId: BIZ, supplierOrderId: po.id,
    invoiceNumber: inv1.invoiceNumber, amountGhs: 3790,
  });
  ok("duplicate invoice number rejected (409)", dupInv.status === 409);

  const invVar = await api("POST", "/api/procurement", ownerTok, {
    action: "INVOICE_REGISTER", businessId: BIZ, supplierOrderId: po.id,
    invoiceNumber: `PCS-V-${Date.now()}`, amountGhs: 3990, notes: "procurement chain suite",
  });
  ok("over-billed invoice → VARIANCE with note", invVar.json?.invoice?.status === "VARIANCE" && /differs/i.test(invVar.json?.invoice?.matchResult?.varianceNote || ""));
  created.invoiceIds.push(invVar.json?.invoice?.id);
  const invCancel = await api("POST", "/api/procurement", ownerTok, { action: "INVOICE_CANCEL", id: invVar.json?.invoice?.id });
  ok("unpaid variance invoice cancellable", invCancel.json?.invoice?.status === "CANCELLED");

  const invPend = await api("POST", "/api/procurement", ownerTok, {
    action: "INVOICE_REGISTER", businessId: BIZ,
    invoiceNumber: `PCS-P-${Date.now()}`, amountGhs: 120, notes: "procurement chain suite",
  });
  ok("invoice without PO → PENDING (direct purchase)", invPend.json?.invoice?.status === "PENDING");
  created.invoiceIds.push(invPend.json?.invoice?.id);

  // ── 10. Payment: ON_CREDIT books the expense exactly once, marks PAID ──
  const overpay = await api("POST", "/api/procurement", ownerTok, { action: "PAYMENT_RECORD", id: inv1.id, amountGhs: 5000, paymentMethod: "CASH" });
  ok("overpaying the invoice rejected", overpay.status === 400);
  const badMethod = await api("POST", "/api/procurement", ownerTok, { action: "PAYMENT_RECORD", id: inv1.id, amountGhs: 100, paymentMethod: "COWRIE_SHELLS" });
  ok("unsupported payment method rejected", badMethod.status === 400);

  const pay1 = await api("POST", "/api/procurement", ownerTok, {
    action: "PAYMENT_RECORD", id: inv1.id, amountGhs: 2000, paymentMethod: "MTN_MOMO", reference: "chain-suite-part-1",
  });
  ok("partial payment recorded", pay1.status === 200 && pay1.json?.invoice?.status !== "PAID" && Math.abs(Number(pay1.json?.invoice?.amountPaidGhs) - 2000) < 0.01);
  created.paymentIds.push(pay1.json?.payment?.id);
  ok("ON_CREDIT payment books a linked EXPENSE transaction", !!pay1.json?.transactionId);
  created.trxIds.push(pay1.json?.transactionId);
  const trx1 = await q1(`select * from transactions where id = $1`, [pay1.json?.transactionId]);
  ok(
    "expense booking is correct (EXPENSE / Supplier Payment / GH₵ 2000 / MOMO)",
    trx1 && trx1.type === "EXPENSE" && trx1.category === "Supplier Payment" && Math.abs(Number(trx1.amount_ghs) - 2000) < 0.01 && trx1.payment_method === "MTN_MOMO",
  );
  const pay2 = await api("POST", "/api/procurement", ownerTok, {
    action: "PAYMENT_RECORD", id: inv1.id, amountGhs: 1790, paymentMethod: "BANK_TRANSFER", reference: "chain-suite-part-2",
  });
  created.paymentIds.push(pay2.json?.payment?.id);
  created.trxIds.push(pay2.json?.transactionId);
  ok("final payment flips invoice to PAID", pay2.json?.invoice?.status === "PAID");
  const payTrx = await q(`select * from transactions where business_id = $1 and category = 'Supplier Payment' and created_at >= $2`, [BIZ, suiteStart]);
  ok("exactly two expense bookings (one per payment, never at GRN)", payTrx.length === 2, `${payTrx.length} trx`);
  const pay3 = await api("POST", "/api/procurement", ownerTok, { action: "PAYMENT_RECORD", id: inv1.id, amountGhs: 1, paymentMethod: "CASH" });
  ok("paying a PAID invoice 409s", pay3.status === 409);
  ok("payment number format SPP-YYYY-xxxxxx", /^SPP-\d{4}-\d{4,}$/.test(pay1.json?.payment?.paymentNumber || ""), pay1.json?.payment?.paymentNumber);

  // ── 11. ON_RECEIPT default is unchanged (expense at GRN) ──
  const raiseDirect = await api("POST", "/api/procurement", ownerTok, {
    action: "RAISE", businessId: BIZ, supplierId: 2,
    lines: [{ inventoryId: NAILS, description: "Common Wire Nails 3in (25kg Box)", quantity: 2, unitCostGhs: 380 }],
    notes: "procurement chain suite ON_RECEIPT check",
  });
  ok("direct RAISE still works (ungated, default flow)", raiseDirect.json?.success && raiseDirect.json?.order?.status === "RAISED");
  const po2 = raiseDirect.json?.order;
  created.poIds.push(po2?.id);
  ok("direct PO defaults to ON_RECEIPT", po2?.paymentMode === "ON_RECEIPT");
  for (const st of ["SENT", "SHIPPED", "IN_TRANSIT", "ARRIVED"]) {
    await api("POST", "/api/procurement", ownerTok, { action: "ADVANCE", businessId: BIZ, id: po2.id, status: st });
  }
  await api("POST", "/api/procurement", ownerTok, { action: "RECEIVE", businessId: BIZ, id: po2.id, reference: "chain-suite-grn-2" });
  const grnTrx2 = await q(`select * from transactions where business_id = $1 and category = 'Supplier Procurement' and description like $2`, [BIZ, `[PO:${po2.purchaseNumber}]%`]);
  ok("ON_RECEIPT PO books the expense at GRN (unchanged default)", grnTrx2.length === 1 && Math.abs(Number(grnTrx2[0].amount_ghs) - 760) < 0.01, `GH₵ ${grnTrx2[0]?.amount_ghs}`);

  // ── 12. Supplier performance reflects the chain ──
  const perfReg = await api("GET", `/api/procurement?businessId=${BIZ}`, ownerTok);
  const perf = (perfReg.json?.supplierPerformance || []).find((s) => Number(s.supplierId) === 2);
  ok(
    "supplier performance: orders, receipts, lead time, 100% fill",
    perf && Number(perf.orders) >= 2 && Number(perf.received) >= 2 && perf.avgLeadTimeDays != null && Number(perf.fillRatePct) === 100,
    JSON.stringify(perf || {}),
  );

  // ── 13. Low-stock sweep → auto-drafted requisition ──
  await q(`update inventory_items set quantity = 5, status = 'LOW_STOCK' where id = $1`, [NAILS]);
  const sweep = await api("POST", `/api/low-stock?businessId=${BIZ}&draftPr=1`, ownerTok);
  ok("low-stock sweep with draftPr succeeds", sweep.json?.success);
  const drafted = (sweep.json?.draftedRequisitions || []).find((r) => Number(r.businessId) === BIZ);
  ok("sweep drafts a LOW_STOCK requisition", !!drafted && drafted.status === "DRAFT" && drafted.source === "LOW_STOCK", drafted?.reqNumber);
  created.draftedReqIds.push(drafted?.id);
  const draftLines = drafted?.lines || [];
  ok(
    "drafted line tops the item back up to its threshold (12 − 5 = 7 boxes @ cost)",
    draftLines.length === 1 && Number(draftLines[0].inventoryId) === NAILS && Number(draftLines[0].quantity) === 7 && Math.abs(Number(draftLines[0].estUnitCostGhs) - 380) < 0.01,
    JSON.stringify(draftLines[0] || {}),
  );
  const sweep2 = await api("POST", `/api/low-stock?businessId=${BIZ}&draftPr=1`, ownerTok);
  const dbDrafts = await q(`select id from purchase_requisitions where business_id = $1 and source = 'LOW_STOCK' and status = 'DRAFT'`, [BIZ]);
  ok("same-day sweep does not duplicate the draft (marker-gated)", (sweep2.json?.draftedRequisitions || []).length === 0 && dbDrafts.length === 1, `${dbDrafts.length} draft(s) in DB, sweep2 drafted ${(sweep2.json?.draftedRequisitions || []).length}`);

  // ── 14. dailyOps pipeline includes the low-stock-pr step ──
  const daily = await api("GET", "/api/cron/daily?force=1", ownerTok);
  const steps = daily.json?.steps || [];
  ok(
    "daily ops runs the low-stock-pr step",
    daily.json?.success && daily.json?.ran === true && steps.some((s) => s.step === "low-stock-pr" && s.ok),
    (steps || []).map((s) => `${s.step}${s.ok ? "" : "!"}`).join(","),
  );

  // ── 15. Register end-state sanity (owner sees the full chain) ──
  const finalReg = await api("GET", `/api/procurement?businessId=${BIZ}`, ownerTok);
  ok(
    "final register shows the requisition, both quotes, invoices & payments",
    (finalReg.json?.requisitions || []).some((r) => Number(r.id) === Number(pr1.id) && r.status === "ORDERED") &&
      (finalReg.json?.quotes || []).some((qq) => Number(qq.id) === Number(quoteB.id) && qq.status === "SELECTED") &&
      (finalReg.json?.invoices || []).some((ii) => Number(ii.id) === Number(inv1.id) && ii.status === "PAID" && (ii.payments || []).length === 2),
  );
} catch (e) {
  console.error("SUITE ERROR:", e);
  failures++;
} finally {
  await cleanup();
  await client.end();
}

console.log(`\n${failures === 0 ? "🌟" : "💥"} procurement-chain: ${checks.length - failures}/${checks.length} checks passed${failures ? ` (${failures} FAILED)` : ""}`);
process.exit(failures ? 1 : 0);
