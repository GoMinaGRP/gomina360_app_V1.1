/**
 * platformRequests — the "Join / Register on the Platform" pipeline.
 *
 * SERVER-SAFE + CLIENT-SAFE split: this module holds only constants, types and
 * pure validators (no DB import), so the public `/join` page can render the
 * purpose choices from the SAME allowlist the API enforces. The database
 * access lives in the API route.
 *
 * SECURITY POSTURE
 * ----------------
 *  • `purpose` is validated against PLATFORM_REQUEST_PURPOSES. An unknown
 *    value is refused (400) — never stored raw, never echoed back.
 *  • The anonymous submitter receives ONLY an opaque reference code. There is
 *    no public read, no status lookup and no id in the response.
 *  • Every read/decide path is gated on `requireSuperAdmin()`.
 *  • The table has no tenant column, so tenant-scoped queries cannot match it.
 */
import { BUSINESS_TYPES } from "@/lib/businessTypeKeys";

export const PLATFORM_REQUEST_PURPOSES = [
  {
    key: "JOIN_PLATFORM",
    label: "Register my business on GoMina 360",
    hint: "Run my shop, farm, factory or store on the platform.",
  },
  {
    key: "REQUEST_DEMO",
    label: "Request a demo / walkthrough",
    hint: "See the modules working on real data before deciding.",
  },
  {
    key: "SALES_PRICING",
    label: "Plans, pricing & billing",
    hint: "What it costs, what is included, how to pay.",
  },
  {
    key: "PARTNERSHIP",
    label: "Partnership / supplier / integration",
    hint: "Resell, supply, integrate or partner with GoMina 360.",
  },
  {
    key: "SUPPORT",
    label: "Help with an existing account or order",
    hint: "Something is not working, or you need assistance.",
  },
  {
    key: "OTHER",
    label: "Something else",
    hint: "Any other question for the platform team.",
  },
] as const;

export type PlatformRequestPurpose = (typeof PLATFORM_REQUEST_PURPOSES)[number]["key"];

export const PLATFORM_REQUEST_PURPOSE_KEYS: string[] = PLATFORM_REQUEST_PURPOSES.map((p) => p.key);

export const PLATFORM_REQUEST_STATUSES = [
  "PENDING",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "CLOSED",
] as const;

export type PlatformRequestStatus = (typeof PLATFORM_REQUEST_STATUSES)[number];

/** Statuses that still need the Super Admin's attention (drives the badge). */
export const OPEN_PLATFORM_REQUEST_STATUSES: string[] = ["PENDING", "IN_REVIEW", "NEEDS_INFO"];

export function purposeLabel(key: string): string {
  return PLATFORM_REQUEST_PURPOSES.find((p) => p.key === key)?.label || String(key || "");
}

/** Human label for a BUSINESS_TYPES key (falls back to the raw value). */
export function businessTypeLabel(key: string | null | undefined): string {
  if (!key) return "";
  return BUSINESS_TYPES.find((t) => t.key === key)?.label || String(key);
}

/**
 * Business-type choices offered on /join — the platform's own catalogue, so a
 * prospect can say what they run even before they have an account.
 */
export const PLATFORM_REQUEST_BUSINESS_TYPES: { key: string; label: string }[] = BUSINESS_TYPES.map(
  (t) => ({ key: t.key, label: t.label }),
);

/** Field caps — mirrored by the API so the UI and the server agree. */
export const PLATFORM_REQUEST_LIMITS = {
  businessName: 160,
  contactName: 120,
  contactEmail: 160,
  contactPhone: 40,
  location: 160,
  message: 1500,
} as const;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + cap; empty ⇒ null. */
export function cleanField(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().slice(0, max);
  return s === "" ? null : s;
}

/** Reference alphabet — no 0/O/1/I so a code can be read aloud unambiguously. */
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** An opaque, requester-facing code, e.g. `GMR-7F3K2Q`. */
export function makePlatformRequestReference(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return `GMR-${out}`;
}

/** The exact public success copy — one place, so tests and UI agree. */
/**
 * ACTIONABILITY — the single source of truth for "does this request still need
 * something from the platform team?".
 *
 * Four surfaces must never disagree about that question: the Super Admin's bell
 * (unread + title), the Action Center's live list, the review-queue badge, and
 * the row's status chip. They all derive from these helpers, so a request cannot
 * be handled in one place while still demanding attention in another.
 *
 *   PENDING / IN_REVIEW / NEEDS_INFO .................. still being reviewed
 *   APPROVED with no workspace yet .................... approved, needs PROVISION
 *   APPROVED once the workspace exists, REJECTED, CLOSED — nothing left to do
 */
export function isPlatformRequestActionable(
  status: string | null | undefined,
  createdOrganizationId?: number | null,
): boolean {
  const s = String(status || "").toUpperCase();
  if (OPEN_PLATFORM_REQUEST_STATUSES.includes(s)) return true;
  // Approval is a decision; provisioning is the separate action that completes
  // it. Until the workspace exists the request is still on the platform's plate.
  return s === "APPROVED" && createdOrganizationId == null;
}

/**
 * Bell-row title for a request in its current state. Every notification about a
 * request is UPDATED in place when the request moves (see
 * `syncPlatformRequestBells`), so the bell always names the outstanding action
 * instead of repeating "New platform request" for work already done.
 */
export function platformRequestBellTitle(
  status: string | null | undefined,
  createdOrganizationId?: number | null,
): string {
  const s = String(status || "").toUpperCase();
  if (s === "APPROVED") {
    return createdOrganizationId != null
      ? "Platform request fulfilled — workspace created"
      : "Platform request approved — provision the workspace";
  }
  if (s === "REJECTED") return "Platform request rejected";
  if (s === "CLOSED") return "Platform request closed";
  if (s === "IN_REVIEW") return "Platform request in review";
  if (s === "NEEDS_INFO") return "Platform request awaiting the applicant";
  return "New platform request";
}

export const PLATFORM_REQUEST_RECEIVED_MESSAGE =
  "Request received. Keep your reference code — the platform team will get back to you.";

/**
 * Per-IP throttle policy for the public submit. Deliberately far stricter than
 * the storefront order endpoint (30/min): a genuine prospect submits once, so a
 * long window costs nothing and starves sprayers.
 */
export const PLATFORM_REQUEST_THROTTLE = {
  /** Burst guard — blocks scripted hammering within the hour window. */
  burst: { limit: 3, windowMs: 60_000 },
  /** Sustained guard — 5 submissions per hour per IP. */
  sustained: { limit: 5, windowMs: 3_600_000 },
} as const;

/** Honeypot field name. Bots fill hidden inputs; humans never see it. */
export const PLATFORM_REQUEST_HONEYPOT = "companyWebsite";
