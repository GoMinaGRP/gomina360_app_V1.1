import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  employees,
  employeeHistory,
  assets,
  assetAuditLogs,
  inventoryItems,
  customers,
  suppliers,
  businesses,
  recordDeletionLogs,
} from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { computeStockStatus } from "@/lib/stock";
import { canManageSharedRecords } from "@/lib/recordPermissions";
import { getSessionInfo, canAccessBusiness, accessibleBusinessIds, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

// Which enterprise entity a deletion-log row refers to.
const MODULE_TABLE: Record<string, any> = {
  SUPPLIERS: suppliers,
  EMPLOYEES: employees,
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
      const [item] = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.qrCode, code))
        .limit(1);
      if (item && canSee(item.businessId)) {
        return NextResponse.json({ success: true, found: true, kind: "inventory", record: item });
      }
      const [asset] = await db
        .select()
        .from(assets)
        .where(eq(assets.qrCode, code))
        .limit(1);
      if (asset && canSee(asset.businessId)) {
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
    return NextResponse.json({ success: true, logs: rows });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/enterprise — edit a supplier or employee record.
 * OWNER always allowed; other users only with the OWNER-granted
 * canManageRecords flag (resolved server-side from the database).
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { entityType, id, data, actorUserId } = body || {};
    const moduleKey = String(entityType || "").toUpperCase();
    const table = MODULE_TABLE[moduleKey];
    if (!table) {
      return NextResponse.json(
        { success: false, error: "entityType must be SUPPLIERS or EMPLOYEES." },
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
    if (!canManageSharedRecords(actor)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can edit records.",
        },
        { status: 403 }
      );
    }

    const [existing] = await db.select().from(table).where(eq(table.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Record not found." },
        { status: 404 }
      );
    }

    const d = data || {};
    const updates: Record<string, any> = {};
    if (moduleKey === "SUPPLIERS") {
      if (typeof d.name === "string" && d.name.trim()) updates.name = d.name.trim();
      if (typeof d.category === "string" && d.category.trim()) updates.category = d.category.trim();
      if (typeof d.contactPerson === "string" && d.contactPerson.trim()) updates.contactPerson = d.contactPerson.trim();
      if (typeof d.phone === "string" && d.phone.trim()) updates.phone = d.phone.trim();
      if (typeof d.email === "string") updates.email = d.email.trim() || null;
      if (typeof d.paymentTerms === "string" && d.paymentTerms.trim()) updates.paymentTerms = d.paymentTerms.trim();
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

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update." },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(table)
      .set(updates)
      .where(eq(table.id, recordId))
      .returning();
    return NextResponse.json({ success: true, item: updated });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/enterprise — permanently delete a supplier or employee record.
 * Permission-gated exactly like PATCH and ALWAYS writes an immutable audit
 * row (module, record snapshot, user, date+time, mandatory reason) first.
 */
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { entityType, id, reason, actorUserId } = body || {};
    const moduleKey = String(entityType || "").toUpperCase();
    const table = MODULE_TABLE[moduleKey];
    if (!table) {
      return NextResponse.json(
        { success: false, error: "entityType must be SUPPLIERS or EMPLOYEES." },
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
    if (!canManageSharedRecords(actor)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Not permitted — only the OWNER (or a manager the OWNER has granted record-management permission) can delete records.",
        },
        { status: 403 }
      );
    }

    const [existing] = await db.select().from(table).where(eq(table.id, recordId));
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Record not found." },
        { status: 404 }
      );
    }

    const label =
      moduleKey === "SUPPLIERS"
        ? existing.name
        : `${existing.name} (${existing.role})`;

    // Immutable audit row BEFORE the delete lands.
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
      })
      .returning();

    await db.delete(table).where(eq(table.id, recordId));

    return NextResponse.json({
      success: true,
      deleted: { id: existing.id, label },
      auditLogId: log.id,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
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
      // Quick-add path — auto-assign the employee number and record the
      // registration in the employee record history (same as the full
      // Employee Registration flow in /api/employees).
      const maxRows = await db
        .select({ v: sql<string>`max(nullif(regexp_replace(coalesce(${employees.employeeNo}, ''), '\\D', '', 'g'), '')::int)` })
        .from(employees);
      const employeeNo = `EMP-${String((Number(maxRows[0]?.v) || 0) + 1).padStart(4, "0")}`;
      const [inserted] = await db
        .insert(employees)
        .values({
          name: data.name || "New Employee",
          role: data.role || "Staff",
          businessId: Number(data.businessId) || 1,
          branch: data.branch || "Accra Main",
          ...loc,
          salaryGhs: Number(data.salaryGhs) || 3000,
          phone: data.phone || "+233 24 000 0000",
          hireDate: data.hireDate || new Date().toISOString().split("T")[0],
          status: "ACTIVE",
          employeeNo,
        })
        .returning();
      await db.insert(employeeHistory).values({
        employeeId: inserted.id,
        businessId: inserted.businessId,
        action: "CREATED",
        summary: `Registered ${inserted.name} (${employeeNo}) — ${inserted.role}, quick add`,
        changedByUserId: session.user.id,
        changedByName: session.user.name,
        changedByRole: session.user.role,
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
        const branchAssets = await db
          .select()
          .from(assets)
          .where(eq(assets.branchCode, branchCode));
        let seq = branchAssets.length + 1;
        // Guard against gaps/collisions by probing until a free code is found
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const candidate = `${branchCode}-AST-${String(seq).padStart(4, "0")}`;
          const [exists] = await db
            .select()
            .from(assets)
            .where(eq(assets.assetCode, candidate));
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
        const [qrDupe] = await db
          .select()
          .from(assets)
          .where(eq(assets.qrCode, assetQr))
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
          assetImages: Array.isArray(data.assetImages) ? data.assetImages : [],
        })
        .returning();

      await db.insert(assetAuditLogs).values({
        assetId: inserted.id,
        assetCode: inserted.assetCode,
        action: "CREATE",
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
          imageCount: Array.isArray(data.assetImages) ? data.assetImages.length : 0,
        },
      });

      return NextResponse.json({ success: true, item: inserted });
    }

    if (entityType === "inventory") {
      const qty = Number(data.quantity) || 100;
      const threshold = Number(data.minStockThreshold) || 10;
      const bizId = Number(data.businessId) || 1;
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
      const photosArr = Array.isArray(data.photos)
        ? data.photos.filter((p: any) => typeof p === "string" && p.length > 0)
        : [];
      // ── Unique QR tag — scanned or auto-generated; never duplicated. ──
      const invQr = data.qrCode ? String(data.qrCode).trim().slice(0, 200) : "";
      if (invQr) {
        const [qrDupe] = await db
          .select()
          .from(inventoryItems)
          .where(eq(inventoryItems.qrCode, invQr))
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
      const [inserted] = await db
        .insert(inventoryItems)
        .values({
          name: data.name || "New Inventory Item",
          sku: data.sku || `SKU-${Math.floor(10000 + Math.random() * 90000)}`,
          businessId: bizId,
          branchCode: branchCode || null,
          branchName: branchName || null,
          category: data.category || "General Stock",
          quantity: qty,
          unit: data.unit || "Units",
          costPriceGhs: Number(data.costPriceGhs) || 20,
          sellingPriceGhs: Number(data.sellingPriceGhs) || 35,
          minStockThreshold: threshold,
          status: computeStockStatus(qty, threshold),
          expiryDate: data.expiryDate || null,
          photo: typeof data.photo === "string" && data.photo ? data.photo : photosArr[0] || null,
          photos: photosArr,
          qrCode: invQr || null,
          registeredByName: data.registeredByName ? String(data.registeredByName).slice(0, 120) : null,
          registeredByUserId: data.registeredByUserId ? Number(data.registeredByUserId) : null,
        })
        .returning();
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
        })
        .returning();
      return NextResponse.json({ success: true, item: inserted });
    }

    return NextResponse.json(
      { success: false, error: `Unknown entityType: ${entityType}` },
      { status: 400 }
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
