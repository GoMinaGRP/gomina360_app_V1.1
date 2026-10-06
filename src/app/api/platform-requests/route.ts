import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { platformRequests } from "@/db/schema";
import { getSessionInfo, requireSuperAdmin, FORBIDDEN, UNAUTHENTICATED, hashClientIp, deviceLabel } from "@/lib/auth";
import { apiError } from "@/lib/apiError";
import { throttle, clientIp } from "@/lib/rateLimit";
import { validatePhone, PHONE_EXACT_DIGITS_STOREFRONT } from "@/lib/phone";
import { notifyPlatformRequest, syncPlatformRequestBells } from "@/lib/notify";
import {
  provisionOrganization,
  writePlatformTrail,
  invalidatePublicCaches,
  findProvisionedWorkspaceForRecovery,
  ProvisionError,
} from "@/lib/organizationProvisioning";
import {
  PLATFORM_REQUEST_PURPOSE_KEYS,
  PLATFORM_REQUEST_STATUSES,
  PLATFORM_REQUEST_LIMITS,
  PLATFORM_REQUEST_THROTTLE,
  PLATFORM_REQUEST_HONEYPOT,
  PLATFORM_REQUEST_RECEIVED_MESSAGE,
  OPEN_PLATFORM_REQUEST_STATUSES,
  PLATFORM_REQUEST_BUSINESS_TYPES,
  cleanField,
  EMAIL_RE,
  makePlatformRequestReference,
  purposeLabel,
  businessTypeLabel,
} from "@/lib/platformRequests";

/**
 * Platform registration / contact requests — "Join GoMina 360" and friends.
 *
 * POST — PUBLIC (no login). A prospective business submits the storefront
 *        Help/Contact registration form (or /join). Anti-abuse: two-layer IP
 *        throttle, honeypot, allowlisted purpose, strict validation, one open
 *        request per email. The response contains ONLY an opaque reference
 *        code — never the row, an id, a count or a status lookup, so there is
 *        no public read surface to enumerate or scrape.
 *
 * GET   — SUPER ADMIN ONLY. The review queue (never scoped by tenant).
 * PATCH — SUPER ADMIN ONLY. Decide/manage: review, request info, approve
 *         (→ provision the Owner workspace), reject, close.
 *
 * PRIVACY: `platform_requests` has no ownerId/businessId column at all. Every
 * read path is gated on requireSuperAdmin(), the rows are excluded from
 * /api/init, exports and tenant backups by construction, and the bell rows
 * raised for them are addressed to Super Admins only.
 */

const STATUS_ACTIONS = ["START_REVIEW", "NEEDS_INFO", "APPROVE", "REJECT", "CLOSE", "PROVISION"] as const;
type StatusAction = (typeof STATUS_ACTIONS)[number];

export async function POST(request: Request) {
  // Two-layer throttle: a short burst guard plus a long sustained cap. A
  // genuine prospect submits once, so a tight budget costs them nothing.
  const ip = clientIp(request);
  const burst = throttle(ip, { key: "platform-request-burst", ...PLATFORM_REQUEST_THROTTLE.burst });
  if (burst) return burst;
  const sustained = throttle(ip, { key: "platform-request", ...PLATFORM_REQUEST_THROTTLE.sustained });
  if (sustained) return sustained;

  try {
    const body = await request.json().catch(() => ({}));

    // Honeypot: a hidden field no human can see or fill. Silently pretend
    // success so a bot cannot tune around the check, but store NOTHING.
    const trap = String((body as any)[PLATFORM_REQUEST_HONEYPOT] || "").trim();
    if (trap) {
      return NextResponse.json({ success: true, reference: null, message: PLATFORM_REQUEST_RECEIVED_MESSAGE });
    }

    const purpose = String(body.purpose || "").trim().toUpperCase();
    if (!PLATFORM_REQUEST_PURPOSE_KEYS.includes(purpose)) {
      return NextResponse.json(
        { success: false, error: "Please choose what you are contacting us about." },
        { status: 400 },
      );
    }

    const contactName = cleanField(body.contactName, PLATFORM_REQUEST_LIMITS.contactName);
    if (!contactName || contactName.length < 2) {
      return NextResponse.json({ success: false, error: "Please enter your name." }, { status: 400 });
    }

    // At least one way to reply is required — a lead with no channel is a
    // dead end for the platform team.
    const contactEmailRaw = cleanField(body.contactEmail, PLATFORM_REQUEST_LIMITS.contactEmail);
    const contactEmail = contactEmailRaw ? contactEmailRaw.toLowerCase() : null;
    if (contactEmail && !EMAIL_RE.test(contactEmail)) {
      return NextResponse.json({ success: false, error: "That email address does not look valid." }, { status: 400 });
    }

    let contactPhone: string | null = null;
    const phoneRaw = cleanField(body.contactPhone, PLATFORM_REQUEST_LIMITS.contactPhone);
    if (phoneRaw) {
      const verdict = validatePhone(phoneRaw, { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT });
      if (!verdict.ok) {
        return NextResponse.json({ success: false, error: verdict.error }, { status: 400 });
      }
      contactPhone = verdict.value.slice(0, 20);
    }

    if (!contactEmail && !contactPhone) {
      return NextResponse.json(
        { success: false, error: "Please give us an email address or a phone number so we can reply." },
        { status: 400 },
      );
    }

    let businessType = cleanField(body.businessType, 60);
    if (businessType && !PLATFORM_REQUEST_BUSINESS_TYPES.some((t) => t.key === businessType)) {
      businessType = null; // unknown key ⇒ dropped, never stored raw
    }

    // One OPEN request per email. Answering with the generic success text (and
    // no reference) keeps the funnel friendly while neither leaking an existing
    // reference code nor flooding the Super Admin's queue with duplicates.
    if (contactEmail) {
      const [dupe] = await db
        .select({ id: platformRequests.id })
        .from(platformRequests)
        .where(
          and(
            eq(platformRequests.contactEmail, contactEmail),
            inArray(platformRequests.status, OPEN_PLATFORM_REQUEST_STATUSES),
          ),
        )
        .limit(1);
      if (dupe) {
        return NextResponse.json({
          success: true,
          duplicate: true,
          reference: null,
          message:
            "We already have your request and the platform team will get back to you. No need to send it again.",
        });
      }
    }

    // Reference uniqueness: retry on the astronomically unlikely collision.
    let reference = makePlatformRequestReference((n) => crypto.randomBytes(n));
    for (let i = 0; i < 5; i++) {
      const [taken] = await db
        .select({ id: platformRequests.id })
        .from(platformRequests)
        .where(eq(platformRequests.reference, reference))
        .limit(1);
      if (!taken) break;
      reference = makePlatformRequestReference((n) => crypto.randomBytes(n));
    }

    const device = deviceLabel(request);
    const [row] = await db
      .insert(platformRequests)
      .values({
        reference,
        purpose,
        status: "PENDING",
        businessName: cleanField(body.businessName, PLATFORM_REQUEST_LIMITS.businessName),
        contactName,
        contactEmail,
        contactPhone,
        businessType,
        location: cleanField(body.location, PLATFORM_REQUEST_LIMITS.location),
        message: cleanField(body.message, PLATFORM_REQUEST_LIMITS.message),
        // Non-PII submission context only: raw IPs are never persisted.
        meta: {
          source: cleanField(body.source, 40) || "storefront",
          agent: device.label,
          ipHash: hashClientIp(request),
        },
      })
      .returning();

    // Bell + push the Super Admin(s). Never let a notify failure fail the
    // applicant's submission (notifyPlatformRequest swallows its own errors).
    await notifyPlatformRequest({
      id: row.id,
      reference: row.reference,
      purposeLabel: purposeLabel(row.purpose),
      businessName: row.businessName,
      contactName: row.contactName,
    });

    return NextResponse.json({
      success: true,
      reference: row.reference,
      message: PLATFORM_REQUEST_RECEIVED_MESSAGE,
    });
  } catch (error: any) {
    return apiError(error);
  }
}
export async function GET(request: Request) {
  try {
    const actor = await requireSuperAdmin(request);
    if (!actor) {
      // Distinguish "not signed in" from "signed in but not the platform owner"
      // so the console shows the right message — without confirming anything
      // about the requests themselves.
      const session = await getSessionInfo(request).catch(() => null);
      return session ? FORBIDDEN("Only the platform Super Admin can review platform requests.") : UNAUTHENTICATED();
    }

    const statusParam = (new URL(request.url).searchParams.get("status") || "").toUpperCase();
    const status = (PLATFORM_REQUEST_STATUSES as readonly string[]).includes(statusParam) ? statusParam : null;

    const rows = await db
      .select()
      .from(platformRequests)
      .where(status ? eq(platformRequests.status, status) : sql`true`)
      .orderBy(desc(platformRequests.id))
      .limit(200);

    const counts = await db
      .select({ status: platformRequests.status, c: sql<number>`count(*)::int` })
      .from(platformRequests)
      .groupBy(platformRequests.status);

    // "Needs attention" is not only the review states: an APPROVED request whose
    // workspace has not been created yet still needs the platform team. This is
    // the SQL form of `isPlatformRequestActionable` — the same rule the bell and
    // the Action Center use — so badge, list and notification cannot disagree.
    const [actionable] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(platformRequests)
      .where(
        or(
          inArray(platformRequests.status, OPEN_PLATFORM_REQUEST_STATUSES),
          and(eq(platformRequests.status, "APPROVED"), isNull(platformRequests.createdOrganizationId)),
        ),
      );

    return NextResponse.json(
      {
        success: true,
        requests: rows.map((r) => ({
          ...r,
          purposeLabel: purposeLabel(r.purpose),
          businessTypeLabel: businessTypeLabel(r.businessType),
        })),
        counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.c)])),
        openCount: Number(actionable?.c || 0),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: any) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireSuperAdmin(request);
    if (!actor) {
      const session = await getSessionInfo(request).catch(() => null);
      return session ? FORBIDDEN("Only the platform Super Admin can manage platform requests.") : UNAUTHENTICATED();
    }

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    const action = String(body.action || "").toUpperCase() as StatusAction;
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ success: false, error: "Which request?" }, { status: 400 });
    }
    if (!STATUS_ACTIONS.includes(action)) {
      return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
    }

    const [row] = await db.select().from(platformRequests).where(eq(platformRequests.id, id));
    if (!row) return NextResponse.json({ success: false, error: "That request no longer exists." }, { status: 404 });

    const reason = cleanField(body.reason, 1000);
    const base = {
      decidedByUserId: actor.id,
      decidedByName: actor.name,
      decidedByRole: actor.role,
      decidedAt: new Date(),
      updatedAt: new Date(),
    };

    // ── PROVISION: create the Owner workspace from an APPROVED request ──────
    // Two-step by design: approving is a DECISION, provisioning is an ACTION
    // that creates a live login. Keeping them separate means an account is
    // never created as a side effect of a click on a queue row.
    if (action === "PROVISION") {
      if (row.status !== "APPROVED") {
        return NextResponse.json(
          { success: false, error: "Approve the request first, then provision the workspace." },
          { status: 409 },
        );
      }
      if (row.createdOrganizationId) {
        return NextResponse.json(
          { success: false, error: `Already provisioned as organization #${row.createdOrganizationId}.` },
          { status: 409 },
        );
      }
      if (!row.contactEmail) {
        return NextResponse.json(
          { success: false, error: "This request has no email address — add one before provisioning." },
          { status: 400 },
        );
      }
      const orgName = String(body.name || row.businessName || "").trim();
      if (!orgName) {
        return NextResponse.json({ success: false, error: "An organization name is required." }, { status: 400 });
      }
      invalidatePublicCaches();
      try {
        const result = await provisionOrganization(actor, {
          name: orgName,
          ownerName: String(body.ownerName || row.contactName || "").trim(),
          ownerEmail: row.contactEmail,
          ownerPhone: row.contactPhone,
          contactPhone: row.contactPhone,
        });
        const [updated] = await db
          .update(platformRequests)
          .set({
            ...base,
            status: "APPROVED",
            createdOrganizationId: result.organization.id,
            createdOwnerUserId: result.owner.id,
            decisionReason: reason || row.decisionReason,
          })
          .where(eq(platformRequests.id, id))
          .returning();
        await writePlatformTrail(
          actor,
          "PROVISION_PLATFORM_REQUEST",
          "PLATFORM_REQUEST",
          row.reference,
          `Provisioned organization "${result.organization.name}" (#${result.organization.id}) from request ${row.reference}; ` +
            `OWNER ${result.owner.name} <${result.owner.email}> (user #${result.owner.id}).`,
          null,
        );
        // The workspace now exists — nothing is left to do for this request, so
        // its bell row is retired instead of nagging forever.
        await syncPlatformRequestBells({
          reference: row.reference,
          status: updated.status,
          createdOrganizationId: result.organization.id,
          businessName: row.businessName,
          contactName: row.contactName,
        });
        return NextResponse.json({
          success: true,
          request: { ...updated, purposeLabel: purposeLabel(updated.purpose), businessTypeLabel: businessTypeLabel(updated.businessType) },
          organization: result.organization,
          owner: result.owner,
          // Returned ONCE, never persisted, never put in a notification body.
          initialPassword: result.initialPassword,
        });
      } catch (e: any) {
        if (e instanceof ProvisionError) {
          // A duplicate email may mean this very request already created its
          // workspace on an earlier attempt that never got stamped (a crash
          // between the two writes). Adopt it rather than failing forever.
          if (e.status === 409) {
            const recovered: any = await findProvisionedWorkspaceForRecovery(row.contactEmail, row.createdAt);
            if (recovered && !recovered.__claimedByRequestId) {
              const [stamped] = await db
                .update(platformRequests)
                .set({
                  ...base,
                  status: "APPROVED",
                  createdOrganizationId: recovered.organization.id,
                  createdOwnerUserId: recovered.owner.id,
                  decisionReason: reason || row.decisionReason,
                })
                .where(eq(platformRequests.id, id))
                .returning();
              await syncPlatformRequestBells({
                reference: row.reference,
                status: "APPROVED",
                createdOrganizationId: recovered.organization.id,
                businessName: row.businessName,
                contactName: row.contactName,
              });
              await writePlatformTrail(
                actor,
                "PROVISION_PLATFORM_REQUEST",
                "PLATFORM_REQUEST",
                row.reference,
                `Recovered a previously created workspace for request ${row.reference}: organization ` +
                  `"${recovered.organization.name}" (#${recovered.organization.id}) with OWNER ` +
                  `${recovered.owner.name} <${recovered.owner.email}> (user #${recovered.owner.id}). ` +
                  `The account existed but the request had not been stamped.`,
                null,
              );
              return NextResponse.json({
                success: true,
                recovered: true,
                request: { ...stamped, purposeLabel: purposeLabel(stamped.purpose), businessTypeLabel: businessTypeLabel(stamped.businessType) },
                organization: recovered.organization,
                owner: recovered.owner,
                // No password is issued on recovery: the account's password was
                // already set by the original attempt. The Super Admin resets it
                // if the intended Owner never received it.
                initialPassword: null,
              });
            }
          }
          return NextResponse.json({ success: false, error: e.message }, { status: e.status });
        }
        throw e;
      }
    }

    // ── Status transitions ────────────────────────────────────────────────
    const nextStatus: Record<Exclude<StatusAction, "PROVISION">, string> = {
      START_REVIEW: "IN_REVIEW",
      NEEDS_INFO: "NEEDS_INFO",
      APPROVE: "APPROVED",
      REJECT: "REJECTED",
      CLOSE: "CLOSED",
    };
    const status = nextStatus[action as Exclude<StatusAction, "PROVISION">];

    // A rejection must say why — it is the record of a decision that affects a
    // real business, and the operator may have to explain it later.
    if (action === "REJECT" && !reason) {
      return NextResponse.json({ success: false, error: "Please give a reason for rejecting." }, { status: 400 });
    }

    const [updated] = await db
      .update(platformRequests)
      .set({ ...base, status, decisionReason: reason ?? row.decisionReason })
      .where(eq(platformRequests.id, id))
      .returning();

    await writePlatformTrail(
      actor,
      `PLATFORM_REQUEST_${action}`,
      "PLATFORM_REQUEST",
      row.reference,
      `${purposeLabel(row.purpose)}${row.businessName ? ` — ${row.businessName}` : ""}: ${row.status} → ${status}` +
        (reason ? `. Reason: ${reason}` : "."),
      null,
    );

    // Keep the Super Admins' bells in step with the decision (title, body and
    // read state) so the badge never nags about finished work.
    await syncPlatformRequestBells({
      reference: row.reference,
      status,
      createdOrganizationId: updated.createdOrganizationId,
      businessName: row.businessName,
      contactName: row.contactName,
      decisionReason: reason,
    });

    return NextResponse.json({
      success: true,
      request: { ...updated, purposeLabel: purposeLabel(updated.purpose), businessTypeLabel: businessTypeLabel(updated.businessType) },
    });
  } catch (error: any) {
    return apiError(error);
  }
}
