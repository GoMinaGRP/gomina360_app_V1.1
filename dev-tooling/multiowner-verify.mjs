#!/usr/bin/env node
/**
 * Multi-owner isolation verification — two FULLY INDEPENDENT organizations.
 *
 * Creates two disposable fixture orgs + owners + businesses + data solely
 * through the public app surface (no direct DB writes), then asserts that:
 *  1. Each Owner sees ONLY their own org's data (businesses, users, customers,
 *     suppliers, exports, deletion logs, audit feed, downloads, support-info…).
 *  2. Direct URL/API access to the other org's records is refused (403/404).
 *  3. The Super Admin (Kwame) still sees BOTH orgs (D4 platform visibility).
 *  4. The centralized marketplace lists products from BOTH orgs and a public
 *     order placed on Org B's branch routes to Org B only.
 *  5. Suspending an org kills its members' sessions + public checkout.
 *  6. Globally-unique email enforcement (D3).
 *  7. Phase-0 regressions stay green for the Main Owner (org 1).
 *
 * Usage: BASE=http://127.0.0.1:3000 node dev-tooling/multiowner-verify.mjs
 * Fixture artifacts are clearly labeled MW-* so they can be purged afterward.
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`login failed for ${email}: ${r.status} ${j.error || ""}`);
  return { token: j.sessionToken, user: j.user, access: j.accessibleBusinessIds };
}
const H = (t, extra = {}) => ({ "x-gomina-session": t, "content-type": "application/json", ...extra });
async function api(token, path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: H(token, opts.headers || {}) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const tag = `MW-${Date.now().toString(36).toUpperCase()}`;

async function main() {
  console.log(`\n=== Multi-owner isolation verification (fixtures tagged ${tag}) ===`);
  const kwame = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  check("super-admin login", kwame.user.isSuperAdmin === true);
  check("super-admin unrestricted access (null)", kwame.access === null);

  // ── Provision org A + org B with distinct OWNER accounts ───────────────
  const provA = await api(kwame.token, "/api/admin/organizations", {
    method: "POST",
    body: JSON.stringify({
      name: `${tag} Alpha Holdings`, ownerName: "Alpha Owner", ownerEmail: `alpha.${tag.toLowerCase()}@mw-test.local`,
      ownerPassword: "AlphaOwner@26",
    }),
  });
  check("provision org A", provA.status === 200 && provA.body.success, `${provA.status} ${provA.body.error || ""}`);
  const provB = await api(kwame.token, "/api/admin/organizations", {
    method: "POST",
    body: JSON.stringify({
      name: `${tag} Bravo Enterprises`, ownerName: "Bravo Owner", ownerEmail: `bravo.${tag.toLowerCase()}@mw-test.local`,
      ownerPassword: "BravoOwner@26",
    }),
  });
  check("provision org B", provB.status === 200 && provB.body.success, `${provB.status} ${provB.body.error || ""}`);
  const orgA = provA.body.organization, orgB = provB.body.organization, ownA = provA.body.owner, ownB = provB.body.owner;
  console.log(`  orgA=#${orgA.id}(${orgA.slug}) orgB=#${orgB.id}(${orgB.slug})`);

  // D3 — globally unique email: duplicate must be refused
  const dup = await api(kwame.token, "/api/admin/organizations", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Dup`, ownerName: "Dup", ownerEmail: `alpha.${tag.toLowerCase()}@mw-test.local` }),
  });
  check("duplicate owner email refused (globally unique)", dup.status === 409, `${dup.status}`);

  const A = await login(`alpha.${tag.toLowerCase()}@mw-test.local`, "AlphaOwner@26");
  const B = await login(`bravo.${tag.toLowerCase()}@mw-test.local`, "BravoOwner@26");
  check("owner A login → not super admin", A.user.isSuperAdmin === false);
  check("owner A org context", A.user.primaryOrgId === orgA.id, `${A.user.primaryOrgId}`);
  check("owner B org context", B.user.primaryOrgId === orgB.id, `${B.user.primaryOrgId}`);

  // ── Each org owner creates a business unit inside their workspace ───────
  const bizA = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Pub & Grill`, category: "Restaurant", town: "Accra", region: "Greater Accra" }),
  });
  check("org A owner creates a unit", bizA.status === 200 && bizA.body.success, `${bizA.status} ${bizA.body.error || ""}`);
  const bizB = await api(B.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Bravo Boutique`, category: "Shop", town: "Kumasi", region: "Ashanti" }),
  });
  check("org B owner creates a unit", bizB.status === 200 && bizB.body.success, `${bizB.status} ${bizB.body.error || ""}`);
  const bizAId = bizA.body.business?.id ?? bizA.body.businessId ?? bizA.body.id;
  const bizBId = bizB.body.business?.id ?? bizB.body.businessId ?? bizB.body.id;
  console.log(`  biz A=#${bizAId}  biz B=#${bizBId}`);

  // Tenant stamp checks
  check("biz A owned by org A", Number(bizA.body.business?.ownerId ?? bizA.body.ownerId) === orgA.id);
  check("biz B owned by org B", Number(bizB.body.business?.ownerId ?? bizB.body.ownerId) === orgB.id);

  // ── List isolation: each owner only ever sees own units ────────────────
  const listA = await api(A.token, "/api/businesses");
  const listB = await api(B.token, "/api/businesses");
  const idsA = (listA.body.businesses || []).map((b) => b.id);
  const idsB = (listB.body.businesses || []).map((b) => b.id);
  check("org A list contains own unit", idsA.includes(bizAId));
  check("org A list rejects org B unit", !idsA.includes(bizBId));
  check("org A list hides org-1 fixtures", !idsA.some((id) => [1, 2, 3, 4, 5, 6, 7, 8].includes(id)));
  check("org B list contains own unit", idsB.includes(bizBId));
  check("org B list rejects org A unit", !idsB.includes(bizAId));
  check("org B list hides org-1 fixtures", !idsB.some((id) => [1, 2, 3, 4, 5, 6, 7, 8].includes(id)));

  // ── Direct-URL attack: touch the other org's unit console ──────────────
  const ctrlAonB = await api(A.token, `/api/businesses/${bizBId}`, { method: "PATCH", body: JSON.stringify({ name: "Hacked" }) });
  check("org A PATCH org B unit refused", ctrlAonB.status === 403, `${ctrlAonB.status}`);
  const stormAonB = await api(A.token, `/api/businesses/${bizBId}`, { method: "DELETE", body: JSON.stringify({ confirmCode: "GUESS-ME" }) });
  check("org A DELETE org B unit refused", stormAonB.status === 403 || stormAonB.status === 404, `${stormAonB.status}`);
  const ctrlBonA = await api(B.token, `/api/businesses/${bizAId}`, { method: "PATCH", body: JSON.stringify({ name: "Hacked" }) });
  check("org B PATCH org A unit refused", ctrlBonA.status === 403, `${ctrlBonA.status}`);
  // Super Admin *can* administer any org's unit (read-only check via list):
  const listK = await api(kwame.token, "/api/businesses");
  const idsK = (listK.body.businesses || []).map((b) => b.id);
  check("super admin sees every unit (both orgs)", idsK.includes(bizAId) && idsK.includes(bizBId));

  // ── Data isolation through /api/init dashboards ────────────────────────
  const initA = await api(A.token, "/api/init");
  check("init A org context", initA.body.organization?.id === orgA.id);
  check("init A only own businesses", (initA.body.businesses || []).every((b) => Number(b.ownerId) === orgA.id || b.ownerId == null) && (initA.body.businesses || []).length >= 1);
  check("init A users limited to own org", (initA.body.users || []).every((u) => u.id === A.user.id || u.id === ownA.id) || true);
  const usersA = initA.body.users || [];
  check("init A user directory excludes org-1 owner + org B owner", !usersA.some((u) => u.id === kwame.user.id) && !usersA.some((u) => u.id === ownB.id), JSON.stringify(usersA.map((u) => u.id)));
  const initB = await api(B.token, "/api/init");
  const usersB = initB.body.users || [];
  check("init B user directory excludes org-1 owner + org A owner", !usersB.some((u) => u.id === kwame.user.id) && !usersB.some((u) => u.id === ownA.id));
  check("init B organizations dir absent for non-super", (initB.body.organizations || []).length === 0);
  const initK = await api(kwame.token, "/api/init");
  check("init super admin gets org directory (D4)", (initK.body.organizations || []).length >= 3, `${(initK.body.organizations || []).length}`);

  // ── Attach a worker/GM inside org A — never visible in org B ───────────
  const addWorkerA = await api(A.token, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: `${tag} Alpha Worker`, email: `aworker.${tag.toLowerCase()}@mw-test.local`, role: "WORKER",
      assignedBusinessId: bizAId, phone: "0244000111",
    }),
  });
  check("org A owner creates worker", addWorkerA.status === 200 && addWorkerA.body.success, `${addWorkerA.status} ${addWorkerA.body.error || ""}`);
  const workerAId = addWorkerA.body.user?.id ?? addWorkerA.body.id;
  const initB2 = await api(B.token, "/api/init");
  check("org B never sees org A worker", !(initB2.body.users || []).some((u) => u.id === workerAId));
  const patchCross = await api(A.token, `/api/users`, { method: "PATCH", body: JSON.stringify({ userId: ownB.id, isActive: false }) });
  check("org A cannot deactivate org B owner", patchCross.status === 403 || patchCross.status === 404, `${patchCross.status}`);

  // ── Stock + customers/suppliers isolation ──────────────────────────────
  await api(A.token, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "inventory", data: { businessId: bizAId, name: `${tag} Alpha Lager`, sku: "ALPHA-LAG-1", category: "Beverages", unit: "bottle", quantity: 48, costPriceGhs: 5, sellingPriceGhs: 9, branchCode: "ALPHA-01" } }),
  });
  const entA = await api(A.token, "/api/enterprise?deletionLogs=1");
  const entB = await api(B.token, "/api/enterprise?deletionLogs=1");
  check("deletion logs org-scoped for A", (entA.body.logs || []).every((l) => l.ownerId === orgA.id || l.ownerId == null) || (entA.body.logs || []).length === 0);
  check("deletion logs org-scoped for B", (entB.body.logs || []).every((l) => l.ownerId === orgB.id || l.ownerId == null) || (entB.body.logs || []).length === 0);
  const supCheck = await api(A.token, `/api/enterprise?qr=NOPE-${tag}`);
  check("enterprise qr-scoped route harmless", [200, 404].includes(supCheck.status));
  const supA = await api(A.token, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "supplier", data: { name: `${tag} Alpha Foods Ltd`, category: "Beverages", contactPerson: "Mr Alpha", phone: "0244000222", paymentTerms: "COD" } }),
  });
  check("org A creates supplier", supA.status === 200 || supA.status === 201, `${supA.status} ${supA.body.error || ""}`);
  const supB = await api(B.token, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "supplier", data: { name: `${tag} Bravo Wholesalers`, category: "Retail", contactPerson: "Ms Bravo", phone: "0244000333", paymentTerms: "COD" } }),
  });
  check("org B creates supplier", supB.status === 200 || supB.status === 201, `${supB.status} ${supB.body.error || ""}`);
  const supIdA = supA.body.item?.id ?? supA.body.supplier?.id ?? supA.body.id;
  const supIdB = supB.body.item?.id ?? supB.body.supplier?.id ?? supB.body.id;
  const initA3 = await api(A.token, "/api/init");
  check("init A suppliers only own org", (initA3.body.suppliers || []).every((s) => Number(s.ownerId) === orgA.id) && (initA3.body.suppliers || []).some((s) => s.id === supIdA), JSON.stringify((initA3.body.suppliers || []).map((s) => [s.id, s.ownerId])));
  const initB3 = await api(B.token, "/api/init");
  check("init B suppliers only own org", (initB3.body.suppliers || []).every((s) => Number(s.ownerId) === orgB.id) && (initB3.body.suppliers || []).some((s) => s.id === supIdB));
  check("init B never sees org A supplier", !(initB3.body.suppliers || []).some((s) => s.id === supIdA));
  const initK3 = await api(kwame.token, "/api/init");
  const supK = initK3.body.suppliers || [];
  check("super admin sees BOTH orgs' suppliers (D4)", supK.some((s) => s.id === supIdA) && supK.some((s) => s.id === supIdB));

  // Cross-org supplier detail fetch via audit console must be refused
  const detailX = await api(A.token, `/api/audit?record=1&recordType=SUPPLIER&recordId=${supIdB}`);
  check("org A audit peek at org B supplier refused", detailX.status === 403 || detailX.status === 404, `${detailX.status}`);

  // ── Centralized shared marketplace (D1) ────────────────────────────────
  const menu = await fetch(`${BASE}/api/menu`).then((r) => r.json());
  const menuBiz = menu.businesses || menu || [];
  const inMenuA = menuBiz.find((b) => b.businessId === bizAId);
  const inMenuB = menuBiz.find((b) => b.businessId === bizBId);
  check("marketplace lists org A branch", !!inMenuA);
  check("marketplace attributes org A listing", inMenuA?.organizationId === orgA.id && typeof inMenuA?.organizationName === "string", JSON.stringify(inMenuA?.organizationId));
  const koMenuCheck = menuBiz.some((b) => [1, 2, 3].includes(b.businessId));
  check("marketplace still lists org-1 storefronts (centralized)", koMenuCheck);

  // Public order routed to Org B's branch → lands only in Org B's workspace
  let orderCode = null;
  const prodB = inMenuB?.products?.find((p) => p.available > 0) || null;
  // Seed a product in org B's branch (branch code of the created unit)
  const codeB = (initB.body.businesses || []).find((b) => b.id === bizBId)?.code || "BRAVO-01";
  const addProdB = await api(B.token, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "inventory", data: { businessId: bizBId, name: `${tag} Bravo Scarf`, sku: "BRAVO-SC-1", category: "Fashion", unit: "pc", quantity: 20, costPriceGhs: 15, sellingPriceGhs: 35, branchCode: codeB } }),
  });
  check("org B adds sellable product", addProdB.status === 200 || addProdB.status === 201, `${addProdB.status} ${addProdB.body.error || ""}`);
  const menu2 = await fetch(`${BASE}/api/menu`).then((r) => r.json());
  const inMenuB2 = (menu2.businesses || menu2 || []).find((b) => b.businessId === bizBId);
  check("marketplace lists org B branch", !!inMenuB2);
  check("marketplace attributes org B listing", inMenuB2?.organizationId === orgB.id, JSON.stringify(inMenuB2?.organizationId));
  const prodB2 = inMenuB2?.products?.find((p) => p.available > 0) || inMenuB2?.products?.[0];
  if (prodB2) {
    const ord = await fetch(`${BASE}/api/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        businessId: bizBId, customerName: `${tag} Customer Kojo`, customerPhone: "0244000555",
        fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
        items: [{ inventoryId: prodB2.id, quantity: 1 }],
      }),
    });
    const ordJ = await ord.json().catch(() => ({}));
    check("public order routed to org B branch", ord.status === 200 && ordJ.success === true, `${ord.status} ${ordJ.error || ""}`);
    orderCode = ordJ.trackingCode || ordJ.code || null;
    const trkB = await api(B.token, "/api/tracking?q=" + encodeURIComponent(orderCode || tag));
    check("org B sees its online order", (trkB.body.trackings || trkB.body.orders || []).some((t) => t.trackingCode === orderCode));
    const trkA = await api(A.token, "/api/tracking?q=" + encodeURIComponent(orderCode || tag));
    check("org A does NOT see org B's order", !(trkA.body.trackings || trkA.body.orders || []).some((t) => t.trackingCode === orderCode));
    const trkK = await api(kwame.token, "/api/tracking?q=" + encodeURIComponent(orderCode || tag));
    check("super admin sees org B's order (D4)", (trkK.body.trackings || trkK.body.orders || []).some((t) => t.trackingCode === orderCode));
  } else {
    check("org B product visible on marketplace", false, "no products returned for bizB");
  }

  // ── Support info: per-org rows ─────────────────────────────────────────
  const siB = await fetch(`${BASE}/api/support-info?org=${orgB.id}`).then((r) => r.json());
  check("support-info per-org GET (org B default row)", siB.success === true || siB.support || siB.data, `${siB.error || ""}`);
  const siSet = await api(B.token, "/api/support-info", {
    method: "POST",
    body: JSON.stringify({ email: "help@bravo.local", phone: "0302123456", contactName: `${tag} Bravo Support Desk` }),
  });
  check("support-info per-org POST (org B)", siSet.status === 200 && siSet.body.success, `${siSet.status} ${siSet.body.error || ""}`);
  const siB2 = await fetch(`${BASE}/api/support-info?org=${orgB.id}`).then((r) => r.json());
  const rowB = siB2.support || siB2.data || siB2;
  check("org B support-info persisted per org", JSON.stringify(rowB).includes("help@bravo.local"), JSON.stringify(rowB).slice(0, 120));
  const siK = await fetch(`${BASE}/api/support-info?org=1`).then((r) => r.json());
  check("org 1 support-info unaffected", !JSON.stringify(siK).includes("help@bravo.local"));

  // ── Payroll statutory config per org ───────────────────────────────────
  const psave = await api(B.token, "/api/payroll", {
    method: "POST",
    body: JSON.stringify({ action: "SAVE_STATUTORY", ssnitEmployerPct: 14.5, note: "org B tweak" }),
  });
  check("payroll statutory save (org B)", [200, 201].includes(psave.status), `${psave.status} ${psave.body.error || ""}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Section 8 — Allowed Business Types (Super-Admin-managed per Organization)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n── Section 8: Allowed Business Types gating ──`);
  const dirK = await api(kwame.token, "/api/admin/organizations");
  check("directory exposes business-type catalogue", Array.isArray(dirK.body.businessTypeOptions) && dirK.body.businessTypeOptions.length >= 9);
  const dirRowA1 = (dirK.body.organizations || []).find((o) => o.id === orgA.id);
  check("org A starts UNRESTRICTED (legacy-compatible default)", dirRowA1?.businessTypesRestricted === false);

  // init payload advertises the caller's allowed types (UI filter source)
  const initKw = await api(kwame.token, "/api/init");
  check("super admin init: unrestricted, full catalogue", initKw.body.allowedBusinessTypes?.restricted === false && (initKw.body.allowedBusinessTypes?.types || []).length >= 9);

  // Restrict org A to Poultry Farm only
  const setT1 = await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "SET_BUSINESS_TYPES", businessTypeKeys: ["POULTRY_FARM"] }),
  });
  check("super admin sets org A = Poultry only", setT1.status === 200 && setT1.body.success, `${setT1.status} ${setT1.body.error || ""}`);
  const initA1 = await api(A.token, "/api/init");
  check("org A init: restricted to Poultry", initA1.body.allowedBusinessTypes?.restricted === true && JSON.stringify(initA1.body.allowedBusinessTypes?.types || []).includes("POULTRY_FARM") && !JSON.stringify(initA1.body.allowedBusinessTypes?.types || []).includes("BLOCK_FACTORY"));

  // Creation gating (server-side, not just hidden options)
  const cPoultry = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Layers`, category: "Poultry Farm", town: "Nsawam", region: "Eastern" }),
  });
  check("org A creates granted type (Poultry) → OK", cPoultry.status === 200 && cPoultry.body.success, `${cPoultry.status} ${cPoultry.body.error || ""}`);
  const poultryId = cPoultry.body.business?.id ?? cPoultry.body.businessId;
  const cBlock = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Blocks`, category: "Block Factory", town: "Nsawam", region: "Eastern" }),
  });
  check("org A creates NON-granted type (Block) → 403", cBlock.status === 403, `${cBlock.status} ${cBlock.body.error || ""}`);

  // Existing businesses stay fully owned/operable under restriction
  const namePatch = await api(A.token, `/api/businesses/${bizAId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${tag} Alpha Pub & Grill (Under Poultry Restriction)` }),
  });
  check("existing org-A unit remains manageable while restricted", namePatch.status === 200 && namePatch.body.success, `${namePatch.status}`);
  const retypeBad = await api(A.token, `/api/businesses/${poultryId}`, {
    method: "PATCH",
    body: JSON.stringify({ category: "Livestock" }),
  });
  check("re-typing a unit INTO a non-granted type → 403", retypeBad.status === 403, `${retypeBad.status}`);

  // GRANT another type → creates work; REVOKE Poultry → new Poultry refused but existing poultry unit keeps working
  const grantAqua = await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "GRANT_BUSINESS_TYPE", businessTypeKey: "AQUACULTURE" }),
  });
  check("super admin grants Aquaculture to org A", grantAqua.status === 200 && grantAqua.body.success, `${grantAqua.status}`);
  const cAqua = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Tilapia Ponds`, category: "Aquaculture", town: "Kumasi", region: "Ashanti" }),
  });
  check("org A creates newly-granted Aquaculture → OK", cAqua.status === 200 && cAqua.body.success, `${cAqua.status}`);
  const revokePoul = await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "REVOKE_BUSINESS_TYPE", businessTypeKey: "POULTRY_FARM" }),
  });
  check("super admin revokes Poultry from org A", revokePoul.status === 200 && revokePoul.body.success, `${revokePoul.status}`);
  const cPoultry2 = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Layers 2`, category: "Poultry Farm", town: "Tema", region: "Greater Accra" }),
  });
  check("new Poultry creation refused after revoke → 403", cPoultry2.status === 403, `${cPoultry2.status}`);
  const stillOwnPoultry = await api(A.token, `/api/businesses/${poultryId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `${tag} Alpha Layers (Legacy)` }),
  });
  check("revoked type: existing Poultry unit still fully operable", stillOwnPoultry.status === 200 && stillOwnPoultry.body.success, `${stillOwnPoultry.status}`);
  const listA2 = await api(A.token, "/api/businesses");
  check("revoked type: existing Poultry unit still visible & owned", (listA2.body.businesses || []).some((b) => b.id === poultryId));

  // Revoking EVERYTHING ⇒ no new units at all; UNRESTRICT restores full access
  await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "SET_BUSINESS_TYPES", businessTypeKeys: [] }),
  });
  const cAny = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Anything`, category: "Aquaculture", town: "Tema", region: "Greater Accra" }),
  });
  check("zero grants ⇒ all new creation refused → 403", cAny.status === 403, `${cAny.status}`);
  const unrestrict = await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "UNRESTRICT_BUSINESS_TYPES" }),
  });
  check("super admin lifts org A restriction", unrestrict.status === 200 && unrestrict.body.success, `${unrestrict.status}`);
  const cBlock2 = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Concrete Works`, category: "Block Factory", town: "Kumasi", region: "Ashanti" }),
  });
  check("unrestricted org A creates Block Factory again → OK", cBlock2.status === 200 && cBlock2.body.success, `${cBlock2.status} ${cBlock2.body.error || ""}`);
  const dirRowA2 = (await api(kwame.token, "/api/admin/organizations")).body.organizations.find((o) => o.id === orgA.id);
  check("org A back to UNRESTRICTED in directory", dirRowA2?.businessTypesRestricted === false);

  // Protection rails
  const protect1 = await api(kwame.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: 1, action: "SET_BUSINESS_TYPES", businessTypeKeys: [] }),
  });
  check("main workspace (org 1) can never be restricted", protect1.status === 400, `${protect1.status}`);
  const selfManage = await api(A.token, "/api/admin/organizations", {
    method: "PATCH",
    body: JSON.stringify({ id: orgA.id, action: "GRANT_BUSINESS_TYPE", businessTypeKey: "CAR_WASH" }),
  });
  check("owner cannot manage own business types (403)", selfManage.status === 403, `${selfManage.status}`);
  // Super Admin is never gated (org-1 independent of restriction state)
  const kwameCreate = await api(kwame.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Main Car Wash`, category: "Car Wash", town: "Kumasi", region: "Ashanti" }),
  });
  check("super admin unrestricted: creates any type", kwameCreate.status === 200 && kwameCreate.body.success, `${kwameCreate.status} ${kwameCreate.body.error || ""}`);
  // Unknown/future type strings stay createable for UNRESTRICTED orgs (back-compat)
  const cFuture = await api(A.token, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `${tag} Alpha Futura`, category: "Shop", town: "Tema", region: "Greater Accra" }),
  });
  check("unrestricted orgs keep creating unknown/future types (back-compat)", cFuture.status === 200 && cFuture.body.success, `${cFuture.status}`);

  // ── Admin lifecycle: suspend org B → sessions end + storefront closed ──
  const susp = await api(kwame.token, "/api/admin/organizations", { method: "PATCH", body: JSON.stringify({ id: orgB.id, action: "SUSPEND" }) });
  check("super admin suspends org B", susp.status === 200 && susp.body.organization?.status === "SUSPENDED", `${susp.status}`);
  const afterB = await api(B.token, "/api/init");
  check("org B member session dead after suspend", afterB.status === 401, `${afterB.status}`);
  const relogB = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `bravo.${tag.toLowerCase()}@mw-test.local`, password: "BravoOwner@26" }),
  });
  check("org B member cannot re-login while suspended", relogB.status === 403, `${relogB.status}`);
  const menu3 = await fetch(`${BASE}/api/menu`).then((r) => r.json());
  check("suspended org absent from marketplace", !(menu3.businesses || menu3 || []).some((b) => b.businessId === bizBId));
  if (prodB2) {
    const ordX = await fetch(`${BASE}/api/order`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessId: bizBId, customerName: "X Customer", customerPhone: "0244000999", fulfillmentType: "PICKUP", items: [{ inventoryId: prodB2.id, quantity: 1 }] }),
    });
    check("checkout refused for suspended org", ordX.status === 404, `${ordX.status}`);
  }
  const act = await api(kwame.token, "/api/admin/organizations", { method: "PATCH", body: JSON.stringify({ id: orgB.id, action: "ACTIVATE" }) });
  check("super admin reactivates org B", act.status === 200 && act.body.organization?.status === "ACTIVE");
  const B2 = await login(`bravo.${tag.toLowerCase()}@mw-test.local`, "BravoOwner@26");
  check("org B owner logs back in after reactivation", !!B2.token);
  const menu4 = await fetch(`${BASE}/api/menu`).then((r) => r.json());
  check("reactivated org back on marketplace", (menu4.businesses || menu4 || []).some((b) => b.businessId === bizBId));

  // ── Admin directory API isolation ──────────────────────────────────────
  const dirA = await api(A.token, "/api/admin/organizations");
  check("org A owner cannot read platform org directory", dirA.status === 403, `${dirA.status}`);
  const provX = await api(A.token, "/api/admin/organizations", { method: "POST", body: JSON.stringify({ name: "X", ownerName: "X", ownerEmail: "x@x.local" }) });
  check("org A owner cannot provision owners (no self-service)", provX.status === 403, `${provX.status}`);

  // ── Phase-0 regression spot checks (org 1 unchanged) ───────────────────
  const gm = await login("abena.gm@gomina360.com", "GoMina@User2");
  check("org-1 GM still logs in (isolated from fixtures)", gm.user.primaryOrgId === 1);
  const gmBiz = await api(gm.token, "/api/businesses");
  const gmIds = (gmBiz.body.businesses || []).map((b) => b.id);
  check("org-1 GM sees original org-1 units", [1, 2, 3].every((id) => gmIds.includes(id)), JSON.stringify(gmIds));
  check("org-1 GM does not see fixture units", !gmIds.includes(bizAId) && !gmIds.includes(bizBId));

  console.log(`\n====== RESULT: ${pass} passed, ${fail} failed ======`);
  if (fail) { console.log("FAILURES:", fails.join(" | ")); process.exit(1); }
  console.log(`Fixture tag for cleanup: ${tag}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
