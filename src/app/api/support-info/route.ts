import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customerSupportInfo } from "@/db/schema";
import { getSessionInfo, FORBIDDEN, UNAUTHENTICATED } from "@/lib/auth";
import {
  PLATFORM_ORG_ID,
  getPlatformSupportRow,
  getSupportRowForOrg,
  publicSupportInfo,
  supportScopeFor,
  canEditSupport,
  canEditRegistration,
  SUPPORT_FORBIDDEN_MESSAGE,
  type SupportRow,
} from "@/lib/supportInfo";

/**
 * Group-wide CUSTOMER SUPPORT / platform Help-Contact information — the
 * content of the storefront's HELP panel (contact name, phone, WhatsApp,
 * email, business address / location, opening hours, extra notes) plus the
 * public "Join GoMina 360" registration CTA configuration.
 *
 * GET  — PUBLIC (no login): shoppers read it when they tap HELP on the
 *        customer order page. Without `?org=` this serves the PLATFORM row —
 *        the storefront is a centralized marketplace, so its HELP panel is the
 *        platform helpdesk. `?org=<id>` returns that organisation's own row
 *        (reserved for future per-owner storefronts / the multi-owner suite).
 *
 *        When a session is present the response also carries `edit` — the row
 *        THIS caller would actually write, its scope, and their capabilities.
 *        That removes the old read/write asymmetry where the editor loaded one
 *        row and Save overwrote a different one.
 *
 * POST — the caller's own scoped row:
 *          · Super Admin, or a member of the platform organisation holding
 *            OWNER / the OWNER-granted `canManageSupport`  → the PLATFORM row
 *            (what customers see; this is the tested delegation model);
 *          · anyone else (a tenant's OWNER / granted user) → their own
 *            organisation's row.
 *        The `registration*` fields are Super-Admin-only and are preserved
 *        untouched when anyone else saves.
 */

const LIMITS: Record<string, number> = {
  contactName: 120,
  phone: 40,
  whatsapp: 40,
  email: 160,
  address: 300,
  openingHours: 200,
  extraInfo: 1000,
  registrationHeadline: 140,
  registrationNote: 600,
};

function clean(value: any, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s === "" ? null : s;
}

export async function GET(request: Request) {
  try {
    const orgParam = new URL(request.url).searchParams.get("org");

    // Public read: platform row by default, an organisation's own row when
    // explicitly addressed (unchanged `?org=` contract).
    const info = orgParam
      ? publicSupportInfo(await getSupportRowForOrg(Number(orgParam)))
      : publicSupportInfo(await getPlatformSupportRow());

    // Session-aware editing context. Public callers simply get `edit: null`.
    let edit: any = null;
    const session = await getSessionInfo(request).catch(() => null);
    if (session) {
      const scope = supportScopeFor(session as any);
      const allowed = canEditSupport(session.user, scope);
      const row: SupportRow | null =
        scope === "PLATFORM"
          ? await getPlatformSupportRow()
          : session.orgId != null
            ? await getSupportRowForOrg(session.orgId)
            : null;
      edit = {
        scope,
        canEdit: allowed,
        canEditRegistration: canEditRegistration(session.user),
        row: publicSupportInfo(row),
      };
    }

    return NextResponse.json(
      { success: true, info, edit },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    console.error("GET /api/support-info error:", error);
    return NextResponse.json(
      { success: false, error: "Could not load support information." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSessionInfo(request);
    if (!session) return UNAUTHENTICATED();
    const { user } = session;

    const scope = supportScopeFor(session as any);
    if (!canEditSupport(user, scope)) {
      return FORBIDDEN(SUPPORT_FORBIDDEN_MESSAGE);
    }

    const body = await request.json().catch(() => ({}));
    const mayEditRegistration = canEditRegistration(user);

    const values: Partial<SupportRow> = {
      contactName: clean(body.contactName, LIMITS.contactName),
      phone: clean(body.phone, LIMITS.phone),
      whatsapp: clean(body.whatsapp, LIMITS.whatsapp),
      email: clean(body.email, LIMITS.email),
      address: clean(body.address, LIMITS.address),
      openingHours: clean(body.openingHours, LIMITS.openingHours),
      extraInfo: clean(body.extraInfo, LIMITS.extraInfo),
      updatedByUserId: user.id,
      updatedByName: user.name,
      updatedByRole: user.role,
      updatedAt: new Date(),
    };
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email))) {
      return NextResponse.json(
        { success: false, error: "That email address does not look valid." },
        { status: 400 },
      );
    }

    // Registration config is platform recruitment policy → Super Admin only.
    // Everyone else's save leaves the published CTA exactly as it was.
    if (mayEditRegistration && body.registration != null) {
      values.registrationEnabled = body.registration.enabled !== false;
      values.registrationHeadline = clean(body.registration.headline, LIMITS.registrationHeadline);
      values.registrationNote = clean(body.registration.note, LIMITS.registrationNote);
      // The login-page switch is stored on the same row but consumed by a
      // DIFFERENT surface (`/`, the staff sign-in gate). It changes nothing
      // about the order-page invite or `/join`.
      if (body.registration.loginEnabled !== undefined) {
        values.loginRegistrationEnabled = body.registration.loginEnabled === true;
      }
    }

    let row: SupportRow;
    if (scope === "PLATFORM") {
      // The storefront row. Prefer the explicitly flagged platform row; on a
      // legacy deployment fall back to organisation #1's row and PROMOTE it,
      // so the published helpdesk text is never orphaned behind the new flag.
      const existing = await getPlatformSupportRow();
      row = existing
        ? (await db
            .update(customerSupportInfo)
            .set({ ...values, isPlatform: true, organizationId: existing.organizationId ?? PLATFORM_ORG_ID })
            .where(eq(customerSupportInfo.id, existing.id))
            .returning())[0]
        : (await db
            .insert(customerSupportInfo)
            .values({ ...values, isPlatform: true, organizationId: PLATFORM_ORG_ID })
            .returning())[0];
    } else {
      const orgId = session.orgId ?? PLATFORM_ORG_ID;
      const [existing] = await db
        .select({ id: customerSupportInfo.id })
        .from(customerSupportInfo)
        .where(eq(customerSupportInfo.organizationId, orgId));
      row = existing
        ? (await db
            .update(customerSupportInfo)
            .set({ ...values, isPlatform: false, organizationId: orgId })
            .where(eq(customerSupportInfo.id, existing.id))
            .returning())[0]
        : (await db
            .insert(customerSupportInfo)
            .values({ ...values, isPlatform: false, organizationId: orgId })
            .returning())[0];
    }

    // ── Refresh the prerendered sign-in shell ──────────────────────────────
    // `/` is static (ISR, revalidate 60) and receives the login-page switch as
    // a prop at build / background-revalidation time. Revalidating HERE makes
    // the owner's flip take effect on the very next page load instead of
    // waiting out the 60 s window — with no per-request cost and no client
    // fetch on the login page. Best-effort: a failure here can only delay the
    // change, never fail the save.
    if (values.loginRegistrationEnabled !== undefined || row?.isPlatform) {
      try {
        revalidatePath("/");
      } catch (e) {
        console.error("revalidatePath(/) warning:", e);
      }
    }

    return NextResponse.json({
      success: true,
      scope,
      info: publicSupportInfo(row),
      edit: {
        scope,
        canEdit: true,
        canEditRegistration: mayEditRegistration,
        row: publicSupportInfo(row),
      },
    });
  } catch (error: any) {
    console.error("POST /api/support-info error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Could not save support information." },
      { status: 500 },
    );
  }
}
