import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetDownloads, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const body = await request.json();
    const {
      downloadId,
      downloaderUserId,
      downloaderName,
      downloaderRole,
      downloaderBusinessId,
      downloaderBranchCode,
      downloaderBranchName,
      format,
      recordCount,
      qrCodeData,
      qrCodePayload
    } = body;

    // Validate required fields
    if (!downloadId || !downloaderUserId || !downloaderName || !downloaderRole || !format || !recordCount || !qrCodeData) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
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

    let query = db.select().from(assetDownloads);

    if (userId) {
      query = query.where(eq(assetDownloads.downloaderUserId, parseInt(userId))) as any;
    }

    const downloads = await query.orderBy(assetDownloads.createdAt).limit(limit);

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
