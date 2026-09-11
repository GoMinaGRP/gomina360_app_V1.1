import { NextResponse } from "next/server";
import { getSessionInfo, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { readBackupArchive, importBusinessBackup } from "@/lib/businessBackup";

// Backup parsing uses Buffer/JSZip, so keep this handler on the Node runtime.
// App Router Route Handlers receive the Web Request directly and parse
// multipart bodies with request.formData(); the Pages Router `config.api`
// bodyParser switch is neither needed nor a valid route-segment export here.
export const runtime = "nodejs";

/**
 * POST /api/business-backup/import  (multipart/form-data)
 *   Field "file"      — the .zip archive produced by /export
 *   Field "name"      — optional override business name
 *   Field "code"      — optional override code prefix
 *
 * Creates a NEW business from the backup. Never overwrites existing
 * businesses/branches.
 *
 * AUTHORIZATION: OWNER or any user with the can_create_business grant
 * (same gate as POST /api/businesses).
 */
export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const user = session.user;

    const isOwner = user.role === "OWNER";
    if (!isOwner && user.canCreateBusiness !== true) {
      return FORBIDDEN(
        "You need the OWNER-granted New Branch/Unit permission to import a business backup.",
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: "A backup .zip file is required (field 'file')." },
        { status: 400 },
      );
    }
    const nameOverride = (form.get("name") as string) || undefined;
    const codeOverride = (form.get("code") as string) || undefined;

    const buf = Buffer.from(await file.arrayBuffer());
    const manifest = await readBackupArchive(buf);
    const result = await importBusinessBackup(manifest, { nameOverride, codeOverride });

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || String(error) },
      { status: 500 },
    );
  }
}
