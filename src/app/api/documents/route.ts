import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businessDocuments, customerTrackings, poultryHealthRecords } from "@/db/schema";
import { getSessionInfo, accessibleBusinessIds, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { auditLog } from "@/lib/audit";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { generateDeliveryNote, generateVetReport, validateDocUpload } from "@/lib/documents";

/**
 * /api/documents — R4 Document Vault.
 *
 * GET  ?businessId=            → the unit's documents (list view, no fileData)
 *        &docType=&relatedType=&relatedId=&expiring=1 filters
 *      ?id=                    → single document WITH fileData (view/download)
 * POST   { action: "UPLOAD", businessId, docType, title, fileData, … }
 *        { action: "GENERATE_VET_REPORT", healthRecordId }
 *        { action: "GENERATE_DELIVERY_NOTE", trackingId }
 * PATCH  { id, title?, notes?, issuedOn?, expiresOn?, docType? }
 * DELETE ?id=
 *
 * Every path is tenant-scoped: the caller must have access to the document's
 * business; managers (OWNER/GM/BM of the unit) and the uploader can manage.
 */
const LIST_COLUMNS = {
  id: businessDocuments.id,
  ownerId: businessDocuments.ownerId,
  businessId: businessDocuments.businessId,
  branchCode: businessDocuments.branchCode,
  docType: businessDocuments.docType,
  title: businessDocuments.title,
  fileName: businessDocuments.fileName,
  issuedOn: businessDocuments.issuedOn,
  expiresOn: businessDocuments.expiresOn,
  relatedType: businessDocuments.relatedType,
  relatedId: businessDocuments.relatedId,
  notes: businessDocuments.notes,
  uploadedByUserId: businessDocuments.uploadedByUserId,
  uploadedByName: businessDocuments.uploadedByName,
  uploadedByRole: businessDocuments.uploadedByRole,
  createdAt: businessDocuments.createdAt,
  updatedAt: businessDocuments.updatedAt,
};

const DOC_TYPES = [
  "INVOICE", "RECEIPT", "QUOTATION", "VET_REPORT", "DELIVERY_NOTE", "CONTRACT",
  "CERTIFICATE", "LICENCE_PERMIT", "INSURANCE", "VEHICLE_DOCUMENT", "SUPPLIER_INVOICE", "OTHER",
];

const isManager = (me: any) => ["OWNER", "GENERAL_MANAGER", "BRANCH_MANAGER"].includes(String(me?.role || ""));

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id") || 0);
    const today = new Date().toLocaleDateString("en-CA");

    if (id) {
      const [doc] = await db.select().from(businessDocuments).where(eq(businessDocuments.id, id));
      if (!doc) return NextResponse.json({ success: false, error: "Document not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(doc.businessId)))) {
        return FORBIDDEN("That document belongs to a unit you cannot access.");
      }
      return NextResponse.json({ success: true, document: doc });
    }

    const bizFilter = Number(url.searchParams.get("businessId") || 0) || null;
    const docType = (url.searchParams.get("docType") || "").trim().toUpperCase();
    const relatedType = (url.searchParams.get("relatedType") || "").trim().toUpperCase();
    const relatedId = Number(url.searchParams.get("relatedId") || 0) || null;
    const expiring = url.searchParams.get("expiring") === "1";

    const allowed = await accessibleBusinessIds(me);
    if (bizFilter && allowed !== null && !allowed.map(Number).includes(bizFilter)) {
      return FORBIDDEN("That business is outside your scope.");
    }
    let rows = await db.select(LIST_COLUMNS).from(businessDocuments);
    rows = rows.filter((r: any) => allowed === null || allowed.map(Number).includes(Number(r.businessId)));
    if (bizFilter) rows = rows.filter((r: any) => Number(r.businessId) === bizFilter);
    if (docType) rows = rows.filter((r: any) => String(r.docType) === docType);
    if (relatedType) rows = rows.filter((r: any) => String(r.relatedType || "") === relatedType);
    if (relatedId) rows = rows.filter((r: any) => Number(r.relatedId || 0) === relatedId);
    if (expiring) {
      rows = rows.filter((r: any) => {
        if (!r.expiresOn) return false;
        const days = Math.ceil((new Date(String(r.expiresOn)).getTime() - new Date(today).getTime()) / 86400000);
        return days <= 30;
      });
    }
    rows.sort((a: any, b: any) => Number(b.id) - Number(a.id));

    const all = await db.select(LIST_COLUMNS).from(businessDocuments);
    const scoped = all.filter((r: any) => allowed === null || allowed.map(Number).includes(Number(r.businessId)));
    const summary = {
      count: rows.length,
      total: scoped.length,
      expiringSoon: scoped.filter((r: any) => r.expiresOn && String(r.expiresOn) >= today && String(r.expiresOn) <= new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA")).length,
      expired: scoped.filter((r: any) => r.expiresOn && String(r.expiresOn) < today).length,
    };
    return NextResponse.json({ success: true, documents: rows, summary, meta: { scope: allowed === null ? "ALL" : allowed } });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const action = String(body?.action || "UPLOAD").toUpperCase();

    // ── UPLOAD ──
    if (action === "UPLOAD") {
      const businessId = Number(body?.businessId || 0);
      if (!businessId) return NextResponse.json({ success: false, error: "businessId is required." }, { status: 400 });
      if (!(await canAccessBusiness(me, businessId))) return FORBIDDEN("You cannot file documents for that unit.");
      const docType = String(body?.docType || "OTHER").toUpperCase();
      if (!DOC_TYPES.includes(docType)) {
        return NextResponse.json({ success: false, error: `docType must be one of ${DOC_TYPES.join(", ")}.` }, { status: 400 });
      }
      const title = String(body?.title || "").trim().slice(0, 160);
      if (!title) return NextResponse.json({ success: false, error: "A title is required." }, { status: 400 });
      const fileData = String(body?.fileData || "");
      const v = validateDocUpload(fileData);
      if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 });
      const issuedOn = String(body?.issuedOn || "").slice(0, 10) || null;
      const expiresOn = String(body?.expiresOn || "").slice(0, 10) || null;
      for (const [k, d] of [["issuedOn", issuedOn], ["expiresOn", expiresOn]] as const) {
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return NextResponse.json({ success: false, error: `${k} must be yyyy-mm-dd.` }, { status: 400 });
        }
      }
      const orgId = await ownerOrgOfBusiness(businessId);
      const [row] = await db
        .insert(businessDocuments)
        .values({
          ownerId: Number(orgId) || 1,
          businessId,
          branchCode: body?.branchCode ? String(body.branchCode).slice(0, 24) : null,
          docType,
          title,
          fileName: body?.fileName ? String(body.fileName).slice(0, 160) : null,
          fileData,
          issuedOn,
          expiresOn,
          relatedType: body?.relatedType ? String(body.relatedType).slice(0, 40).toUpperCase() : null,
          relatedId: body?.relatedId != null ? Number(body.relatedId) : null,
          notes: body?.notes ? String(body.notes).trim().slice(0, 500) : null,
          uploadedByUserId: me.id ?? null,
          uploadedByName: me.name || "Staff",
          uploadedByRole: me.role || null,
        })
        .returning();
      await auditLog(me, "CREATE", "RECORD", `Document: ${title}`, "BUSINESS_DOCUMENT", row.id, businessId, null, `${docType}, ${((v.bytes || 0) / 1024).toFixed(0)} KB`, orgId);
      const { fileData: _fd, ...listRow } = row as any;
      return NextResponse.json({ success: true, document: listRow });
    }

    // ── GENERATE_VET_REPORT — from a poultry health record ──
    if (action === "GENERATE_VET_REPORT") {
      const healthRecordId = Number(body?.healthRecordId || 0);
      const [rec] = await db.select().from(poultryHealthRecords).where(eq(poultryHealthRecords.id, healthRecordId));
      if (!rec) return NextResponse.json({ success: false, error: "Health record not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(rec.businessId)))) return FORBIDDEN("That health record belongs to another unit.");
      const gen = await generateVetReport(healthRecordId, { id: me.id, name: me.name, role: me.role });
      if (!gen) return NextResponse.json({ success: false, error: "Could not build the vet report." }, { status: 500 });
      // Idempotent: re-generating replaces the previous report for the same record.
      const existing = await db
        .select({ id: businessDocuments.id })
        .from(businessDocuments)
        .where(and(eq(businessDocuments.docType, "VET_REPORT"), eq(businessDocuments.relatedType, "HEALTH_RECORD"), eq(businessDocuments.relatedId, healthRecordId)));
      const orgId = await ownerOrgOfBusiness(Number(rec.businessId));
      let row;
      if (existing.length) {
        [row] = await db
          .update(businessDocuments)
          .set({ title: gen.title, fileName: gen.fileName, fileData: gen.fileData, issuedOn: gen.issuedOn, uploadedByUserId: me.id ?? null, uploadedByName: me.name || "Staff", uploadedByRole: me.role || null, updatedAt: new Date() })
          .where(eq(businessDocuments.id, existing[0].id))
          .returning();
      } else {
        [row] = await db
          .insert(businessDocuments)
          .values({
            ownerId: Number(orgId) || 1,
            businessId: Number(rec.businessId),
            branchCode: rec.branchCode,
            docType: "VET_REPORT",
            title: gen.title,
            fileName: gen.fileName,
            fileData: gen.fileData,
            issuedOn: gen.issuedOn,
            relatedType: "HEALTH_RECORD",
            relatedId: healthRecordId,
            notes: "Generated from the poultry health log.",
            uploadedByUserId: me.id ?? null,
            uploadedByName: me.name || "Staff",
            uploadedByRole: me.role || null,
          })
          .returning();
      }
      await auditLog(me, "CREATE", "RECORD", `Vet report for health record #${healthRecordId}`, "BUSINESS_DOCUMENT", row.id, Number(rec.businessId), null, "Generated PDF", orgId);
      const { fileData: _fd, ...listRow } = row as any;
      return NextResponse.json({ success: true, document: listRow, replaced: existing.length > 0 || undefined });
    }

    // ── GENERATE_DELIVERY_NOTE — from a delivered customer order ──
    if (action === "GENERATE_DELIVERY_NOTE") {
      const trackingId = Number(body?.trackingId || 0);
      const [t] = await db.select().from(customerTrackings).where(eq(customerTrackings.id, trackingId));
      if (!t) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
      if (!(await canAccessBusiness(me, Number(t.businessId)))) return FORBIDDEN("That order belongs to another unit.");
      const gen = await generateDeliveryNote(trackingId, { id: me.id, name: me.name, role: me.role });
      if (!gen) return NextResponse.json({ success: false, error: "Could not build the delivery note." }, { status: 500 });
      const existing = await db
        .select({ id: businessDocuments.id })
        .from(businessDocuments)
        .where(and(eq(businessDocuments.docType, "DELIVERY_NOTE"), eq(businessDocuments.relatedType, "TRACKING"), eq(businessDocuments.relatedId, trackingId)));
      const orgId = await ownerOrgOfBusiness(Number(t.businessId));
      let row;
      if (existing.length) {
        [row] = await db
          .update(businessDocuments)
          .set({ title: gen.title, fileName: gen.fileName, fileData: gen.fileData, issuedOn: gen.issuedOn, uploadedByUserId: me.id ?? null, uploadedByName: me.name || "Staff", uploadedByRole: me.role || null, updatedAt: new Date() })
          .where(eq(businessDocuments.id, existing[0].id))
          .returning();
      } else {
        [row] = await db
          .insert(businessDocuments)
          .values({
            ownerId: Number(orgId) || 1,
            businessId: Number(t.businessId),
            branchCode: t.branchCode,
            docType: "DELIVERY_NOTE",
            title: gen.title,
            fileName: gen.fileName,
            fileData: gen.fileData,
            issuedOn: gen.issuedOn,
            relatedType: "TRACKING",
            relatedId: trackingId,
            notes: "Generated from the delivered order.",
            uploadedByUserId: me.id ?? null,
            uploadedByName: me.name || "Staff",
            uploadedByRole: me.role || null,
          })
          .returning();
      }
      await auditLog(me, "CREATE", "RECORD", `Delivery note for ${t.trackingCode}`, "BUSINESS_DOCUMENT", row.id, Number(t.businessId), null, "Generated PDF", orgId);
      const { fileData: _fd, ...listRow } = row as any;
      return NextResponse.json({ success: true, document: listRow, replaced: existing.length > 0 || undefined });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const body = await request.json();
    const [doc] = await db.select().from(businessDocuments).where(eq(businessDocuments.id, Number(body?.id || 0)));
    if (!doc) return NextResponse.json({ success: false, error: "Document not found." }, { status: 404 });
    if (!(await canAccessBusiness(me, Number(doc.businessId)))) return FORBIDDEN("That document belongs to a unit you cannot access.");
    const isUploader = Number(doc.uploadedByUserId) === Number(me.id);
    if (!(isManager(me) || isUploader || me.isSuperAdmin)) {
      return FORBIDDEN("Only a manager of the unit or the uploader can edit this document.");
    }
    const updates: any = { updatedAt: new Date() };
    if (body?.title != null) {
      const t = String(body.title).trim().slice(0, 160);
      if (!t) return NextResponse.json({ success: false, error: "Title cannot be empty." }, { status: 400 });
      updates.title = t;
    }
    if (body?.notes !== undefined) updates.notes = String(body.notes || "").trim().slice(0, 500) || null;
    if (body?.docType != null) {
      const dt = String(body.docType).toUpperCase();
      if (!DOC_TYPES.includes(dt)) return NextResponse.json({ success: false, error: "Unsupported docType." }, { status: 400 });
      updates.docType = dt;
    }
    for (const k of ["issuedOn", "expiresOn"]) {
      if (body?.[k] !== undefined) {
        const d = String(body[k] || "").slice(0, 10) || null;
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return NextResponse.json({ success: false, error: `${k} must be yyyy-mm-dd.` }, { status: 400 });
        updates[k] = d;
      }
    }
    const [row] = await db.update(businessDocuments).set(updates).where(eq(businessDocuments.id, doc.id)).returning();
    const { fileData: _fd, ...listRow } = row as any;
    return NextResponse.json({ success: true, document: listRow });
  } catch (error: any) {
    return apiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const me = session.user;
    const url = new URL(request.url);
    const [doc] = await db.select().from(businessDocuments).where(eq(businessDocuments.id, Number(url.searchParams.get("id") || 0)));
    if (!doc) return NextResponse.json({ success: false, error: "Document not found." }, { status: 404 });
    const hasAccess = await canAccessBusiness(me, Number(doc.businessId));
    const isUploader = Number(doc.uploadedByUserId) === Number(me.id);
    if (!hasAccess || !(isManager(me) || isUploader || me.isSuperAdmin)) {
      return FORBIDDEN("Only a manager of the unit or the uploader can delete this document.");
    }
    await db.delete(businessDocuments).where(eq(businessDocuments.id, doc.id));
    await auditLog(me, "DELETE", "RECORD", `Document: ${doc.title}`, "BUSINESS_DOCUMENT", doc.id, Number(doc.businessId), null, `${doc.docType} removed from the vault`, doc.ownerId);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return apiError(error);
  }
}
