import { NextResponse } from "next/server";
import { getSessionInfo, UNAUTHENTICATED, FORBIDDEN } from "@/lib/auth";
import { readBackupArchive, importBusinessBackup } from "@/lib/businessBackup";
import { db } from "@/db";
import { businesses, organizationMembers, userBusinessAccess, users } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { apiError } from "@/lib/apiError";
import { provisionBusiness } from "@/lib/businessProvisioning";

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
    const result = await importBusinessBackup(manifest, {
      nameOverride,
      codeOverride,
      // Tenant link: the restored unit belongs to the importing account's
      // organization, and every restored row is stamped with it.
      ownerId: session.orgId ?? null,
      actorUserId: Number(user.id),
    });

    // ── Make the restored unit usable by the account that ran the restore ──
    // Same follow-up contract as POST /api/businesses: the creator sees the
    // unit immediately, the organization's general managers get their usual
    // grant, and provisioning fills any gap the archive did not carry (its
    // per-area guards mean nothing already restored is duplicated).
    const newBusinessId = Number((result as any)?.businessId);
    if (newBusinessId) {
      const isOwner = user.role === "OWNER";
      try {
        if (!isOwner) {
          const [existing] = await db
            .select({ id: userBusinessAccess.id })
            .from(userBusinessAccess)
            .where(and(eq(userBusinessAccess.userId, user.id), eq(userBusinessAccess.businessId, newBusinessId)))
            .limit(1);
          if (!existing) {
            await db.insert(userBusinessAccess).values({
              userId: user.id,
              businessId: newBusinessId,
              createdByUserId: user.id,
            });
          }
        }
        const orgMemberships = session.orgId != null
          ? await db
              .select({ userId: organizationMembers.userId })
              .from(organizationMembers)
              .where(eq(organizationMembers.organizationId, session.orgId))
          : [];
        const memberIds = orgMemberships.map((m) => Number(m.userId));
        if (memberIds.length) {
          const gms = await db
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, memberIds), eq(users.role, "GENERAL_MANAGER"), eq(users.isActive, true)));
          for (const gm of gms) {
            const [existing] = await db
              .select({ id: userBusinessAccess.id })
              .from(userBusinessAccess)
              .where(and(eq(userBusinessAccess.userId, gm.id), eq(userBusinessAccess.businessId, newBusinessId)))
              .limit(1);
            if (!existing) {
              await db.insert(userBusinessAccess).values({
                userId: gm.id,
                businessId: newBusinessId,
                createdByUserId: user.id,
              });
            }
          }
        }
      } catch (e) {
        console.error("Access grant after backup import failed (unit still restored):", e);
      }

      // Gap-fill only: no sample data (starterKit stays off), and each area
      // is skipped when the backup already restored it.
      try {
        await provisionBusiness({
          id: newBusinessId,
          code: result.businessCode,
          name: result.businessName,
          category: result.category,
          initialCapitalGhs: Number(manifest.tables?.businesses?.[0]?.initialCapitalGhs) || 100000,
        });
      } catch (e) {
        console.error("Post-import provisioning failed (unit still restored):", e);
      }
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    // Archives we refuse to restore (wrong format version, missing/corrupt
    // manifest, rows belonging to another business) are a client problem —
    // answer 400 with the reason instead of a generic 500.
    const msg = String(error?.message || "");
    const rejected =
      /^Backup rejected/i.test(msg) ||
      /Unsupported backup format version|missing the business record|Not a valid GoMina backup/i.test(msg);
    if (rejected) {
      return NextResponse.json({ success: false, error: msg }, { status: 400 });
    }
    return apiError(error);
  }
}
