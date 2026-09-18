import { NextRequest, NextResponse } from 'next/server';
import { ttlInvalidate } from "@/lib/ttlCache";
import { db } from '@/db';
import { assetDownloads, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getSessionInfo, canAccessBusiness, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";

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
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
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

    let query = db.select().from(assetDownloads);

    if (userId) {
      query = query.where(eq(assetDownloads.downloaderUserId, parseInt(userId))) as any;
    } else if (!isExecutive) {
      query = query.where(eq(assetDownloads.downloaderUserId, __authSession.user.id)) as any;
    }

    let downloads = await query.orderBy(assetDownloads.createdAt).limit(limit);
    // Executives (non-Super-Admin) are limited to their own organization's records.
    if (!__authSession.user.isSuperAdmin && isExecutive) {
      const myOrgs = new Set(__authSession.user.organizationIds || []);
      downloads = downloads.filter((d: any) => d.ownerId != null && myOrgs.has(Number(d.ownerId)));
    }
    // An executive peeking at a specific user must still stay in-org.
    if (userId && isExecutive && !__authSession.user.isSuperAdmin) {
      const targetId = parseInt(userId);
      downloads = downloads.filter((d: any) => Number(d.downloaderUserId) === targetId);
    }

    return NextResponse.json({
      success: true,
      downloads
    });
  } catch (error: any) {
    console.error('Download history error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
