import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, fulfillmentMethods, fulfillmentOptions, inventoryItems, organizations, suppliers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { canAccessBusiness, filterByAccess, accessibleBusinessIds, getSessionInfo } from "@/lib/auth";
import { DEFAULT_FULFILLMENT_METHODS, ensureDefaultMethods } from "@/lib/preorder";
import { ownerOrgOfBusiness } from "@/lib/notify";

/** GET: scoped catalogue — fulfillment methods + options (staff). */
export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    const me = session.user;
    const url = new URL(request.url);
    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;

    const allowed = await accessibleBusinessIds(me);
    let methodRows = await db.select().from(fulfillmentMethods);
    let optionRows = await db.select().from(fulfillmentOptions);
    // Tenant scope: org-wide methods (businessId null) belong to MY orgs.
    const myOrgIds: number[] = Array.isArray(me.organizationIds) ? me.organizationIds.map(Number) : [];
    if (!me.isSuperAdmin) {
      methodRows = methodRows.filter((m) => myOrgIds.includes(Number(m.ownerId)));
      optionRows = optionRows.filter((o) => myOrgIds.includes(Number(o.ownerId)) || filterByAccess([{ businessId: o.businessId }], allowed).length > 0);
    }
    if (bizFilter) optionRows = optionRows.filter((o) => Number(o.businessId) === bizFilter);

    const invIds = [...new Set(optionRows.map((o) => o.inventoryId))];
    const invRows = invIds.length ? await db.select().from(inventoryItems) : [];
    const byInv = new Map(invRows.map((i) => [i.id, i]));

    // Per-unit enable state (drives the setup toggle next to the unit picker).
    const bizAll = await db.select().from(businesses);
    const scopeSet = allowed === null ? null : new Set(allowed);
    const preorderFlags = bizAll
      .filter((b) => (scopeSet == null ? true : scopeSet.has(Number(b.id))))
      .map((b) => ({ businessId: b.id, businessName: b.name, businessCode: b.code, preOrderEnabled: b.preOrderEnabled === true, onlineOrderingEnabled: b.onlineOrderingEnabled !== false }));

    // Scoped inventory list for the option editor: only units the caller
    // actually sees, only the fields the setup dropdown needs. When a
    // business filter is on the URL, restrict to that unit's items.
    const scopedScope = allowed === null ? null : new Set(allowed);
    const allInvRows = await db.select().from(inventoryItems);
    const inventory = allInvRows
      .filter((i) => (scopedScope == null ? true : scopedScope.has(Number(i.businessId))))
      .filter((i) => (bizFilter ? Number(i.businessId) === bizFilter : true))
      .map((i) => ({ id: i.id, businessId: i.businessId, name: i.name, sku: i.sku, quantity: i.quantity, status: i.status, unitPriceGhs: i.sellingPriceGhs, category: i.category }));

    // Suppliers the caller may link to options / purchase orders (org-scoped).
    let supplierRows = await db.select().from(suppliers);
    if (!me.isSuperAdmin) {
      supplierRows = supplierRows.filter((sp) => myOrgIds.includes(Number(sp.ownerId ?? -1)));
    }
    const suppliersOut = supplierRows.map((sp) => ({
      id: sp.id,
      name: sp.name,
      category: sp.category,
      contactPhone: sp.phone,
      contactPerson: sp.contactPerson,
      paymentTerms: sp.paymentTerms,
    }));

    return NextResponse.json({
      success: true,
      methods: methodRows.map((m) => ({
        id: m.id,
        key: m.key,
        label: m.label,
        icon: m.icon,
        businessId: m.businessId,
        defaultLeadMinDays: m.defaultLeadMinDays,
        defaultLeadMaxDays: m.defaultLeadMaxDays,
        requiresAddress: m.requiresAddress,
        requiresPin: m.requiresPin,
        sortOrder: m.sortOrder,
        active: m.active,
      })),
      options: optionRows.map((o) => {
        const inv = byInv.get(o.inventoryId);
        return {
          ...o,
          inventoryName: inv?.name || null,
          inventorySku: inv?.sku || null,
          inventoryQuantity: inv?.quantity ?? null,
        };
      }),
      defaults: DEFAULT_FULFILLMENT_METHODS,
      inventory,
      suppliers: suppliersOut,
      preorderFlags,
    });
  } catch (error: any) {
    console.error("GET /api/fulfillment error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/** POST: manage methods + options. Actions:
 *  SEED_DEFAULTS { businessId } — plant the standard set (idempotent)
 *  ADD_METHOD / UPDATE_METHOD { ... }
 *  ADD_OPTION / UPDATE_OPTION / TOGGLE_OPTION { ... }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return NextResponse.json({ success: false, error: "Sign in required." }, { status: 401 });
    const me = session.user;
    const body = await request.json();
    const action = String(body.action || "").toUpperCase();
    const businessId = Number(body.businessId);
    if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
    if (!(await canAccessBusiness(me, businessId))) {
      return NextResponse.json({ success: false, error: "You cannot manage this unit." }, { status: 403 });
    }
    const ownerOrg = await ownerOrgOfBusiness(businessId);
    const [biz] = await db.select().from(organizations).where(eq(organizations.id, ownerOrg ?? -1));
    if (biz && (biz.status || "").toUpperCase() === "SUSPENDED") {
      return NextResponse.json({ success: false, error: "Organization is suspended." }, { status: 403 });
    }

    if (action === "SEED_DEFAULTS") {
      await ensureDefaultMethods(ownerOrg, me);
      return NextResponse.json({ success: true });
    }

    if (action === "ADD_METHOD" || action === "UPDATE_METHOD") {
      const key = String(body.key || "").trim().toUpperCase().slice(0, 30);
      const label = String(body.label || "").trim().slice(0, 80);
      if (!key || !label) return NextResponse.json({ success: false, error: "key and label are required." }, { status: 400 });
      const icon = String(body.icon || "truck").slice(0, 30);
      const dmin = Math.max(0, Math.min(365, Number(body.defaultLeadMinDays ?? 7) || 0));
      const dmax = Math.max(dmin, Math.min(365, Number(body.defaultLeadMaxDays ?? 14) || 0));
      const methodBusinessId = body.businessScoped ? businessId : null;
      if (action === "ADD_METHOD") {
        const clash = await db
          .select({ id: fulfillmentMethods.id })
          .from(fulfillmentMethods)
          .where(and(eq(fulfillmentMethods.ownerId, ownerOrg ?? -1), eq(fulfillmentMethods.key, key)));
        if (clash.length) return NextResponse.json({ success: false, error: `Method "${key}" already exists.` }, { status: 409 });
        const [created] = await db
          .insert(fulfillmentMethods)
          .values({
            ownerId: ownerOrg ?? 1,
            businessId: methodBusinessId,
            key,
            label,
            icon,
            defaultLeadMinDays: dmin,
            defaultLeadMaxDays: dmax,
            requiresAddress: Boolean(body.requiresAddress),
            requiresPin: Boolean(body.requiresPin),
            sortOrder: Number(body.sortOrder) || 0,
            createdByUserId: me.id ?? null,
            createdByName: me.name || "Staff",
          })
          .returning();
        return NextResponse.json({ success: true, method: created });
      }
      const id = Number(body.id);
      // TENANT SCOPE: the method must belong to the caller's org (and to a
      // unit the caller can manage when it's unit-scoped). Without this a
      // signed-in user of org B could rewrite org A's fulfilment methods.
      const [existing] = await db.select().from(fulfillmentMethods).where(eq(fulfillmentMethods.id, id));
      if (!existing || Number(existing.ownerId) !== Number(ownerOrg)) {
        return NextResponse.json({ success: false, error: "Method not found." }, { status: 404 });
      }
      if (existing.businessId != null && !(await canAccessBusiness(me, Number(existing.businessId)))) {
        return NextResponse.json({ success: false, error: "You cannot manage this unit." }, { status: 403 });
      }
      const [row] = await db
        .update(fulfillmentMethods)
        .set({
          label,
          icon,
          defaultLeadMinDays: dmin,
          defaultLeadMaxDays: dmax,
          requiresAddress: Boolean(body.requiresAddress),
          requiresPin: Boolean(body.requiresPin),
          sortOrder: Number(body.sortOrder) || 0,
          active: Boolean(body.active),
          updatedAt: new Date(),
        })
        .where(eq(fulfillmentMethods.id, id))
        .returning();
      if (!row) return NextResponse.json({ success: false, error: "Method not found." }, { status: 404 });
      return NextResponse.json({ success: true, method: row });
    }

    if (["ADD_OPTION", "UPDATE_OPTION", "TOGGLE_OPTION"].includes(action)) {
      // Pre-orders are a per-unit ON-flag controlled by the OWNER. Adding or
      // editing options on a unit that hasn't opted in is refused with the
      // guidance to enable it first (toggle in Setup or Manage Businesses).
      // TOGGLE is exempt so existing options can always be switched OFF,
      // including after the owner flipped pre-orders off.
      if (action !== "TOGGLE_OPTION") {
        const [bizCheck] = await db.select().from(businesses).where(eq(businesses.id, businessId));
        if (bizCheck && bizCheck.preOrderEnabled !== true) {
          return NextResponse.json(
            { success: false, error: "Pre-Orders are not enabled for this unit. Turn the “Pre-Orders Enabled” switch ON first — in Setup (above) or Manage Businesses." },
            { status: 409 },
          );
        }
      }
      if (action === "TOGGLE_OPTION") {
        const id = Number(body.id);
        const [row] = await db.select().from(fulfillmentOptions).where(eq(fulfillmentOptions.id, id));
        if (!row) return NextResponse.json({ success: false, error: "Option not found." }, { status: 404 });
        if (!(await canAccessBusiness(me, Number(row.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
        const [upd] = await db
          .update(fulfillmentOptions)
          .set({ active: !row.active, updatedAt: new Date() })
          .where(eq(fulfillmentOptions.id, id))
          .returning();
        return NextResponse.json({ success: true, option: upd });
      }

      const inventoryId = Number(body.inventoryId);
      const methodId = Number(body.methodId);
      const priceGhs = Math.max(0, Number(body.priceGhs) || 0);
      const leadMin = Math.max(0, Math.min(365, Number(body.leadMinDays) || 0));
      const leadMax = Math.max(leadMin, Math.min(365, Number(body.leadMaxDays) || 0));
      if (!inventoryId || !methodId || !(priceGhs > 0)) {
        return NextResponse.json({ success: false, error: "inventoryId, methodId and price are required." }, { status: 400 });
      }
      const [inv] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inventoryId));
      if (!inv || Number(inv.businessId) !== businessId) {
        return NextResponse.json({ success: false, error: "The product must belong to this unit's stock catalogue." }, { status: 400 });
      }
      const [meth] = await db.select().from(fulfillmentMethods).where(eq(fulfillmentMethods.id, methodId));
      if (!meth || Number(meth.ownerId) !== ownerOrg) {
        return NextResponse.json({ success: false, error: "That fulfilment method does not belong to your organization." }, { status: 400 });
      }
      if (meth.active === false) {
        return NextResponse.json({ success: false, error: "That fulfilment method is disabled — enable it first." }, { status: 400 });
      }
      // Preferred supplier (optional): must belong to the SAME org — cross-
      // tenant supplier binding is rejected, missing id maps to NULL.
      let supplierId: number | null = null;
      if (body.supplierId != null && body.supplierId !== "") {
        const sid = Number(body.supplierId);
        const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, sid));
        if (!sup || Number(sup.ownerId ?? -1) !== Number(ownerOrg)) {
          return NextResponse.json({ success: false, error: "That supplier does not belong to your organization." }, { status: 400 });
        }
        supplierId = sid;
      }
      const depType = ["NONE", "PERCENT", "FIXED"].includes(body.depositType) ? body.depositType : "NONE";
      let depVal = Math.max(0, Number(body.depositValue) || 0);
      if (depType === "PERCENT") depVal = Math.min(100, depVal);
      const termsKey = body.termsKey === "ON_ARRIVAL" ? "ON_ARRIVAL" : "ON_FULFILLMENT";
      if (action === "ADD_OPTION") {
        const clash = await db
          .select({ id: fulfillmentOptions.id })
          .from(fulfillmentOptions)
          .where(and(eq(fulfillmentOptions.inventoryId, inventoryId), eq(fulfillmentOptions.methodId, methodId), eq(fulfillmentOptions.active, true)));
        if (clash.length)
          return NextResponse.json({ success: false, error: "This product already has an active option for that method — edit it instead." }, { status: 409 });
        const [created] = await db
          .insert(fulfillmentOptions)
          .values({
            ownerId: ownerOrg ?? 1,
            inventoryId,
            methodId,
            businessId,
            branchCode: body.branchCode || inv.branchCode || null,
            priceGhs,
            leadMinDays: leadMin,
            leadMaxDays: leadMax,
            depositType: depType,
            depositValue: depVal,
            termsKey,
            capacityPerPeriod: body.capacityPerPeriod != null ? Math.max(0, Number(body.capacityPerPeriod) || 0) : null,
            supplierId,
            requiresAddress: body.requiresAddress == null ? null : Boolean(body.requiresAddress),
            sortOrder: Number(body.sortOrder) || 0,
            createdByUserId: me.id ?? null,
            createdByName: me.name || "Staff",
          })
          .returning();
        return NextResponse.json({ success: true, option: created });
      }
      const id = Number(body.id);
      const [row] = await db.select().from(fulfillmentOptions).where(eq(fulfillmentOptions.id, id));
      if (!row) return NextResponse.json({ success: false, error: "Option not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(row.businessId)))) return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
      const [upd] = await db
        .update(fulfillmentOptions)
        .set({
          priceGhs,
          leadMinDays: leadMin,
          leadMaxDays: leadMax,
          depositType: depType,
          depositValue: depVal,
          termsKey,
          capacityPerPeriod: body.capacityPerPeriod != null ? Math.max(0, Number(body.capacityPerPeriod) || 0) : null,
          supplierId,
          requiresAddress: body.requiresAddress == null ? null : Boolean(body.requiresAddress),
          sortOrder: Number(body.sortOrder) || 0,
          active: Boolean(body.active),
          updatedAt: new Date(),
        })
        .where(eq(fulfillmentOptions.id, id))
        .returning();
      return NextResponse.json({ success: true, option: upd });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    console.error("POST /api/fulfillment error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
