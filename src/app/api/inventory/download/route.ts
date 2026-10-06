import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { inventoryDownloads } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { ownerOrgOfBusiness } from "@/lib/notify";
import { apiError } from "@/lib/apiError";

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      downloadId,
      downloaderBusinessId,
      downloaderBranchCode,
      downloaderBranchName,
      format,
      recordCount,
      qrCodeData,
      qrCodePayload
    } = body;

    if (!downloadId || !format || !recordCount || !qrCodeData) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Identity & role always come from the signed-in session — the request
    // body can never claim an arbitrary downloader id/name/role.
    const downloaderUserId = __authSession.user.id;
    const downloaderName = __authSession.user.name || 'Unknown User';
    const downloaderRole = __authSession.user.role;

    // Business context (when supplied) must lie inside the caller's scope.
    let ownerId: number | null = __authSession.orgId ?? null;
    if (downloaderBusinessId) {
      if (!(await canAccessBusiness(__authSession.user, Number(downloaderBusinessId)))) {
        return FORBIDDEN('You do not have access to that business.');
      }
      ownerId = (await ownerOrgOfBusiness(Number(downloaderBusinessId))) ?? ownerId;
    }

    const [download] = await db
      .insert(inventoryDownloads)
      .values({
        downloadId,
        downloaderUserId,
        downloaderName,
        downloaderRole,
        downloaderBusinessId: downloaderBusinessId || null,
        downloaderBranchCode: downloaderBranchCode || null,
        downloaderBranchName: downloaderBranchName || null,
        format,
        recordCount,
        qrCodeData,
        qrCodePayload,
        ownerId,
        status: downloaderRole === 'BRANCH_MANAGER' ? 'PENDING' : 'COMPLETED'
      })
      .returning();

    return NextResponse.json({
      success: true,
      download
    });
  } catch (error: any) {
    console.error('Inventory download recording error:', error);
    return apiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const me = __authSession.user;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const downloaderRole = searchParams.get('downloaderRole');

    // ── Scope IN SQL, then order, then limit ────────────────────────────
    // Same shape as the asset download ledger: tenant scope narrows the query
    // (not a post-limit JavaScript filter, which let foreign rows consume the
    // page), and the list is most-recent-first with `id` as the tie-break.
    const myOrgIds = (me.organizationIds || []).map(Number).filter(Boolean);
    const where: any[] = [];

    // Scope: Super Admin ⇒ all; OWNER/GM ⇒ their organization's records;
    // everyone else ⇒ their own downloads only.
    if (!me.isSuperAdmin) {
      const isExec = me.role === 'OWNER' || me.role === 'GENERAL_MANAGER';
      if (isExec) {
        if (!myOrgIds.length) return NextResponse.json({ success: true, downloads: [] });
        where.push(inArray(inventoryDownloads.ownerId, myOrgIds));
      } else {
        where.push(eq(inventoryDownloads.downloaderUserId, Number(me.id)));
      }
    }
    if (downloaderRole) where.push(eq(inventoryDownloads.downloaderRole, downloaderRole));

    let query: any = db.select().from(inventoryDownloads);
    if (where.length === 1) query = query.where(where[0]);
    else if (where.length > 1) query = query.where(and(...where));
    const rows = await query
      .orderBy(desc(inventoryDownloads.createdAt), desc(inventoryDownloads.id))
      .limit(limit);

    return NextResponse.json({
      success: true,
      downloads: rows
    });
  } catch (error: any) {
    console.error('Inventory download history error:', error);
    return apiError(error);
  }
}
