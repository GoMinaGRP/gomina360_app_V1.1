import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { inventoryDownloads } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
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

    if (!downloadId || !downloaderUserId || !downloaderName || !downloaderRole || !format || !recordCount || !qrCodeData) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
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
        status: downloaderRole === 'BRANCH_MANAGER' ? 'PENDING' : 'COMPLETED'
      })
      .returning();

    return NextResponse.json({
      success: true,
      download
    });
  } catch (error: any) {
    console.error('Inventory download recording error:', error);
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
    const limit = parseInt(searchParams.get('limit') || '50');
    const downloaderRole = searchParams.get('downloaderRole');

    let query = db.select().from(inventoryDownloads);

    if (downloaderRole) {
      query = query.where(eq(inventoryDownloads.downloaderRole, downloaderRole)) as any;
    }

    const downloads = await query.orderBy(desc(inventoryDownloads.createdAt)).limit(limit);

    return NextResponse.json({
      success: true,
      downloads
    });
  } catch (error: any) {
    console.error('Inventory download history error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
