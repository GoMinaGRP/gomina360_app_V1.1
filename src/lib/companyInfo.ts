/**
 * GoMina 360 — Company Information
 *
 * Central configuration for all company details displayed on invoices,
 * quotations, receipts, and other official documents. Update these
 * values when the company registration or contact details change.
 */

export interface CompanyInfo {
  name: string;
  tagline: string;
  registrationNumber: string;
  taxId: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  city: string;
  region: string;
  country: string;
  postalCode: string;
}

export const COMPANY_INFO: CompanyInfo = {
  name: "GoMina 360 Enterprise Group",
  tagline: "All-In-One Enterprise Management & Decision-Support System",
  registrationNumber: "GH-REG-2024-00360",
  taxId: "TIN-C0003600360",
  phone: "+233 24 000 0360",
  email: "admin@gomina360.com",
  website: "www.gomina360.com",
  address: "Plot 12, Liberation Road",
  city: "Accra",
  region: "Greater Accra",
  country: "Ghana",
  postalCode: "GA-000-0360",
};

/**
 * Returns a multi-line address string for use in PDF footers / headers.
 */
export function companyAddressBlock(): string[] {
  return [
    COMPANY_INFO.name,
    COMPANY_INFO.address,
    `${COMPANY_INFO.city}, ${COMPANY_INFO.region} — ${COMPANY_INFO.country}`,
    `Tel: ${COMPANY_INFO.phone} | Email: ${COMPANY_INFO.email}`,
    `Reg: ${COMPANY_INFO.registrationNumber} | TIN: ${COMPANY_INFO.taxId}`,
  ];
}
