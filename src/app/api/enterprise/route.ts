const origError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String((a && a.message) ? a.message : a)).join(" | ");
  if (/permission|PERMISSION|Configuration Database|ERR_INSUFFICIENT/i.test(s)) {
    origError("####APPERROR#### " + s.slice(0, 500) + " ####END####");
    try { origError("####APPSTACK#### " + String(args[0] && args[0].stack || new Error("stackprobe").stack).slice(0, 800) + " ####END####"); } catch {}
  }
  return origError(...args);
};
import { NextResponse } from "next/server";
import { createEmployeeRecord } from "@/lib/employeeCreate";
import { normalizeInventoryCategory, deriveInventorySubcategory } from "@/lib/inventoryCategories";
import { db } from "@/db";
import { ttlInvalidate } from "@/lib/ttlCache";
import {
  employees,
  assets,
  assetAuditLogs,
  inventoryItems,
  customers,
  suppliers,
  businesses,
  recordDeletionLogs,
} from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyStockChange, computeStockStatus } from "@/lib/stock";
import { adjustVariantStock, setVariantsForItem, variantsForItem } from "@/lib/boutique";
import { normalizeVariantMatrix } from "@/lib/boutiqueSizes";
import { canManageSharedRecords, canDeleteInventory, canManageBusinessUnit } from "@/lib/recordPermissions";
import { canSeeFinancials } from "@/lib/permissions";
import { getSessionInfo, canAccessBusiness, accessibleBusinessIds, resolveUserOrgIds, businessIdsOfOrgs, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";
import { approvalGateCheck, createApprovalRequest } from "@/lib/approvals";
import { auditEvent } from "@/lib/audit";
import { approvalRequests } from "@/db/schema";
import { validateImageArray, validateOptionalImage, THUMB_BUDGET_BYTES } from "@/lib/mediaValidation";

/** A currency figure inside a stored label: keeps the text, drops the number. */
const GHS_FIGURE_RE = /(GH₵|GHS|₵)\s*[\d,]+(?:\.\d+)?/g;

// Which enterprise entity a deletion-log row refers to.
const MODULE_TABLE: Record<string, any> = {
  SUPPLIERS: suppliers,
  EMPLOYEES: employees,
  INVENTORY: inventoryItems,
  CUSTOMERS: customers,
};

/**
 * GET /api/enterprise?deletionLogs=1&module=SUPPLIERS
 * Returns the immutable deletion audit trail (user, date, time, reason,
 * record snapshot) for a shared module.
 */
export async function GET(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);

    // ── QR registry lookup (camera scanner on Inventory & Assets) ──────
    // /api/enterprise?qr=<content> → { found, kind: "inventory"|"asset", record }
    // Scoped to the businesses the caller is allowed to see.
    const qrRaw = searchParams.get("qr");
    if (qrRaw !== null) {
      const code = qrRaw.trim();
      if (!code) return NextResponse.json({ success: true, found: false });
      const allowed = await accessibleBusinessIds(session.user); // null ⇒ see all
      const canSee = (bizId: number | null | undefined) =>
        allowed == null || (bizId != null && allowed.includes(bizId));
      // QR labels are unique PER BUSINESS: two independent organizations may
      // legitimately carry the same label value (their unit codes can match).
      // Resolve the caller's accessible match — not just the first global row.
      //
      // A platform super admin (allowed == null) can see every match, so with
      // several candidates the row order would decide which unit answers the
      // scan. Prefer the caller's own organization first, then fall back to the
      // first accessible match — scanning your own label always returns your
      // own item, never another org's.
      const ownOrgBizIds = async (): Promise<Set<number>> => {
        const orgIds = await resolveUserOrgIds(session.user);
        return new Set(orgIds.length ? (await businessIdsOfOrgs(orgIds)).map(Number) : []);
      };
      const pick = async (rows: any[]) => {
        const visible = rows.filter((r: any) => canSee(r.businessId));
        if (visible.length <= 1) return visible[0];
        const own = await ownOrgBizIds();
        return visible.find((r: any) => own.has(Number(r.businessId))) ?? visible[0];
      };
      const itemRows = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.qrCode, code));
      const item = await pick(itemRows);
      if (item) {
        return NextResponse.json({ success: true, found: true, kind: "inventory", record: item });
      }
      const assetRows = await db
        .select()
        .from(assets)
        .where(eq(assets.qrCode, code));
      const asset = await pick(assetRows);
      if (asset) {
        return NextResponse.json({ success: true, found: true, kind: "asset", record: asset });
      }
      return NextResponse.json({ success: true, found: false });
    }

    if (searchParams.get("deletionLogs") !== "1") {
      return NextResponse.json(
        { success: false, error: "Unsupported query." },
        { status: 400 }
      );
    }
    const module = (searchParams.get("module") || "").toUpperCase();
    let rows = await db
      .select()
      .from(recordDeletionLogs)
      .orderBy(desc(recordDeletionLogs.id))
      .limit(50);
    if (module) rows = rows.filter((r) => r.module === module);
    // Tenant scope: the deletion audit is per-Owner — the Super Admin sees all.
    if (!session.user.isSuperAdmin) {
      const myOrgs = new Set(session.user.organizationIds || []);
      rows = rows.filter((r) => r.ownerId != null && myOrgs.has(Number(r.ownerId)));
    }

    // A deletion log must stay ACTIONABLE for everyone who can see it — the
    // record, who, when and why are the whole point of the trail — but the
    // label a money-module deletion stores carries the amount with it
    // ("TRX-2026-49170696 — GH₵ 123 (ProbeCat)"). That made the immutable
    // deletion trail a way around the financial gate for any manager who can
    // open a module's audit panel. Strip the figure, keep the record.
    if (!canSeeFinancials(session.user)) {
      rows = rows.map((r: any) => ({
        ...r,
        recordLabel: r.recordLabel ? String(r.recordLabel).replace(GHS_FIGURE_RE, "$1 •••••") : r.recordLabel,
      }));
    }

    return NextResponse.json({ success: true, logs: rows });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * PATCH /api/enterprise — edit a supplier, employee or inventory record.
 * OWNER always allowed; other users only with the OWNER-granted flag
 * (canManageRecords for SUPPLIERS/EMPLOYEES, canDeleteInventory for
 * INVENTORY), resolved server-side from the database.
 */
/**
 * Sanitize the rich product-catalogue JSONB fields (specifications, variants)
 * before they touch the database: bounded arrays of trimmed string pairs —
 * junk entries are dropped, never allowed to break stock registration.
 */
function sanitizeSpecList(v: any): { key: string; value: string }[] | null {
  if (v == null) return null;
  const out: { key: string; value: string }[] = [];
  for (const row of Array.isArray(v) ? v : []) {
    const k = String(row?.key ?? "").trim().slice(0, 60);
    const val = String(row?.value ?? "").trim().slice(0, 200);
    if (k && val) out.push({ key: k, value: val });
    if (out.length >= 30) break;
  }
  return out;
}
/** R3 CRM — customer preferences JSONB: at most 20 trimmed key/value string
 *  pairs (40-char keys, 200-char values). Junk keys are dropped. */
function sanitizeCustomerPreferences(v: any): Record<string, string> | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, 20)) {
    const key = String(k).trim().slice(0, 40);
    if (!key) continue;
    const s = String(val ?? "").trim().slice(0, 200);
    if (s) out[key] = s;
  }
  return out;
}
function sanitizeVariantList(v: any): { name: string; note?: string }[] | null {
  if (v == null) return null;
  const out: { name: string; note?: string }[] = [];
  for (const row of Array.isArray(v) ? v : []) {
    const n = String(row?.name ?? "").trim().slice(0, 80);
    const note = String(row?.note ?? "").trim().slice(0, 200);
    if (n) out.push(note ? { name: n, note } : { name: n });
    if (out.length >= 30) break;
  }
  return out;
}

export async function PATCH(request: Request) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  try {
    const body = await request.json();
    // F-15: `actorUserId` was destructured here and never used — every audit
    // write below takes the session actor (`actor`). Deleted so the binding
    // cannot be re-wired by a later edit; the guard fails if it returns.
    const { entityType, id, data } = body || {};
    const moduleKey = String(entityType || "").toUpperCase();
    const table = MODULE_TABLE[moduleKey];
    if (!table) {
      return NextResponse.json(
        { success: false, error: "entityType must be SUPPLIERS, EMPLOYEES, INVENTORY or CUSTOMERS." },
        { status: 400 }
      );
    }
    const recordId = Number(id);
    if (!Number.isFinite(recordId)) {
      return NextResponse.json(
        { success: false, error: "Valid record id is required." },
        { status: 400 }
      );
    }

    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const actor = session.user;

    const [existing] = await db.select().from(table).where(eq(table.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Record not found." },
        { status: 404 }
      );
    }

    // Inventory entries are permission-gated separately (delete-inventory
    // permission); suppliers/employees/customers follow the shared-record
    // flag. A user
    // the OWNER granted "Manage Business / Unit" power for the record's unit
    // may always edit — owner-equivalent, scoped to that unit only.
    const unitManager = canManageBusinessUnit(actor, existing.businessId);
    const permitted =
      moduleKey === "INVENTORY"
        ? canDeleteInventory(actor) || unitManager
        : canManageSharedRecords(actor) || unitManager;
    if (!permitted) {
      return NextResponse.json(
        {
          success: false,
          error:
            moduleKey === "INVENTORY"
              ? "Not permitted — only the OWNER (or a manager the OWNER has granted the delete-inventory permission) can edit inventory entries."
              : "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can edit records.",
        },
        { status: 403 }
      );
    }

    // Tenant boundary: capability flags never cross organizations.
    if (!actor.isSuperAdmin) {
      if (moduleKey === "SUPPLIERS" || moduleKey === "CUSTOMERS") {
        // Organization boundary first (customers carry an ownerId stamp)…
        if (existing.ownerId != null && !(actor.organizationIds || []).includes(Number(existing.ownerId))) {
          return FORBIDDEN(`That ${moduleKey === "SUPPLIERS" ? "supplier" : "customer"} belongs to a different organization.`);
        }
        // …then business isolation for unit-stamped customers. Shared rows
        // (businessId NULL, e.g. legacy enterprise-wide clients) resolve to
        // OWNER-only via canAccessBusiness(NULL).
        if (moduleKey === "CUSTOMERS" && !(await canAccessBusiness(actor, existing.businessId))) {
          return FORBIDDEN("That customer belongs to a business you cannot access.");
        }
      } else if (!(await canAccessBusiness(actor, existing.businessId))) {
        return FORBIDDEN("That record belongs to a business you cannot access.");
      }
    }

    const d = data || {};
    const updates: Record<string, any> = {};
    // Set when a variant-targeted quantity edit was applied (the item total is
    // DERIVED from the rows, so `updates` legitimately stays empty).
    let variantQuantityApplied = false;
    // Reassignment to a different business must stay inside the actor's scope.
    if (moduleKey !== "SUPPLIERS" && d.businessId !== undefined && Number(d.businessId) && Number(d.businessId) !== Number(existing.businessId)) {
      if (!(await canAccessBusiness(actor, Number(d.businessId)))) {
        return FORBIDDEN("You cannot move that record to a business you cannot access.");
      }
    }
    if (moduleKey === "SUPPLIERS") {
      if (typeof d.name === "string" && d.name.trim()) updates.name = d.name.trim();
      if (typeof d.category === "string" && d.category.trim()) updates.category = d.category.trim();
      if (typeof d.contactPerson === "string" && d.contactPerson.trim()) updates.contactPerson = d.contactPerson.trim();
      if (typeof d.phone === "string" && d.phone.trim()) updates.phone = d.phone.trim();
      if (typeof d.email === "string") updates.email = d.email.trim() || null;
      if (typeof d.paymentTerms === "string" && d.paymentTerms.trim()) updates.paymentTerms = d.paymentTerms.trim();
    } else if (moduleKey === "CUSTOMERS") {
      // CRM clients — contact identity + classification. Moving a customer to
      // another unit is guarded above (must stay inside the actor's scope).
      if (typeof d.name === "string" && d.name.trim()) updates.name = d.name.trim();
      if (typeof d.type === "string" && d.type.trim()) updates.type = d.type.trim().toUpperCase();
      if (typeof d.phone === "string" && d.phone.trim()) updates.phone = d.phone.trim();
      if (typeof d.email === "string") updates.email = d.email.trim() || null;
      if (typeof d.address === "string" && d.address.trim()) updates.address = d.address.trim();
      if (d.region !== undefined) updates.region = d.region || null;
      if (d.district !== undefined) updates.district = d.district || null;
      if (d.town !== undefined) updates.town = d.town || null;
      if (d.businessId !== undefined && Number(d.businessId)) updates.businessId = Number(d.businessId);
      // R3 CRM — flexible preferences (payment terms, preferred channel,
      // delivery notes flags…): bounded key/value strings only.
      if (d.preferences !== undefined) {
        const prefs = sanitizeCustomerPreferences(d.preferences);
        updates.preferences = prefs || {};
      }
    } else if (moduleKey === "INVENTORY") {
      // Inventory & Stock — editable catalog fields. Quantity edits recompute
      // the IN_STOCK / LOW_STOCK / OUT_OF_STOCK status that drives alerts.
      if (typeof d.name === "string" && d.name.trim()) updates.name = d.name.trim();
      if (typeof d.sku === "string" && d.sku.trim()) updates.sku = d.sku.trim();
      // Category is standardized across every business (marketplace grouping):
      // the incoming wording is normalized to the shared umbrella and, when it
      // is more specific, preserved as the subcategory.
      if (typeof d.category === "string" && d.category.trim()) {
        updates.category = normalizeInventoryCategory(d.category);
        updates.subcategory = deriveInventorySubcategory(d.category, d.subcategory);
      } else if (d.subcategory !== undefined) {
        updates.subcategory = d.subcategory ? String(d.subcategory).trim().slice(0, 120) : null;
      }
      if (typeof d.unit === "string" && d.unit.trim()) updates.unit = d.unit.trim();
      // VARIANT products: the size/colour rows are the truth and the item's
      // quantity is a DERIVED aggregate. Editing it directly would be silently
      // reverted by the next variant movement (lost deduction = oversell), so
      // the register refuses it. A `variantId` targets the exact combination.
      const existingBusinessId = Number((existing as any).businessId);
      const activeVariants =
        existing.tracksVariants === true
          ? (await variantsForItem(existingBusinessId, existing.id)).filter((v) => v.isActive !== false)
          : [];
      const variantEdit = d.variantId != null ? Number(d.variantId) : null;
      if (d.quantity !== undefined) {
        const qty = Number(d.quantity);
        if (!Number.isFinite(qty) || qty < 0) {
          return NextResponse.json(
            { success: false, error: "Quantity must be zero or a positive number." },
            { status: 400 }
          );
        }
        if (existing.tracksVariants === true) {
          if (!variantEdit) {
            return NextResponse.json(
              {
                success: false,
                error: `"${existing.name}" is stocked by size/colour — update a specific combination instead of the item total.`,
              },
              { status: 400 }
            );
          }
          if (!activeVariants.some((v) => Number(v.id) === variantEdit)) {
            return NextResponse.json(
              { success: false, error: "That size/colour is not sold by this product any more." },
              { status: 400 }
            );
          }
          const applied = await adjustVariantStock({
            businessId: existingBusinessId,
            variantId: variantEdit,
            quantity: qty,
            minStockThreshold: d.minStockThreshold !== undefined ? Number(d.minStockThreshold) : null,
            reason: "ADJUSTMENT",
            refType: "ENTERPRISE_EDIT",
            refId: existing.id,
            actor: { id: (actor as any)?.id ?? null, name: (actor as any)?.name ?? null, role: (actor as any)?.role ?? null },
          });
          if (!applied.ok) {
            return NextResponse.json({ success: false, error: applied.error || "That combination could not be updated." }, { status: 400 });
          }
          variantQuantityApplied = true;
        } else {
          updates.quantity = qty;
        }
      }
      if (d.costPriceGhs !== undefined) {
        const v = Number(d.costPriceGhs);
        if (!Number.isFinite(v) || v < 0) {
          return NextResponse.json(
            { success: false, error: "Cost price must be zero or a positive number." },
            { status: 400 }
          );
        }
        updates.costPriceGhs = v;
      }
      if (d.sellingPriceGhs !== undefined) {
        const v = Number(d.sellingPriceGhs);
        if (!Number.isFinite(v) || v < 0) {
          return NextResponse.json(
            { success: false, error: "Selling price must be zero or a positive number." },
            { status: 400 }
          );
        }
        updates.sellingPriceGhs = v;
      }
      if (d.minStockThreshold !== undefined) {
        const v = Number(d.minStockThreshold);
        if (!Number.isFinite(v) || v < 0) {
          return NextResponse.json(
            { success: false, error: "Minimum stock threshold must be zero or a positive number." },
            { status: 400 }
          );
        }
        updates.minStockThreshold = v;
      }
      if (d.businessId !== undefined) updates.businessId = Number(d.businessId) || existing.businessId;
      if (d.expiryDate !== undefined) updates.expiryDate = d.expiryDate || null;
      // Product-catalogue detail fields (Phase 15 — same helper server-side:
      // partial edits mean "leave untouched", only `null` clears).
      if (d.description !== undefined) updates.description = d.description ? String(d.description).trim().slice(0, 4000) : null;
      if (d.brand !== undefined) updates.brand = d.brand ? String(d.brand).trim().slice(0, 120) : null;
      if (d.model !== undefined) updates.model = d.model ? String(d.model).trim().slice(0, 120) : null;
      if (d.specifications !== undefined) updates.specifications = sanitizeSpecList(d.specifications);
      if (d.variants !== undefined) updates.variants = sanitizeVariantList(d.variants);
      if (d.optionAxis1Label !== undefined)
        updates.optionAxis1Label = d.optionAxis1Label ? String(d.optionAxis1Label).trim().slice(0, 24) : null;
      if (d.optionAxis2Label !== undefined)
        updates.optionAxis2Label = d.optionAxis2Label ? String(d.optionAxis2Label).trim().slice(0, 24) : null;
      // Recompute stock status from the (possibly updated) quantity/threshold.
      // Variant products keep their DERIVED aggregate/status: syncItemAggregate
      // is the only thing allowed to write them.
      if (existing.tracksVariants === true) {
        if (updates.quantity === undefined) delete updates.quantity;
        delete updates.status;
      } else {
        const nextQty = updates.quantity !== undefined ? updates.quantity : existing.quantity;
        const nextThreshold = updates.minStockThreshold !== undefined ? updates.minStockThreshold : existing.minStockThreshold;
        updates.status = computeStockStatus(Number(nextQty), Number(nextThreshold));
      }
    } else {
      // EMPLOYEES
      if (typeof d.name === "string" && d.name.trim()) updates.name = d.name.trim();
      if (typeof d.role === "string" && d.role.trim()) updates.role = d.role.trim();
      if (typeof d.phone === "string" && d.phone.trim()) updates.phone = d.phone.trim();
      if (typeof d.status === "string" && d.status.trim()) updates.status = d.status.trim();
      if (d.salaryGhs !== undefined) {
        const v = Number(d.salaryGhs);
        if (!Number.isFinite(v) || v < 0) {
          return NextResponse.json(
            { success: false, error: "Salary must be a positive number." },
            { status: 400 }
          );
        }
        updates.salaryGhs = v;
      }
      if (d.businessId !== undefined) updates.businessId = Number(d.businessId) || existing.businessId;
    }
    if (d.region !== undefined) updates.region = d.region || null;
    if (d.district !== undefined) updates.district = d.district || null;
    if (d.town !== undefined) updates.town = d.town || null;

    if (Object.keys(updates).length === 0 && !variantQuantityApplied) {
      return NextResponse.json(
        { success: false, error: "Nothing to update." },
        { status: 400 }
      );
    }

    // R1 approval gate — INVENTORY_ADJUSTMENT: when an active policy matches
    // a QUANTITY change and the editor is not an approver, the new quantity
    // is withheld (the rest of the edit still applies) and an approval
    // request is raised; approval applies it, rejection keeps the old stock.
    if (
      moduleKey === "INVENTORY" &&
      updates.quantity !== undefined &&
      Number(updates.quantity) !== Number(existing.quantity)
    ) {
      const delta = Math.abs(Number(updates.quantity) - Number(existing.quantity));
      const unitCost = Number(updates.costPriceGhs ?? existing.costPriceGhs ?? 0) || 0;
      const adjGate = await approvalGateCheck({
        user: actor,
        action: "INVENTORY_ADJUSTMENT",
        businessId: Number(existing.businessId),
        amountGhs: delta * unitCost,
      });
      if (adjGate.gated) {
        const newQuantity = Number(updates.quantity);
        delete updates.quantity;
        delete updates.status; // recomputed when the approved quantity lands
        // Withdraw any earlier still-pending adjustment of the same item so
        // at most one future quantity is queued up.
        await db
          .update(approvalRequests)
          .set({
            status: "CANCELLED",
            decisionReason: "Superseded by a newer adjustment request",
            decidedByName: actor?.name || "Staff",
            decidedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(approvalRequests.action, "INVENTORY_ADJUSTMENT"),
              eq(approvalRequests.targetType, "INVENTORY_ITEM"),
              eq(approvalRequests.targetId, recordId),
              eq(approvalRequests.status, "PENDING"),
            )
          );
        let applied: any = null;
        if (Object.keys(updates).length) {
          [applied] = await db.update(table).set(updates).where(eq(table.id, recordId)).returning();
        }
        await createApprovalRequest({
          action: "INVENTORY_ADJUSTMENT",
          businessId: Number(existing.businessId),
          branchCode: existing.branchCode || null,
          targetType: "INVENTORY_ITEM",
          targetId: recordId,
          targetLabel: `${existing.name} (${existing.sku}) — ${existing.quantity} → ${newQuantity}`,
          amountGhs: delta * unitCost,
          payloadSnapshot: {
            inventoryId: recordId,
            oldQuantity: Number(existing.quantity),
            newQuantity,
            reason: d.adjustmentReason || null,
          },
          actor,
        });
        return NextResponse.json({
          success: true,
          item: applied ?? existing,
          pendingApproval: true,
          gatedFields: ["quantity"],
          message: `Quantity change (${existing.quantity} → ${newQuantity}) sent for approval — the approvers have been notified.`,
        });
      }
    }

    // Every applied edit lands on the audit trail naming the fields that
    // changed; auditEvent also rings the bell for the high-signal kinds
    // (an employee/salary edit, for instance). The actor is never notified.
    const changedKeys = Object.keys(updates);
    const logOwnerId =
      moduleKey === "SUPPLIERS"
        ? (existing.ownerId ?? session.orgId ?? null)
        : (existing.businessId != null
            ? await ownerOrgOfBusiness(Number(existing.businessId))
            : (session.orgId ?? null));

    // P5: an un-gated quantity edit is an ADJUSTMENT movement, so the trail
    // records who corrected stock and from what. Variant-tracked products keep
    // their aggregate derived from the variant rows (syncItemAggregate) — the
    // edit is applied to the parent register exactly as before.
    let updated: any = null;
    if (
      moduleKey === "INVENTORY" &&
      updates.quantity !== undefined &&
      Number(updates.quantity) !== Number(existing.quantity)
    ) {
      const target = Number(updates.quantity);
      const delta = target - Number(existing.quantity);
      delete updates.quantity;
      delete updates.status;
      if (Object.keys(updates).length) {
        [updated] = await db.update(table).set(updates).where(eq(table.id, recordId)).returning();
      }
      const applied = await applyStockChange({
        businessId: Number(existing.businessId),
        inventoryId: recordId,
        delta,
        reason: "ADJUSTMENT",
        refType: "INVENTORY_EDIT",
        note: d.adjustmentReason ? String(d.adjustmentReason) : "Manual quantity correction",
        actor,
        clampAtZero: true,
      });
      updated = applied.item || updated;
    } else if (Object.keys(updates).length > 0) {
      [updated] = await db
        .update(table)
        .set(updates)
        .where(eq(table.id, recordId))
        .returning();
    } else {
      // A variant-targeted quantity edit already applied (the item total is
      // derived from the rows, so there is nothing to write on the parent).
      [updated] = await db.select().from(table).where(eq(table.id, recordId));
    }
    const finalRow: any = updated || existing;
    await auditEvent({
      actorUserId: actor?.id,
      actorName: actor?.name,
      actorRole: actor?.role,
      action: "UPDATE",
      targetType: moduleKey,
      targetLabel: String(finalRow?.name || existing?.name || `${moduleKey} #${recordId}`),
      recordType: moduleKey.toLowerCase(),
      recordId,
      businessId: existing?.businessId != null ? Number(existing.businessId) : null,
      branchCode: existing?.branchCode ?? null,
      ownerId: logOwnerId,
      detail: changedKeys.length ? `Changed: ${changedKeys.join(", ")}` : "Record values updated",
    });
    return NextResponse.json({ success: true, item: updated });
  } catch (error: any) {
    return apiError(error);
  }
}

/**
 * DELETE /api/enterprise — permanently delete a supplier, employee or
 * inventory record.
 * Permission-gated exactly like PATCH (INVENTORY uses the delete-inventory
 * permission) and ALWAYS writes an immutable audit row (module, record
 * snapshot, user, date+time, mandatory reason) first.
 */
export async function DELETE(request: Request) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  try {
    const body = await request.json().catch(() => ({}));
    const { entityType, id, reason } = body || {};
    const moduleKey = String(entityType || "").toUpperCase();
    const table = MODULE_TABLE[moduleKey];
    if (!table) {
      return NextResponse.json(
        { success: false, error: "entityType must be SUPPLIERS, EMPLOYEES, INVENTORY or CUSTOMERS." },
        { status: 400 }
      );
    }
    const recordId = Number(id);
    if (!Number.isFinite(recordId)) {
      return NextResponse.json(
        { success: false, error: "Valid record id is required." },
        { status: 400 }
      );
    }
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 3) {
      return NextResponse.json(
        { success: false, error: "A deletion reason is required and is recorded permanently." },
        { status: 400 }
      );
    }

    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const actor = session.user;

    const [existing] = await db.select().from(table).where(eq(table.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Record not found." },
        { status: 404 }
      );
    }

    // Inventory entries are permission-gated separately (delete-inventory
    // permission); suppliers/employees/customers follow the shared-record
    // flag. A user
    // the OWNER granted "Manage Business / Unit" power for the record's unit
    // may always delete — owner-equivalent, scoped to that unit only.
    const unitManager = canManageBusinessUnit(actor, existing.businessId);
    const permitted =
      moduleKey === "INVENTORY"
        ? canDeleteInventory(actor) || unitManager
        : canManageSharedRecords(actor) || unitManager;
    if (!permitted) {
      return NextResponse.json(
        {
          success: false,
          error:
            moduleKey === "INVENTORY"
              ? "Not permitted — only the OWNER (or a manager the OWNER has granted the delete-inventory permission) can delete inventory entries."
              : "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can delete records.",
        },
        { status: 403 }
      );
    }

    // Tenant boundary: capability flags never cross organizations.
    if (!actor.isSuperAdmin) {
      if (moduleKey === "SUPPLIERS" || moduleKey === "CUSTOMERS") {
        // Organization boundary first (customers carry an ownerId stamp)…
        if (existing.ownerId != null && !(actor.organizationIds || []).includes(Number(existing.ownerId))) {
          return FORBIDDEN(`That ${moduleKey === "SUPPLIERS" ? "supplier" : "customer"} belongs to a different organization.`);
        }
        // …then business isolation for unit-stamped customers. Shared rows
        // (businessId NULL, e.g. legacy enterprise-wide clients) resolve to
        // OWNER-only via canAccessBusiness(NULL).
        if (moduleKey === "CUSTOMERS" && !(await canAccessBusiness(actor, existing.businessId))) {
          return FORBIDDEN("That customer belongs to a business you cannot access.");
        }
      } else if (!(await canAccessBusiness(actor, existing.businessId))) {
        return FORBIDDEN("That record belongs to a business you cannot access.");
      }
    }

    const label =
      moduleKey === "SUPPLIERS" || moduleKey === "CUSTOMERS"
        ? existing.name
        : moduleKey === "INVENTORY"
          ? `${existing.name} (${existing.sku})`
          : `${existing.name} (${existing.role})`;

    // R1 approval gate — DELETION: customer deletions can be held for
    // approval. The record stays alive until an approver releases the
    // request; approval then performs the same audited delete this route
    // performs directly.
    if (moduleKey === "CUSTOMERS") {
      let gateBusinessId = existing.businessId != null ? Number(existing.businessId) : 0;
      if (!gateBusinessId) {
        const orgId = existing.ownerId != null ? Number(existing.ownerId) : (session.orgId ?? null);
        const [firstBiz] = orgId
          ? await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.ownerId, orgId)).limit(1)
          : [];
        gateBusinessId = Number(firstBiz?.id) || 0;
      }
      if (gateBusinessId) {
        const delGate = await approvalGateCheck({
          user: actor,
          action: "DELETION",
          businessId: gateBusinessId,
          amountGhs: null,
        });
        if (delGate.gated) {
          await createApprovalRequest({
            action: "DELETION",
            businessId: gateBusinessId,
            branchCode: existing.branchCode || null,
            targetType: "CUSTOMER",
            targetId: recordId,
            targetLabel: `Delete customer ${existing.name}`,
            payloadSnapshot: {
              entityType: "CUSTOMERS",
              reason: cleanReason,
              snapshot: { id: existing.id, name: existing.name, type: existing.type, phone: existing.phone },
            },
            actor,
          });
          return NextResponse.json({
            success: true,
            pendingApproval: true,
            message: `Deletion of ${existing.name} sent for approval — the customer stays active until an approver confirms.`,
          });
        }
      }
    }

    // Immutable audit row BEFORE the delete lands — tenant-stamped.
    const logOwnerId =
      moduleKey === "SUPPLIERS"
        ? (existing.ownerId ?? session.orgId ?? null)
        : (existing.businessId != null
            ? await ownerOrgOfBusiness(Number(existing.businessId))
            : (session.orgId ?? null));
    const [log] = await db
      .insert(recordDeletionLogs)
      .values({
        module: moduleKey,
        recordId: existing.id,
        recordLabel: label,
        recordSnapshot: existing,
        reason: cleanReason,
        deletedByUserId: actor?.id ?? null,
        deletedByName: actor?.name || "Unknown",
        deletedByRole: actor?.role || "UNKNOWN",
        ownerId: logOwnerId,
      })
      .returning();

    await db.delete(table).where(eq(table.id, recordId));

    // High-signal deletion → the OWNER/CO_OWNER bell (the log above is the
    // immutable evidence). Never blocks the delete.
    try {
      const { notifyRecordDeletion } = await import("@/lib/notifyActivity");
      await notifyRecordDeletion({
        module: moduleKey,
        recordLabel: label,
        reason: cleanReason,
        deletedByName: actor?.name || null,
        deletedByUserId: actor?.id ?? null,
        businessId: existing.businessId ?? null,
        branchCode: existing.branchCode ?? null,
        ownerId: logOwnerId,
      });
    } catch (e) {
      console.error("deletion notification warning:", e);
    }

    return NextResponse.json({
      success: true,
      deleted: { id: existing.id, label },
      auditLogId: log.id,
    });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  ttlInvalidate("menu");
  ttlInvalidate("init");
  try {
    const body = await request.json();
    const { entityType, data } = body;

    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    // Records can only be created against businesses the user can access.
    if (data?.businessId != null && !(await canAccessBusiness(session.user, data.businessId))) {
      return FORBIDDEN("You do not have access to that business.");
    }

    // Standardized Ghana location shared by every enterprise entity
    const loc = {
      region: data?.region || null,
      district: data?.district || null,
      town: data?.town || null,
    };

    if (entityType === "employee") {
      // Business is REQUIRED: the explicit client choice, or — when a branch
      // UI omits it — the caller's own primary assignment. Never a blind
      // default into an arbitrary unit ("business #1"): the resolved business
      // is access-checked either way. (Mirrors the customer path below.)
      const empBizId = data.businessId != null
        ? Number(data.businessId)
        : (session.user.assignedBusinessId ?? null);
      if (!empBizId || !Number.isFinite(empBizId)) {
        return NextResponse.json(
          { success: false, error: "Choose the business this employee belongs to." },
          { status: 400 },
        );
      }
      if (!(await canAccessBusiness(session.user, empBizId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      // Quick-add path — the SAME create core as the full Employee
      // Registration flow (src/lib/employeeCreate), so staff numbering and
      // the employee_history trail can never drift between the two intakes.
      const inserted = await createEmployeeRecord({
        businessId: empBizId,
        name: data.name || "New Employee",
        role: data.role || "Staff",
        branch: data.branch || "Accra Main",
        region: data.region,
        district: data.district,
        town: data.town,
        salaryGhs: Number(data.salaryGhs) || 3000,
        phone: data.phone || "+233 24 000 0000",
        hireDate: data.hireDate,
        status: "ACTIVE",
        actor: session.user,
      });
      return NextResponse.json({ success: true, item: inserted });
    }

    if (entityType === "asset") {
      // Business + Branch are REQUIRED for every asset. This ties the asset
      // value into that business and branch's dashboards, reports and analytics.
      const businessIdNum = Number(data.businessId);
      if (!businessIdNum) {
        return NextResponse.json(
          { success: false, error: "Business is required to register an asset." },
          { status: 400 }
        );
      }

      const [parentBiz] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessIdNum));

      if (!parentBiz) {
        return NextResponse.json(
          { success: false, error: `Business #${businessIdNum} not found.` },
          { status: 400 }
        );
      }

      // Branch defaults to the parent business code when not explicitly passed
      // (single-branch business). Multi-branch businesses must send branchCode.
      const branchCode = String(data.branchCode || parentBiz.code || "").trim();
      if (!branchCode) {
        return NextResponse.json(
          { success: false, error: "Branch is required to register an asset." },
          { status: 400 }
        );
      }

      // A BRANCH_MANAGER may only register assets against their own branch.
      if (
        data.requestingUserRole === "BRANCH_MANAGER" &&
        Number(data.requestingUserBusinessId) !== businessIdNum
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Branch Managers can only register assets for their own assigned branch.",
          },
          { status: 403 }
        );
      }

      // ── Unique Asset Code ────────────────────────────────────────────────
      // Use the supplied code, or auto-generate the next sequential code for
      // this branch (e.g. TECH-01-AST-0003). Enforce uniqueness before insert.
      let assetCode = String(data.assetCode || "").trim().toUpperCase();

      if (assetCode) {
        const [dupe] = await db
          .select()
          .from(assets)
          .where(eq(assets.assetCode, assetCode));
        if (dupe) {
          return NextResponse.json(
            {
              success: false,
              error: `Asset Code "${assetCode}" is already in use. Please enter a unique code.`,
            },
            { status: 409 }
          );
        }
      } else {
        // Asset codes number PER BUSINESS: two independent organizations may
        // both run a POULTRY-01 unit with its own AST-0001 registry.
        const branchAssets = await db
          .select()
          .from(assets)
          .where(eq(assets.businessId, businessIdNum));
        let seq = branchAssets.length + 1;
        // Guard against gaps/collisions by probing until a free code is found
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const candidate = `${branchCode}-AST-${String(seq).padStart(4, "0")}`;
          const [exists] = await db
            .select()
            .from(assets)
            .where(and(eq(assets.assetCode, candidate), eq(assets.businessId, businessIdNum)));
          if (!exists) {
            assetCode = candidate;
            break;
          }
          seq += 1;
        }
      }

      // ── Unique QR tag — a scanned/generated QR must never point at two assets. ──
      const assetQr = data.qrCode ? String(data.qrCode).trim().slice(0, 200) : "";
      if (assetQr) {
        // QR uniqueness is PER BUSINESS (independent orgs may share unit
        // codes, so identical label values can exist in two tenants).
        const [qrDupe] = await db
          .select()
          .from(assets)
          .where(and(eq(assets.qrCode, assetQr), eq(assets.businessId, businessIdNum)))
          .limit(1);
        if (qrDupe) {
          return NextResponse.json(
            {
              success: false,
              error: `This QR code is already registered to asset "${qrDupe.name}" (${qrDupe.assetCode}).`,
              duplicateOf: { kind: "asset", id: qrDupe.id, name: qrDupe.name },
            },
            { status: 409 }
          );
        }
      }

      const assetQrValue = assetQr || null;
      // Asset photos + display thumbnails, validated centrally: shape, budget
      // (≤400 KB per image, ≤60 KB per thumbnail) and the per-record cap (6).
      const assetImgCheck = validateImageArray(data.assetImages, "asset", { label: "Asset photo" });
      if (!assetImgCheck.ok) return NextResponse.json({ success: false, error: assetImgCheck.error }, { status: 400 });
      const assetThumbCheck = validateImageArray(data.assetImagesThumb, "asset", {
        label: "Asset thumbnail",
        max: 6,
        maxBytes: THUMB_BUDGET_BYTES,
        allowNulls: true,
      });
      if (!assetThumbCheck.ok) return NextResponse.json({ success: false, error: assetThumbCheck.error }, { status: 400 });
      const assetImagesArr: string[] = Array.isArray(data.assetImages)
        ? data.assetImages.filter((p: any) => typeof p === "string" && p.length > 0)
        : [];
      // POSITIONAL, like inventory: entry i is the thumbnail of images[i]; a
      // missing thumbnail stays null so indices never shift.
      const assetThumbsRaw = Array.isArray(data.assetImagesThumb) ? data.assetImagesThumb : [];
      const assetThumbs = assetImagesArr.map((_p: any, i: number) =>
        typeof assetThumbsRaw[i] === "string" && /^data:image\//.test(assetThumbsRaw[i]) ? assetThumbsRaw[i] : null,
      );
      const assetThumbsArr = assetThumbs.some((t: string | null) => !!t) ? assetThumbs : null;

      const [inserted] = await db
        .insert(assets)
        .values({
          assetCode,
          qrCode: assetQrValue,
          name: data.name || "Enterprise Equipment",
          description: data.description || null,
          businessId: businessIdNum,
          branchCode,
          branchName: data.branchName || parentBiz.name,
          assetType: data.assetType || "MACHINERY",
          purchasePriceGhs: Number(data.purchasePriceGhs) || 15000,
          currentValueGhs:
            Number(data.currentValueGhs) ||
            Number(data.purchasePriceGhs) * 0.9 ||
            14000,
          condition: data.condition || "EXCELLENT",
          location: data.location || "Main Site",
          // Auto-copy the branch's standardized Ghana location (Region → District → Town)
          // unless the caller provided explicit overrides.
          region: loc.region || parentBiz.region || null,
          district: loc.district || parentBiz.district || null,
          town: loc.town || parentBiz.town || null,
          nextMaintenanceDate:
            data.nextMaintenanceDate ||
            new Date(Date.now() + 90 * 86400000).toISOString().split("T")[0],
          registeredByUserId: data.registeredByUserId
            ? Number(data.registeredByUserId)
            : null,
          recorderName: data.recorderName || data.requestedByName || "Unknown Recorder",
          recordedAt: new Date(),
          assetImages: assetImagesArr,
          assetImagesThumb: assetThumbsArr,
        })
        .returning();

      await db.insert(assetAuditLogs).values({
        assetId: inserted.id,
        assetCode: inserted.assetCode,
        action: "CREATE",
        ownerId: (await ownerOrgOfBusiness(inserted.businessId)) ?? session.orgId ?? null,
        status: "COMPLETED",
        requestedByUserId: data.registeredByUserId
          ? Number(data.registeredByUserId)
          : null,
        requestedByName: data.recorderName || data.requestedByName || "Unknown Recorder",
        requestedByRole: data.requestingUserRole || null,
        detailsJson: {
          name: inserted.name,
          businessId: inserted.businessId,
          branchCode: inserted.branchCode,
          currentValueGhs: inserted.currentValueGhs,
          imageCount: assetImagesArr.length,
        },
      });

      return NextResponse.json({ success: true, item: inserted });
    }

    if (entityType === "inventory") {
      const qty = Number(data.quantity) || 100;
      const threshold = Number(data.minStockThreshold) || 10;
      // Same rule as employees: explicit business, else the caller's own
      // primary assignment — never a blind "business #1" fallback; the
      // resolved business is access-checked before any stock row is written.
      const bizId = data.businessId != null
        ? Number(data.businessId)
        : (session.user.assignedBusinessId ?? 0);
      if (!bizId || !Number.isFinite(bizId)) {
        return NextResponse.json(
          { success: false, error: "Choose the business this stock item belongs to." },
          { status: 400 },
        );
      }
      if (!(await canAccessBusiness(session.user, bizId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      // Branch/register defaults to the owning business code (same convention
      // as transactions) so every stock row is always business+branch stamped.
      let branchCode = data.branchCode ? String(data.branchCode).trim() : "";
      let branchName = data.branchName ? String(data.branchName).trim() : "";
      if (!branchCode || !branchName) {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.id, bizId))
          .limit(1);
        if (biz) {
          if (!branchCode) branchCode = biz.code;
          if (!branchName) branchName = biz.name;
        }
      }
      // Photos + thumbnails are validated centrally (src/lib/mediaValidation):
      // shape, stored-byte budget and the per-record photo cap (6). The browser
      // already sizes them; this is the enforcement point.
      const photosCheck = validateImageArray(data.photos, "product", { label: "Product photo" });
      if (!photosCheck.ok) return NextResponse.json({ success: false, error: photosCheck.error }, { status: 400 });
      const thumbsCheck = validateImageArray(data.photosThumb, "product", {
        label: "Product thumbnail",
        max: 6,
        maxBytes: THUMB_BUDGET_BYTES,
        allowNulls: true,
      });
      if (!thumbsCheck.ok) return NextResponse.json({ success: false, error: thumbsCheck.error }, { status: 400 });
      const primaryPhotoCheck = validateOptionalImage(data.photo, "product", { label: "Product photo" });
      if (!primaryPhotoCheck.ok) return NextResponse.json({ success: false, error: primaryPhotoCheck.error }, { status: 400 });
      const primaryThumbCheck = validateOptionalImage(data.photoThumb, "product", {
        label: "Product thumbnail",
        maxBytes: THUMB_BUDGET_BYTES,
      });
      if (!primaryThumbCheck.ok) return NextResponse.json({ success: false, error: primaryThumbCheck.error }, { status: 400 });

      const photosArr = Array.isArray(data.photos)
        ? data.photos.filter((p: any) => typeof p === "string" && p.length > 0)
        : [];
      // Display thumbnails generated in the browser at upload time
      // (src/lib/imageOptimize). POSITIONAL: entry i is the thumbnail of
      // photos[i]; a missing/failed thumbnail stays null so indices never
      // shift (a shifted array would show another product's picture).
      // Optional: older clients/rows simply have none and readers fall back.
      const thumbsRaw = Array.isArray(data.photosThumb) ? data.photosThumb : [];
      const thumbsArr = photosArr.map((_p: any, i: number) =>
        typeof thumbsRaw[i] === "string" && /^data:image\//.test(thumbsRaw[i]) ? thumbsRaw[i] : null,
      );
      const hasThumbs = thumbsArr.some((t: string | null) => !!t);
      // ── Unique QR tag — scanned or auto-generated; never duplicated. ──
      const invQr = data.qrCode ? String(data.qrCode).trim().slice(0, 200) : "";
      if (invQr) {
        const [qrDupe] = await db
          .select()
          .from(inventoryItems)
          .where(and(eq(inventoryItems.qrCode, invQr), eq(inventoryItems.businessId, bizId)))
          .limit(1);
        if (qrDupe) {
          return NextResponse.json(
            {
              success: false,
              error: `This QR code is already registered to stock item "${qrDupe.name}" (${qrDupe.sku}).`,
              duplicateOf: { kind: "inventory", id: qrDupe.id, name: qrDupe.name },
            },
            { status: 409 }
          );
        }
      }
      // Boutique: a stock item registered with a size/colour matrix becomes a
      // variant-tracked product. The matrix is validated + persisted right
      // after the row exists, and it REPLACES the parent quantity with the
      // live sum of variants (the register stays the one stock truth).
      const boutiqueMatrix = data.tracksVariants === true ? normalizeVariantMatrix(data.boutiqueVariants) : [];
      // What the two axes MEAN for this product (Size / Shoe size / Capacity /
      // Style / Model / Colour / Pack size …). Presentation only.
      const axis1Label = String(data.optionAxis1Label || "").trim().slice(0, 24) || null;
      const axis2Label = String(data.optionAxis2Label || "").trim().slice(0, 24) || null;
      const [inserted] = await db
        .insert(inventoryItems)
        .values({
          name: data.name || "New Inventory Item",
          sku: data.sku || `SKU-${Math.floor(10000 + Math.random() * 90000)}`,
          businessId: bizId,
          branchCode: branchCode || null,
          branchName: branchName || null,
          category: normalizeInventoryCategory(data.category),
          subcategory: deriveInventorySubcategory(data.category, data.subcategory),
          // Registered EMPTY: the opening quantity is applied through the one
          // stock writer below (so it appears in the movement trail).
          quantity: 0,
          unit: data.unit || "Units",
          costPriceGhs: Number(data.costPriceGhs) || 20,
          sellingPriceGhs: Number(data.sellingPriceGhs) || 35,
          minStockThreshold: threshold,
          status: "OUT_OF_STOCK",
          expiryDate: data.expiryDate || null,
          photo: typeof data.photo === "string" && data.photo ? data.photo : photosArr[0] || null,
          photos: photosArr,
          photoThumb:
            typeof data.photoThumb === "string" && /^data:image\//.test(data.photoThumb)
              ? data.photoThumb
              : thumbsArr[0] || null,
          photosThumb: hasThumbs ? thumbsArr : null,
          description: data.description ? String(data.description).trim().slice(0, 4000) : null,
          brand: data.brand ? String(data.brand).trim().slice(0, 120) : null,
          model: data.model ? String(data.model).trim().slice(0, 120) : null,
          specifications: sanitizeSpecList(data.specifications),
          variants: sanitizeVariantList(data.variants),
          optionAxis1Label: boutiqueMatrix.length > 0 ? axis1Label : null,
          optionAxis2Label: boutiqueMatrix.length > 0 ? axis2Label : null,
          qrCode: invQr || null,
          registeredByName: data.registeredByName ? String(data.registeredByName).slice(0, 120) : null,
          registeredByUserId: data.registeredByUserId ? Number(data.registeredByUserId) : null,
        })
        .returning();

      // Opening stock through the ONE writer (skipped for variant products:
      // their stock lives on the variant rows, applied by setVariantsForItem).
      if (qty > 0 && boutiqueMatrix.length === 0) {
        await applyStockChange({
          businessId: bizId,
          inventoryId: inserted.id,
          delta: qty,
          reason: "OPENING",
          refType: "INVENTORY_REGISTER",
          note: `Opening stock — ${inserted.name}`,
          actor: { name: data.registeredByName || null },
        });
      }

      if (boutiqueMatrix.length > 0) {
        try {
          await setVariantsForItem({
            reason: "OPENING",
            refType: "INVENTORY_REGISTER",
            note: "Opening stock registered with the product",
            businessId: bizId,
            inventoryId: inserted.id,
            variants: boutiqueMatrix,
            replace: true,
            actorName: data.registeredByName ? String(data.registeredByName) : null,
          });
          const [fresh] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, inserted.id));
          return NextResponse.json({ success: true, item: fresh || inserted, variants: boutiqueMatrix.length });
        } catch (e: any) {
          // Never leave a half-configured variant product ambiguous: the item
          // exists (still sellable as plain stock) and the message tells the
          // owner exactly what to fix in the Sizes & Colours tab.
          return NextResponse.json(
            { success: true, item: inserted, variantWarning: e.message || "Variants could not be saved." },
          );
        }
      }
      return NextResponse.json({ success: true, item: inserted });
    }

    if (entityType === "customer") {
      // Business-isolated CRM (owner directive): every new customer belongs to
      // exactly one Business/Branch, so a new unit never inherits another's
      // clientele. Fallback: the staffer's own primary assignment.
      const custBizId = data.businessId != null ? Number(data.businessId) : (session.user as any)?.assignedBusinessId ?? null;
      if (!custBizId) {
        return NextResponse.json(
          { success: false, error: "Choose the business this customer belongs to — customer records are isolated per Business/Branch." },
          { status: 400 },
        );
      }
      if (!(await canAccessBusiness(session.user, custBizId))) {
        return FORBIDDEN("You do not have access to that business.");
      }
      const [inserted] = await db
        .insert(customers)
        .values({
          name: data.name || "New Client",
          type: data.type || "WHOLESALE",
          phone: data.phone || "+233 24 000 0000",
          email: data.email || "client@domain.gh",
          address:
            data.address ||
            [data?.town, data?.district, data?.region].filter(Boolean).join(", ") ||
            "Ghana",
          ...loc,
          totalSpentGhs: 0,
          loyaltyPoints: 0,
          businessId: custBizId,
          ownerId: (await ownerOrgOfBusiness(custBizId)) ?? session.orgId ?? null,
        })
        .returning();
      return NextResponse.json({ success: true, item: inserted });
    }

    if (entityType === "supplier") {
      const [inserted] = await db
        .insert(suppliers)
        .values({
          name: data.name || "New Supplier",
          category: data.category || "Materials",
          contactPerson: data.contactPerson || "Contact Officer",
          phone: data.phone || "+233 24 000 0000",
          email: data.email || "supplier@domain.gh",
          paymentTerms: data.paymentTerms || "NET_30",
          ...loc,
          totalSuppliedGhs: 0,
          ownerId: session.orgId ?? null,
        })
        .returning();
      return NextResponse.json({ success: true, item: inserted });
    }

    return NextResponse.json(
      { success: false, error: `Unknown entityType: ${entityType}` },
      { status: 400 }
    );
  } catch (error: any) {
    return apiError(error);
  }
}
