/**
 * Shared phone-number validation for customer contact points.
 *
 * Rules (international-friendly, Ghana-first):
 *  - separators / formatting characters (space . - ( )) are ignored;
 *  - the remaining value must be digits with an optional leading "+";
 *  - digit count must sit between MIN_DIGITS and MAX_DIGITS
 *    (Ghana local = 10 digits; +233 international = 12 digits; E.164 max = 15).
 *
 * The same verdict powers the storefront checkout (live error under the
 * field), the staff "new customer order" modal, and the server-side API
 * guards — so a number that passes the form can never be rejected by the
 * API (and vice-versa).
 */

export const PHONE_MIN_DIGITS = 9;
export const PHONE_MAX_DIGITS = 15;
/** Storefront customer numbers are Ghana-local: exactly 10 digits. */
export const PHONE_EXACT_DIGITS_STOREFRONT = 10;

export interface PhoneVerdict {
  ok: boolean;
  /** Canonical value to store / send (digits, optional leading +). */
  value: string;
  /** Human-readable reason when ok === false; "" when valid. */
  error: string;
}

export interface PhoneOptions {
  /**
   * When set, the number must contain EXACTLY this many digits and must be
   * a plain local number (no "+" country-code prefix). Used by the customer
   * storefront where the business requires a 10-digit Ghana number.
   */
  exactDigits?: number;
}

export function validatePhone(raw: string | null | undefined, opts?: PhoneOptions): PhoneVerdict {
  const input = String(raw ?? "").trim();
  if (!input) {
    return { ok: false, value: "", error: "Please enter a phone number we can reach you on." };
  }
  // Strip common formatting characters only — anything else is invalid.
  const condensed = input.replace(/[\s().\-/]/g, "");
  const exact = opts?.exactDigits;
  if (exact && condensed.startsWith("+")) {
    return {
      ok: false,
      value: condensed,
      error: `Enter the ${exact}-digit number without the country code (like 0551234567).`,
    };
  }
  if (!/^\+?\d+$/.test(condensed)) {
    return {
      ok: false,
      value: condensed,
      error: "Phone numbers can only contain digits (optionally starting with '+') — no letters or other characters.",
    };
  }
  const digits = condensed.replace(/\D/g, "");
  if (exact) {
    if (digits.length !== exact) {
      return {
        ok: false,
        value: condensed,
        error: `That phone number must be exactly ${exact} digits (like 0551234567) — you entered ${digits.length} digit${digits.length === 1 ? "" : "s"}.`,
      };
    }
    return { ok: true, value: condensed, error: "" };
  }
  if (digits.length < PHONE_MIN_DIGITS) {
    return {
      ok: false,
      value: condensed,
      error: `That phone number is too short (${digits.length} digit${digits.length === 1 ? "" : "s"}) — enter at least ${PHONE_MIN_DIGITS} digits.`,
    };
  }
  if (digits.length > PHONE_MAX_DIGITS) {
    return {
      ok: false,
      value: condensed,
      error: `That phone number is too long (${digits.length} digits) — ${PHONE_MAX_DIGITS} digits is the maximum (with country code).`,
    };
  }
  return { ok: true, value: condensed, error: "" };
}
