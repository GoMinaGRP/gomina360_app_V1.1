import { NextRequest, NextResponse } from 'next/server';
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from '@/db';
import { assetDownloads, users } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
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

    // Validate required fields (downloader identity is stamped from the session below)
    if (!downloadId || !format || !recordCount || !qrCodeData) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Identity comes from the signed-in session — the request body can no
    // longer claim an arbitrary downloader id/name/role.
    const downloaderUserId = __authSession.user.id;
    const downloaderName = __authSession.user.name || 'Unknown User';
    const downloaderRole = __authSession.user.role;

    // If a business context is supplied, the user must actually have access to it.
    let ownerId: number | null = __authSession.orgId ?? null;
    if (downloaderBusinessId) {
      if (!(await canAccessBusiness(__authSession.user, Number(downloaderBusinessId)))) {
        return FORBIDDEN('You do not have access to that business.');
      }
      const { ownerOrgOfBusiness } = await import("@/lib/notify");
      ownerId = (await ownerOrgOfBusiness(Number(downloaderBusinessId))) ?? ownerId;
    }

    // Check if download ID already exists (should not happen with timestamp-based IDs)
    const existing = await db
      .select()
      .from(assetDownloads)
      .where(eq(assetDownloads.downloadId, downloadId))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Download ID already exists' },
        { status: 409 }
      );
    }

    // Insert download record
    const [download] = await db
      .insert(assetDownloads)
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
        status: downloaderRole === 'BRANCH_MANAGER' ? 'APPROVED' : 'COMPLETED'
      })
      .returning();

    return NextResponse.json({
      success: true,
      download
    });
  } catch (error: any) {
    console.error('Download recording error:', error);
    return apiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const limit = parseInt(searchParams.get('limit') || '50');

    // Only Owner / General Manager may read another user's download history
    // (and only inside their own organization); every other role is
    // restricted to its own records. The Super Admin reads across orgs.
    const role = __authSession.user.role;
    const isExecutive = __authSession.user.isSuperAdmin || role === 'OWNER' || role === 'GENERAL_MANAGER';
    if (!isExecutive && userId && parseInt(userId) !== __authSession.user.id) {
      return FORBIDDEN('You can only view your own download history.');
    }

    // ── Scope IN SQL, then order, then limit ────────────────────────────
    // The previous shape fetched `limit` newest rows and filtered by
    // organization in JavaScript, so an executive in a multi-organization
    // workspace could receive a short (even empty) page while other
    // organizations' rows consumed the whole limit. Tenant scope now narrows
    // the query itself. Ordering is MOST RECENT FIRST (`created_at DESC`,
    // `id DESC` as the tie-break): this is a history list.
    const me = __authSession.user;
    const myOrgIds = (me.organizationIds || []).map(Number).filter(Boolean);
    const scopeWhere: any[] = [];

    const targetUserId = userId ? parseInt(userId) : null;
    if (targetUserId) scopeWhere.push(eq(assetDownloads.downloaderUserId, targetUserId));
    else if (!isExecutive) scopeWhere.push(eq(assetDownloads.downloaderUserId, me.id));

    // Executives (non-Super-Admin) never leave their own organization(s).
    if (!me.isSuperAdmin) {
      if (!myOrgIds.length) return NextResponse.json({ success: true, downloads: [] });
      scopeWhere.push(inArray(assetDownloads.ownerId, myOrgIds));
    }

    let query: any = db.select().from(assetDownloads);
    if (scopeWhere.length === 1) query = query.where(scopeWhere[0]);
    else if (scopeWhere.length > 1) query = query.where(and(...scopeWhere));

    const downloads = await query
      .orderBy(desc(assetDownloads.createdAt), desc(assetDownloads.id))
      .limit(limit);

    return NextResponse.json({
      success: true,
      downloads
    });
  } catch (error: any) {
    console.error('Download history error:', error);
    return apiError(error);
  }
}
