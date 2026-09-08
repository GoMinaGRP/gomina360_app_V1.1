// Company / business / branch logo resolution — single source of truth for
// every generated document (invoices, receipts, quotations, payslips,
// reports, statements, PDFs).
//
// Precedence: branch logo → business logo → company logo → none.
// Logos live on the businesses rows (logo, branchLogos) and the
// company_settings row (companyLogo); the bootstrap payload carries them so
// every screen resolves the same way — saved centrally, consistent everywhere.

let _companyLogo: string | null = null;

/** Called once after the app bootstrap loads. */
export function setCompanyLogo(logo: string | null | undefined) {
  _companyLogo = logo || null;
}

export function getCompanyLogo(): string | null {
  return _companyLogo;
}

/** Resolve the correct logo for a record: its branch, else its business,
 *  else the GoMina company logo. `business` is a businesses row (or null). */
export function resolveLogo(
  business: { logo?: string | null; branchLogos?: any } | null | undefined,
  branchCode?: string | null
): string | null {
  if (business) {
    const code = (branchCode || "").toUpperCase().trim();
    const map = business.branchLogos || {};
    if (code && map && typeof map === "object" && map[code]) return map[code];
    if (business.logo) return business.logo;
  }
  return _companyLogo;
}
