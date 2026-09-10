import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 1. Users & Role-Based Access Control
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull(), // 'OWNER', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'ACCOUNTANT', 'SUPERVISOR', 'WORKER'
  assignedBusinessId: integer("assigned_business_id"), // null = All businesses (Owner/Executive); required for WORKER & BRANCH_MANAGER
  phone: text("phone").notNull(),
  avatarUrl: text("avatar_url"),
  // Standardized Ghana location (Region → District/MMDA → Town)
  region: text("region"),
  district: text("district"),
  town: text("town"),
  isActive: boolean("is_active").default(true),
  isWorkerEnabled: boolean("is_worker_enabled").default(true), // BRANCH_MANAGER can enable/disable WORKER accounts
  createdByUserId: integer("created_by_user_id"), // which BRANCH_MANAGER created this WORKER
  canRecordSales: boolean("can_record_sales").default(true),
  canRecordExpenses: boolean("can_record_expenses").default(false), // requires BRANCH_MANAGER permission
  canManageStock: boolean("can_manage_stock").default(false),      // requires BRANCH_MANAGER permission
  canExportData: boolean("can_export_data").default(false),        // BRANCH_MANAGER & WORKER export permission toggle
  // OWNER-granted permission to manage (edit) & delete shared enterprise records
  // (Transactions & MoMo, Suppliers & Vendors, Employees & Payroll). The OWNER
  // always retains full control; managers act only while this flag is granted.
  canManageRecords: boolean("can_manage_records").default(false),
  // OWNER-granted "delete-inventory" permission: a non-OWNER may only manage,
  // edit and delete Inventory & Stock entries while this flag is granted. The
  // OWNER always retains full control. Like canManageRecords this is a
  // user-level grant (not per-business), so it applies uniformly to inventory
  // entries of every business type — existing or newly created. Grant/revoke
  // is OWNER-only.
  canDeleteInventory: boolean("can_delete_inventory").default(false),
  // OWNER-granted "manage-expenses" permission: a non-OWNER may only edit and
  // delete EXPENSE transactions while this flag is granted. The OWNER always
  // retains full control. Like canManageRecords and canDeleteInventory this is
  // a user-level grant (not per-business), so it applies uniformly to the
  // expenses of every business type and branch — existing or newly created.
  // Grant/revoke is OWNER-only.
  canManageExpenses: boolean("can_manage_expenses").default(false),
  // OWNER-delegated user administration: a BRANCH_MANAGER / GENERAL_MANAGER
  // carrying this flag may open Users & Access and create workers AND branch
  // managers, assign role/business/branch/permissions, and edit or deactivate
  // users inside their own accessible branch scope. Grant/revoke is OWNER-only.
  canManageUsers: boolean("can_manage_users").default(false),
  // OWNER-granted CCTV management: lets a manager add, edit, test, reassign and
  // remove cameras — strictly inside the businesses they can access (primary
  // assignment + explicit grants). The OWNER always manages every camera
  // group-wide. Grant/revoke is OWNER-only.
  canManageCctv: boolean("can_manage_cctv").default(false),
  // OWNER-granted Auditor-access delegation: lets a manager grant, scope and
  // revoke Auditor access — deciding what auditors may review and which
  // businesses/branches they can audit — strictly inside the manager's own
  // accessible businesses. The OWNER always controls every Auditor
  // permission group-wide. Grant/revoke is OWNER-only.
  canManageAuditors: boolean("can_manage_auditors").default(false),
  // OWNER-granted Online Storefront & Delivery Areas management: the user may
  // open Manage Businesses → Online and control the storefront switches,
  // service areas/localities, pickup locations and customer help / MoMo
  // payment numbers — strictly inside the businesses/branches they can
  // access (primary assignment + explicit grants). The OWNER always manages
  // every unit group-wide; grant/revoke is OWNER-only.
  canManageOnline: boolean("can_manage_online").default(false),
  // OWNER-granted "New Branch/Unit" permission: the user may create new
  // business units (POST /api/businesses) — the GO gate for expansion. The
  // OWNER always creates units; grant/revoke is OWNER-only.
  canCreateBusiness: boolean("can_create_business").default(false),
  // OWNER-granted "Finance & Reports – Enterprise Users" permission: a
  // non-executive holding it may open the enterprise Finance & Reports tab,
  // strictly scoped to the businesses they can already access (primary
  // assignment + explicit grants). OWNER/GM always see it; grant/revoke is
  // OWNER-only.
  canViewFinance: boolean("can_view_finance").default(false),
  // OWNER-granted "Customer Support — storefront HELP" permission: the user
  // may add & edit the group-wide customer support information (contact name,
  // phone, WhatsApp, email, address/location, opening hours, extra notes)
  // that shoppers see inside the storefront's HELP panel. The OWNER always
  // edits it; grant/revoke is OWNER-only.
  canManageSupport: boolean("can_manage_support").default(false),
  // OWNER-granted "Manage Business / Unit" delegation: the list of business
  // ids this user may manage with OWNER-equivalent power — full dashboard,
  // records, settings and management functions — strictly for THOSE units
  // only. Every other business stays out of reach. Grant/revoke is
  // OWNER-only. (Stored as a JSONB array of integer business ids.)
  businessManageIds: jsonb("business_manage_ids").$type<number[]>(),
  // ── Secure login ──────────────────────────────────────────────────────
  // scrypt password hash (format "scrypt:<salt_hex>:<hash_hex>"); null until
  // the OWNER sets a password for the account.
  passwordHash: text("password_hash"),
  passwordChangedAt: timestamp("password_changed_at"),
  failedLoginAttempts: integer("failed_login_attempts").default(0),
  lockedUntil: timestamp("locked_until"),
  // Access-control audit: set when the OWNER (or an owner-authorized user
  // manager) REVOKES access entirely — sessions killed, password cleared,
  // and re-admission requires an explicit owner re-enable + password reset.
  // Null while access is ACTIVE or only temporarily DISABLED.
  accessRevokedAt: timestamp("access_revoked_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Server-side login sessions. Only the SHA-256 hash of the bearer token is
// stored, so a database leak never exposes usable tokens.
// ended_at/end_reason turn sign-out into a soft close so the Signed-In Staff
// console can report every user's last LOGIN and last LOGOUT time:
//   LOGOUT (user signed out) · DISABLED / REVOKED (access cut by management)
//   · FORCE_LOGOUT (owner signed the user out) · EXPIRED (TTL purge).
// revoked_at "parks" an otherwise-valid session: set by the client's
// pagehide/hidden heartbeat when the browser session actually closes,
// cleared again on the next active beat — drives the live Online/Idle chip.
export const userSessions = pgTable("user_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  endedAt: timestamp("ended_at"),
  endReason: text("end_reason"),
  revokedAt: timestamp("revoked_at"),
});

// OWNER-granted business access (in addition to the user's primary
// assigned_business_id). Effective access = assignment ∪ these grants;
// the OWNER implicitly accesses everything.
export const userBusinessAccess = pgTable("user_business_access", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  businessId: integer("business_id").notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Immutable audit trail of every shared-record deletion: WHO deleted WHAT,
// WHEN (date + time) and WHY (mandatory reason), with a full snapshot of the
// removed record so nothing is ever lost without trace.
export const recordDeletionLogs = pgTable("record_deletion_logs", {
  id: serial("id").primaryKey(),
  module: text("module").notNull(), // 'TRANSACTIONS' | 'SUPPLIERS' | 'EMPLOYEES'
  recordId: integer("record_id").notNull(),
  recordLabel: text("record_label").notNull(), // e.g. TRX-2026-4521, 'Ghafeed Ltd'
  recordSnapshot: jsonb("record_snapshot"), // full row at moment of deletion
  reason: text("reason").notNull(),
  deletedByUserId: integer("deleted_by_user_id"),
  deletedByName: text("deleted_by_name").notNull(),
  deletedByRole: text("deleted_by_role").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// 2. Businesses / Branches / Locations
export const businesses = pgTable("businesses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(), // e.g. POULTRY-01, BLOCK-01
  category: text("category").notNull(), // 'Poultry Farm', 'Block Factory', 'Aquaculture', 'Livestock', 'Restaurant & Food', 'Electronic Shop', 'Car Wash', 'Hardware Store'
  branchLocation: text("branch_location").notNull(), // human-readable summary line
  // Standardized Ghana location (Region → District/MMDA → Town)
  region: text("region").notNull(), // one of the 16 official regions
  district: text("district"), // MMDA (dropdown or free text)
  town: text("town"), // town / community (free text)
  managerName: text("manager_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  status: text("status").default("ACTIVE"), // 'ACTIVE', 'EXPANDING', 'MAINTENANCE'
  initialCapitalGhs: doublePrecision("initial_capital_ghs").notNull(),
  monthlyTargetRevenueGhs: doublePrecision("monthly_target_revenue_ghs").notNull(),
  iconName: text("icon_name").default("Building2"),
  // Branding — business logo (base64 data URL) and per-branch overrides.
  // Resolution on documents: branch logo → business logo → company logo.
  logo: text("logo"),
  branchLogos: jsonb("branch_logos"), // { "BRANCH-CODE": "data:image/..." }
  // GPS anchor for attendance geofencing: set once by the OWNER / authorized
  // manager from the branch itself; clock events farther than gpsRadiusM
  // metres are flagged off-site. Nullable — unanchored branches simply skip
  // the off-site check.
  gpsLat: doublePrecision("gps_lat"),
  gpsLng: doublePrecision("gps_lng"),
  gpsRadiusM: integer("gps_radius_m").default(300),
  // Online ordering & service area — managed by the OWNER / authorized staff
  // (Manage Businesses → Online); consumed by the public storefront
  // (/api/menu picker, /api/order enforcement). onlineOrderingEnabled=false
  // removes the unit from the customer storefront entirely. serviceRadiusKm
  // NULL = no geographic limit; when set WITH a GPS anchor, out-of-area
  // delivery pins are refused at checkout and the storefront's
  // "serving my location" filter hides the unit beyond the radius.
  onlineOrderingEnabled: boolean("online_ordering_enabled").default(true),
  pickupEnabled: boolean("pickup_enabled").default(true),
  deliveryEnabled: boolean("delivery_enabled").default(true),
  serviceRadiusKm: doublePrecision("service_radius_km"),
  serviceNote: text("service_note"), // customer-facing, e.g. "Free delivery in Spintex"
  // Customer-facing contact points shown right after an online order is
  // placed and on the public /track page. Managed from Manage Businesses →
  // Online by the OWNER / staff carrying the canManageOnline grant.
  customerHelpPhone: text("customer_help_phone"), // "Need help? Call/WhatsApp …"
  momoNumber: text("momo_number"), // mobile-money number customers pay to
  momoName: text("momo_name"), // payee name shown beside the MoMo number
  createdAt: timestamp("created_at").defaultNow(),
});

// Service areas / localities a Business (branch unit) delivers to. Every
// unit defines its OWN list — different branches serve different areas. An
// area carries a name (required) plus an optional Google-Maps centre +
// radius used by the storefront's "serving my location" filter and by
// checkout enforcement; name-only areas are advisory (listed to customers,
// never used to hide or refuse). Managed by the OWNER (all units) or staff
// with the canManageOnline grant (their accessible units only).
export const serviceAreas = pgTable("service_areas", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(), // Business → Branch chain
  branchCode: text("branch_code").notNull(),
  name: text("name").notNull(), // e.g. "Osu", "East Legon", "Spintex Corridor"
  centerLat: doublePrecision("center_lat"), // Google-Maps centre (optional)
  centerLng: doublePrecision("center_lng"),
  radiusKm: doublePrecision("radius_km"), // coverage ring around the centre
  note: text("note"), // customer-facing, e.g. "Same-day before 2pm"
  active: boolean("active").default(true),
  sortOrder: integer("sort_order").default(0),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pickup locations a Business (branch unit) offers online customers. A unit
// may run several (main shop, depot, partner point…); when at least one is
// active the storefront makes the customer choose one for PICKUP orders and
// the choice is snapshotted onto the order/tracking (chain stays intact even
// if the location is edited or removed later). Managed by the OWNER (all
// units) or staff with the canManageOnline grant (their accessible units).
export const pickupLocations = pgTable("pickup_locations", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(), // Business → Branch chain
  branchCode: text("branch_code").notNull(),
  name: text("name").notNull(), // e.g. "Spintex Depot", "Osu Shopfront"
  address: text("address"), // human-readable directions
  lat: doublePrecision("lat"), // Google-Maps point (optional)
  lng: doublePrecision("lng"),
  contactPhone: text("contact_phone"),
  instructions: text("instructions"), // e.g. "Ask for the blue gate"
  active: boolean("active").default(true),
  sortOrder: integer("sort_order").default(0),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** Group-wide company settings (single live row, id=1) — the GoMina
 *  company logo used as the ultimate fallback on every generated document,
 *  and on group-level reports that span multiple businesses. */
export const companySettings = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyLogo: text("company_logo"),
  updatedByUserId: integer("updated_by_user_id"),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** Group-wide customer support information (single live row, id=1) — shown to
 *  shoppers inside the public storefront's HELP panel (contact name, phone,
 *  WhatsApp, email, business address/location, opening hours, extra notes).
 *  Written only by the OWNER or a user the OWNER granted canManageSupport;
 *  read publicly (no login) so every customer can reach support. */
export const customerSupportInfo = pgTable("customer_support_info", {
  id: serial("id").primaryKey(),
  contactName: text("contact_name"),
  phone: text("phone"),
  whatsapp: text("whatsapp"),
  email: text("email"),
  address: text("address"),
  openingHours: text("opening_hours"),
  extraInfo: text("extra_info"),
  updatedByUserId: integer("updated_by_user_id"),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 3. Overall Financial Performance & Performance Metrics per Business
export const businessMetrics = pgTable("business_metrics", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  period: text("period").notNull(), // e.g. "2026-Q1", "2026-March"
  revenueGhs: doublePrecision("revenue_ghs").notNull(),
  expensesGhs: doublePrecision("expenses_ghs").notNull(),
  netProfitGhs: doublePrecision("net_profit_ghs").notNull(),
  roiPercent: doublePrecision("roi_percent").notNull(),
  cashFlowGhs: doublePrecision("cash_flow_ghs").notNull(),
  assetsValueGhs: doublePrecision("assets_value_ghs").notNull(),
  inventoryValueGhs: doublePrecision("inventory_value_ghs").notNull(),
  growthRatePercent: doublePrecision("growth_rate_percent").notNull(),
  riskScore: integer("risk_score").notNull(), // 1 to 100 (low is better)
  lastUpdated: timestamp("last_updated").defaultNow(),
});

// 4. Customers & CRM across Businesses
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'WHOLESALE', 'RETAIL', 'CORPORATE', 'DISTRIBUTOR'
  phone: text("phone").notNull(),
  email: text("email"),
  address: text("address"),
  // Standardized Ghana location (Region → District/MMDA → Town)
  region: text("region"),
  district: text("district"),
  town: text("town"),
  totalSpentGhs: doublePrecision("total_spent_ghs").default(0),
  loyaltyPoints: integer("loyalty_points").default(0),
  businessId: integer("business_id"), // null if shared across multiple units
  createdAt: timestamp("created_at").defaultNow(),
});

// 5. Suppliers & Vendors
export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // e.g. 'Poultry Feed', 'Cement & Aggregates', 'Fish Fingerlings', 'Electronics Import'
  contactPerson: text("contact_person").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  paymentTerms: text("payment_terms").notNull(), // 'NET_14', 'NET_30', 'CASH_ON_DELIVERY', 'MOMO_INSTANT'
  // Standardized Ghana location (Region → District/MMDA → Town)
  region: text("region"),
  district: text("district"),
  town: text("town"),
  totalSuppliedGhs: doublePrecision("total_supplied_ghs").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// 6. Employees & Payroll (in GH₵)
export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(), // e.g. "Farm Supervisor", "Cement Mixer Operator", "Head Chef", "Solar Specialist"
  businessId: integer("business_id").notNull(),
  branch: text("branch").notNull(),
  // Standardized Ghana location (Region → District/MMDA → Town)
  region: text("region"),
  district: text("district"),
  town: text("town"),
  salaryGhs: doublePrecision("salary_ghs").notNull(),
  phone: text("phone").notNull(),
  hireDate: text("hire_date").notNull(),
  status: text("status").default("ACTIVE"),
  // ── Employee Registration profile (added for the complete HR record) ──
  // All nullable so legacy/seeded rows stay valid; employeeNo backfilled.
  employeeNo: text("employee_no"), // unique staff ID, e.g. EMP-0007
  dateOfBirth: text("date_of_birth"), // YYYY-MM-DD
  gender: text("gender"), // MALE | FEMALE | OTHER
  email: text("email"),
  address: text("address"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  photo: text("photo"), // base64 data URL (upload or camera capture)
  // Attendance profile — drives scheduling & payroll checks
  workSchedule: text("work_schedule"), // FULL_TIME | PART_TIME | CONTRACT
  shift: text("shift"), // DAY | NIGHT | ROTATING
  dailyHours: doublePrecision("daily_hours"),
  workDays: text("work_days"), // e.g. "MON,TUE,WED,THU,FRI"
  leaveEntitlementDays: integer("leave_entitlement_days"), // annual leave days
  // Identity & compliance
  idType: text("id_type"), // GHANA_CARD | PASSPORT | VOTER_ID | DRIVERS_LICENSE | OTHER
  idNumber: text("id_number"),
  workPermitNo: text("work_permit_no"), // where applicable (non-citizens)
  notes: text("notes"),
});

/** Employee documents — contracts, certificates, qualifications, work
 *  permits, ID copies and any other files (base64 data-URL payloads, the
 *  app's existing photo-storage convention). */
export const employeeDocuments = pgTable("employee_documents", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  businessId: integer("business_id").notNull(), // denormalized for access scoping
  docType: text("doc_type").notNull(), // EMPLOYMENT_CONTRACT | CERTIFICATE | QUALIFICATION | WORK_PERMIT | ID_COPY | OTHER
  title: text("title").notNull(),
  fileName: text("file_name"),
  fileData: text("file_data"), // base64 data URL (image or PDF)
  issuedOn: text("issued_on"),
  expiresOn: text("expires_on"),
  note: text("note"),
  uploadedByUserId: integer("uploaded_by_user_id"),
  uploadedByName: text("uploaded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

/** Employee record history — immutable audit trail of every important
 *  change (registration, field edits with old → new, photo updates,
 *  document add/remove), stamped with who did it. */
export const employeeHistory = pgTable("employee_history", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  businessId: integer("business_id").notNull(),
  action: text("action").notNull(), // CREATED | UPDATED | PHOTO_UPDATED | DOCUMENT_ADDED | DOCUMENT_REMOVED
  field: text("field"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  summary: text("summary").notNull(),
  changedByUserId: integer("changed_by_user_id"),
  changedByName: text("changed_by_name"),
  changedByRole: text("changed_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 7. Enterprise Assets & Equipment
// Every asset MUST be linked to a Business and a Branch at registration.
// The pair (businessId, branchCode) is the enterprise reporting key that ties
// asset values into business + branch dashboards, reports and analytics.
export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  assetCode: text("asset_code").notNull().unique().default(""), // unique enterprise asset code (required)
  name: text("name").notNull(),
  description: text("description"), // detailed notes/specs about the asset
  businessId: integer("business_id").notNull(), // parent business (required)
  branchCode: text("branch_code").notNull().default(""), // branch code within the business (required)
  branchName: text("branch_name"), // human-readable branch label captured at registration
  assetType: text("asset_type").notNull(), // 'MACHINERY', 'VEHICLE', 'GENERATOR', 'STRUCTURE', 'TECH'
  purchasePriceGhs: doublePrecision("purchase_price_ghs").notNull(),
  currentValueGhs: doublePrecision("current_value_ghs").notNull(),
  condition: text("condition").notNull(), // 'EXCELLENT', 'GOOD', 'NEEDS_MAINTENANCE', 'UNDER_REPAIR'
  location: text("location").notNull(), // on-site placement note (e.g. "Bay A")
  // Standardized Ghana location (Region → District/MMDA → Town) — auto-copied from the branch
  region: text("region"),
  district: text("district"),
  town: text("town"),
  nextMaintenanceDate: text("next_maintenance_date").notNull(),
  registeredByUserId: integer("registered_by_user_id"), // audit trail
  recorderName: text("recorder_name"), // name of the user who recorded the asset
  recordedAt: timestamp("recorded_at").defaultNow(), // automatic date/time stamp
  assetImages: jsonb("asset_images"), // array of uploaded image data URLs / URLs
  /** QR identity tag — globally unique when set; scanned or auto-generated at
   *  registration and printed on the asset tag. */
  qrCode: text("qr_code"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("assets_qr_code_unique").on(t.qrCode),
]);

// 7b. Complete Asset & Equipment audit log + approval workflow
export const assetAuditLogs = pgTable("asset_audit_logs", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull(),
  assetCode: text("asset_code").notNull(),
  action: text("action").notNull(), // CREATE, EDIT, TRANSFER, DELETE, REQUEST_EDIT, REQUEST_TRANSFER, REQUEST_DELETE, APPROVE, REJECT
  status: text("status").notNull().default("COMPLETED"), // PENDING, APPROVED, REJECTED, COMPLETED
  requestedByUserId: integer("requested_by_user_id"),
  requestedByName: text("requested_by_name"),
  requestedByRole: text("requested_by_role"),
  approvedByUserId: integer("approved_by_user_id"),
  approvedByName: text("approved_by_name"),
  detailsJson: jsonb("details_json"),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// 8. Inventory & Stock (Unified across units)
export const inventoryItems = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // SKU is unique PER BUSINESS (composite below) — every enterprise unit of a
  // type owns the exact same canonical SKUs as the original (POUL-EGG-L01,
  // BLK-…, AQUA-…), so a cloned unit's production/harvest stock-in can never
  // collide with another unit's rows.
  sku: text("sku").notNull(),
  businessId: integer("business_id").notNull(),
  /** Branch/register this stock belongs to (defaults to the business code). */
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  category: text("category").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull(), // 'Bags', 'Trays', 'Tons', 'Kg', 'Units', 'Vehicles'
  costPriceGhs: doublePrecision("cost_price_ghs").notNull(),
  sellingPriceGhs: doublePrecision("selling_price_ghs").notNull(),
  minStockThreshold: doublePrecision("min_stock_threshold").notNull(),
  status: text("status").default("IN_STOCK"), // 'IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'
  expiryDate: text("expiry_date"), // perishable stock safety tracking (used by Restaurant & Kitchen)
  /** Primary product photo (data URL) + full set — uploaded or camera-captured. */
  photo: text("photo"),
  photos: jsonb("photos"),
  /** QR identity tag — globally unique when set; scanned with the camera or
   *  auto-generated at registration, printed on the stock label. */
  qrCode: text("qr_code"),
  /** Registration audit: who registered this stock item and when. */
  registeredByName: text("registered_by_name"),
  registeredByUserId: integer("registered_by_user_id"),
  registeredAt: timestamp("registered_at").defaultNow(),
}, (t) => [
  uniqueIndex("inventory_items_business_sku_unique").on(t.businessId, t.sku),
  // Globally unique QR across the whole group — NULLs (legacy rows) may repeat.
  uniqueIndex("inventory_items_qr_code_unique").on(t.qrCode),
]);

// 8b. Inventory Downloads audit trail
export const inventoryDownloads = pgTable("inventory_downloads", {
  id: serial("id").primaryKey(),
  downloadId: text("download_id").notNull().unique(),
  downloaderUserId: integer("downloader_user_id").notNull(),
  downloaderName: text("downloader_name").notNull(),
  downloaderRole: text("downloader_role").notNull(),
  downloaderBusinessId: integer("downloader_business_id"),
  downloaderBranchCode: text("downloader_branch_code"),
  downloaderBranchName: text("downloader_branch_name"),
  format: text("format").notNull(),
  recordCount: integer("record_count").notNull(),
  qrCodeData: text("qr_code_data"),
  qrCodePayload: jsonb("qr_code_payload"),
  status: text("status").notNull().default("COMPLETED"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 8c. Universal dashboard/report exports and approval audit history
export const universalExports = pgTable("universal_exports", {
  id: serial("id").primaryKey(),
  exportId: text("export_id").notNull().unique(),
  moduleKey: text("module_key").notNull(),
  moduleLabel: text("module_label").notNull(),
  exportType: text("export_type").notNull(), // DASHBOARD or REPORT
  format: text("format").notNull(), // PDF, EXCEL, CSV
  status: text("status").notNull().default("COMPLETED"), // PENDING, APPROVED, REJECTED, COMPLETED
  requesterUserId: integer("requester_user_id").notNull(),
  requesterName: text("requester_name").notNull(),
  requesterRole: text("requester_role").notNull(),
  businessId: integer("business_id"),
  businessName: text("business_name"),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  filtersJson: jsonb("filters_json"),
  recordCount: integer("record_count").default(0),
  qrCodeData: text("qr_code_data"),
  qrCodePayload: jsonb("qr_code_payload"),
  approvedByUserId: integer("approved_by_user_id"),
  approvedByName: text("approved_by_name"),
  requestedAt: timestamp("requested_at").defaultNow(),
  approvedAt: timestamp("approved_at"),
  completedAt: timestamp("completed_at"),
});

// 9. Financial Transactions (Sales, Purchases, Expenses, Payroll, MoMo)
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  transactionNumber: text("transaction_number").notNull().unique(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  type: text("type").notNull(), // 'INCOME', 'EXPENSE', 'INVESTMENT', 'TRANSFER'
  category: text("category").notNull(), // e.g. 'Egg Wholesale', 'Cement Purchase', 'MoMo Sales', 'Payroll', 'Feed Expense'
  amountGhs: doublePrecision("amount_ghs").notNull(),
  paymentMethod: text("payment_method").notNull(), // 'MTN_MOMO', 'TELECEL_CASH', 'BANK_TRANSFER', 'CASH', 'POS_CARD'
  customerId: integer("customer_id"),
  supplierId: integer("supplier_id"),
  description: text("description").notNull(),
  date: text("date").notNull(),
  createdAt: timestamp("created_at").defaultNow(), // automatic date + time stamp
  status: text("status").default("COMPLETED"), // 'COMPLETED', 'PENDING_MOMO_VERIFICATION', 'OFFLINE_QUEUED'
  recordedBy: text("recorded_by").notNull(),
  recordedByRole: text("recorded_by_role"), // OWNER, GENERAL_MANAGER, BRANCH_MANAGER, WORKER
  recordedByUserId: integer("recorded_by_user_id"),
  receiptImage: text("receipt_image"), // base64 image or URL of receipt photo
  receiptImages: jsonb("receipt_images"), // array of receipt photo URLs/base64
});

// Custom expense categories
export const expenseCategories = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  name: text("name").notNull().unique(), // e.g. "Generator Diesel", "Egg Tray Restock"
  icon: text("icon"), // emoji or icon name
  isActive: boolean("is_active").default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 9b. Sales Documents (Invoices, Quotations, Receipts)
export const salesDocuments = pgTable("sales_documents", {
  id: serial("id").primaryKey(),
  documentNumber: text("document_number").notNull().unique(), // e.g. INV-2026-4521, QT-2026-0089, RCP-2026-1102
  documentType: text("document_type").notNull(), // 'INVOICE', 'QUOTATION', 'RECEIPT'
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  customerEmail: text("customer_email"),
  customerAddress: text("customer_address"),
  lineItems: jsonb("line_items").notNull(), // [{description, quantity, unitPrice, total}]
  subtotalGhs: doublePrecision("subtotal_ghs").notNull(),
  taxRateGhs: doublePrecision("tax_rate_ghs").default(0),
  taxAmountGhs: doublePrecision("tax_amount_ghs").default(0),
  discountGhs: doublePrecision("discount_ghs").default(0),
  // Percentage discount entered at the till / document builder — the system
  // derives discountGhs = subtotal × discountPercent/100 (both are stored so
  // receipts, invoices, quotations and reports show e.g. "Discount 5% −GH₵x").
  // 0 (and legacy rows) mean "no percentage recorded".
  discountPercent: doublePrecision("discount_percent").default(0),
  totalGhs: doublePrecision("total_ghs").notNull(),
  cogsGhs: doublePrecision("cogs_ghs").default(0), // cost of goods sold (inventory cost × qty) for profit reporting
  grossProfitGhs: doublePrecision("gross_profit_ghs").default(0), // totalGhs − cogsGhs
  currency: text("currency").notNull().default("GHS"),
  status: text("status").notNull().default("DRAFT"), // 'DRAFT', 'SENT', 'PAID', 'PARTIAL', 'CANCELLED', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'EXPIRED'
  notes: text("notes"),
  terms: text("terms"),
  validUntil: text("valid_until"), // For quotations
  dueDate: text("due_date"), // For invoices
  paymentMethod: text("payment_method"), // Filled when paid
  linkedTransactionId: integer("linked_transaction_id"), // Link to transaction when invoice is paid
  linkedQuotationId: integer("linked_quotation_id"), // If invoice was converted from quotation
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name").notNull(),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 9c. Customer Order Tracking — every customer order/product gets a unique,
// unguessable tracking code. Customers track WITHOUT logging in on the
// public /track page; staff manage statuses & live dispatch location here.
export const customerTrackings = pgTable("customer_trackings", {
  id: serial("id").primaryKey(),
  trackingCode: text("tracking_code").notNull().unique(), // e.g. GM-POULTRY-4K7XQ2
  // Chain: Business → Branch → Customer → Order (sale doc/transaction) → Product items
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"), // staff-only, never exposed publicly
  saleDocumentId: integer("sale_document_id"), // linked sales_documents.id (order)
  transactionId: integer("transaction_id"), // linked transactions.id
  items: jsonb("items").notNull().default([]), // [{description, sku?, quantity, unit?, unitPrice, total}]
  // Percentage discount applied when the order was created (staff register /
  // till). Online storefront orders pay full price unless staff adjust them.
  discountPercent: doublePrecision("discount_percent").default(0),
  discountGhs: doublePrecision("discount_ghs").default(0),
  totalGhs: doublePrecision("total_ghs").default(0),
  currency: text("currency").notNull().default("GHS"),
  fulfillmentType: text("fulfillment_type").notNull().default("PICKUP"), // 'PICKUP' | 'DELIVERY'
  destinationAddress: text("destination_address"), // delivery destination (customer's own)
  // Google-Maps delivery pin — selected by the customer on the storefront at
  // checkout (GPS capture + adjustable map pin) or attached by staff from a
  // shared Google Maps link. Nullable: orders without a pin still work, staff
  // confirm the address by phone. Privacy: surfaced ONLY to business-scoped
  // staff / couriers and to the customer themself via their own tracking
  // code — never listed anywhere else. Pickup orders point the customer at
  // the branch pin instead (businesses.gps_lat / gps_lng).
  deliveryLat: doublePrecision("delivery_lat"),
  deliveryLng: doublePrecision("delivery_lng"),
  deliveryAccuracyM: doublePrecision("delivery_accuracy_m"), // GPS accuracy when captured (metres)
  deliveryMapLink: text("delivery_map_link"), // canonical https://maps.google.com/?q=lat,lng
  deliveryPinnedAt: timestamp("delivery_pinned_at"),
  // Chosen PICKUP point — snapshot of the pickup_locations row at order time
  // (kept verbatim so the order stays correct even if the location is later
  // edited/removed). Null = collect at the branch itself (legacy default).
  pickupLocationId: integer("pickup_location_id"),
  pickupLocationName: text("pickup_location_name"),
  pickupLocationAddress: text("pickup_location_address"),
  pickupLat: doublePrecision("pickup_lat"),
  pickupLng: doublePrecision("pickup_lng"),
  // Flow: RECEIVED → CONFIRMED → PROCESSING → READY | DISPATCHED → COMPLETED | DELIVERED (+ CANCELLED)
  status: text("status").notNull().default("RECEIVED"),
  statusHistory: jsonb("status_history").notNull().default([]), // [{status, at, by, byRole, note}]
  // Live dispatch location (only surfaced publicly while DISPATCHED)
  driverName: text("driver_name"),
  vehicleNote: text("vehicle_note"),
  driverLat: doublePrecision("driver_lat"),
  driverLng: doublePrecision("driver_lng"),
  driverLocationAt: timestamp("driver_location_at"),
  // Online ordering & payment linkage (Business → Branch → Customer →
  // Product → Payment → Delivery):
  orderSource: text("order_source").notNull().default("MANUAL"), // 'SALE' (till), 'MANUAL' (staff), 'ONLINE' (customer storefront)
  paymentChoice: text("payment_choice"), // 'ON_DELIVERY' | 'MOMO_NOW' (online checkout choice)
  paymentStatus: text("payment_status").notNull().default("UNPAID"), // 'PAID' | 'UNPAID' | 'PENDING_CONFIRMATION'
  paymentMethod: text("payment_method"), // 'CASH' | 'MTN_MOMO' — set by the sale, or when staff confirm payment
  paymentRef: text("payment_ref"), // MoMo reference (customer-entered or staff-entered) — staff-only
  paymentMarkedBy: text("payment_marked_by"),
  paymentMarkedAt: timestamp("payment_marked_at"),
  customerNote: text("customer_note"), // checkout note typed by the customer
  stockCommitted: boolean("stock_committed").notNull().default(false), // online order stock deducted at CONFIRM
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 9d. Credit Sales — buy-now-pay-in-installments anchored to a secure
// order/customer code. A credit sale is created at the register (stock is
// deducted + ownership documented up front) and the customer settles it in
// installments (credit_payments) until balanceGhs reaches zero. Every
// installment posts an INCOME transaction and mints a RECEIPT, so Finance,
// Reports and Receipts reflect the money exactly when it arrives; the
// outstanding receivable lives here until fully paid.
export const creditSales = pgTable("credit_sales", {
  id: serial("id").primaryKey(),
  // Staff-facing secure reference CRD-<BIZWORD>-XXXXXX; the customer uses
  // their GM-* tracking code (trackingCode below) to follow/pay.
  creditCode: text("credit_code").notNull().unique(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  trackingId: integer("tracking_id"), // linked customer_trackings.id
  trackingCode: text("tracking_code"), // snapshot of the customer's GM-* code
  saleDocumentId: integer("sale_document_id"), // linked INVOICE (status CREDIT → PAID)
  items: jsonb("items").notNull().default([]), // [{description, sku?, quantity, unit?, unitPrice, total}]
  subtotalGhs: doublePrecision("subtotal_ghs").notNull().default(0),
  discountPercent: doublePrecision("discount_percent").default(0),
  discountGhs: doublePrecision("discount_ghs").default(0),
  totalGhs: doublePrecision("total_ghs").notNull(), // agreed credit total
  amountPaidGhs: doublePrecision("amount_paid_ghs").notNull().default(0), // installments received
  balanceGhs: doublePrecision("balance_ghs").notNull(), // outstanding balance
  status: text("status").notNull().default("ACTIVE"), // 'ACTIVE' (paying) | 'PAID' (fully settled)
  dueDate: text("due_date"), // optional agreed settlement date (YYYY-MM-DD)
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 9e. Credit Sale Installment Payments — the dated payment history behind
// every credit sale (deposit + installments), each linked to its INCOME
// transaction and RECEIPT document.
export const creditPayments = pgTable("credit_payments", {
  id: serial("id").primaryKey(),
  paymentNumber: text("payment_number").notNull().unique(), // CRP-2026-123456
  creditSaleId: integer("credit_sale_id").notNull(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  amountGhs: doublePrecision("amount_ghs").notNull(),
  paymentMethod: text("payment_method").notNull(), // 'CASH','MTN_MOMO','TELECEL_CASH','BANK_TRANSFER','POS_CARD'
  reference: text("reference"), // MoMo/bank reference (staff-entered, staff-only)
  note: text("note"),
  transactionId: integer("transaction_id"), // linked INCOME transactions.id
  receiptDocumentId: integer("receipt_document_id"), // linked RECEIPT sales_documents.id
  receivedByUserId: integer("received_by_user_id"),
  receivedByName: text("received_by_name"),
  receivedByRole: text("received_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// --- SPECIALIZED MODULE LOGS FOR EACH OF THE 7 BUSINESSES ---

// 10. Poultry Farm Log (Egg trays, feed kg, mortality, health)
export const poultryLogs = pgTable("poultry_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  batchNumber: text("batch_number").notNull(), // e.g. BATCH-2026-A
  birdType: text("bird_type").notNull(), // 'LAYERS', 'BROILERS'
  totalBirds: integer("total_birds").notNull(),
  dailyEggsTrays: integer("daily_eggs_trays").notNull(),
  feedConsumedKg: doublePrecision("feed_consumed_kg").notNull(),
  mortalityCount: integer("mortality_count").default(0),
  healthStatus: text("health_status").default("HEALTHY"), // 'HEALTHY', 'VET_CHECK_REQUIRED', 'VACCINATED'
  recordedDate: text("recorded_date").notNull(),
});

// ─── POULTRY FARM MANAGEMENT MODULE ───────────────────────────────────

// P1. Flock & Batch Management
export const poultryFlocks = pgTable("poultry_flocks", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  branchName: text("branch_name"),
  batchNumber: text("batch_number").notNull().unique(),
  flockName: text("flock_name"), // e.g. "Nsawam Isa Brown Flock 01"
  birdType: text("bird_type").notNull(), // LAYERS, BROILERS, COCKERELS, TURKEYS, GUINEA_FOWL
  breed: text("breed"), // e.g. "Isa Brown", "Cobb 500", "Lohmann"
  genetics: text("genetics"), // genetic line/strain, e.g. "SASSO T451", "Hy-Line W-36", "Ross 308 Pureline"
  supplier: text("supplier"), // chick/flock supplier, e.g. "Akate Farms Hatchery Ltd"
  houseName: text("house_name"), // Pen / House identifier
  initialCount: integer("initial_count").notNull(),
  currentCount: integer("current_count").notNull(),
  mortalityTotal: integer("mortality_total").default(0),
  arrivalDate: text("arrival_date").notNull(),
  ageWeeks: doublePrecision("age_weeks").default(0),
  sourceHatchery: text("source_hatchery"),
  costPerBirdGhs: doublePrecision("cost_per_bird_ghs").default(0),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE, SOLD, CULLED, CLOSED
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P2. Feed Management
export const poultryFeedLogs = pgTable("poultry_feed_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  flockId: integer("flock_id"),
  batchNumber: text("batch_number"),
  feedType: text("feed_type").notNull(), // STARTER, GROWER, FINISHER, LAYER_MASH, CONCENTRATE
  brandSupplier: text("brand_supplier"),
  quantityKg: doublePrecision("quantity_kg").notNull(),
  costPerKgGhs: doublePrecision("cost_per_kg_ghs").default(0),
  totalCostGhs: doublePrecision("total_cost_ghs").default(0),
  entryType: text("entry_type").notNull().default("CONSUMPTION"), // PURCHASE or CONSUMPTION
  recordedDate: text("recorded_date").notNull(),
  recordedByName: text("recorded_by_name"),
  recordedByRole: text("recorded_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P3. Water Management
export const poultryWaterLogs = pgTable("poultry_water_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  flockId: integer("flock_id"),
  batchNumber: text("batch_number"),
  volumeLiters: doublePrecision("volume_liters").notNull(),
  sourceType: text("source_type"), // BOREHOLE, PIPED, TANKER, RAINWATER
  phLevel: doublePrecision("ph_level"),
  isTreated: boolean("is_treated").default(false),
  treatmentUsed: text("treatment_used"), // e.g. chlorine, vitamins
  recordedDate: text("recorded_date").notNull(),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P4. Health & Vaccination
export const poultryHealthRecords = pgTable("poultry_health_records", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  flockId: integer("flock_id"),
  batchNumber: text("batch_number"),
  recordType: text("record_type").notNull(), // VACCINATION, TREATMENT, INSPECTION, MORTALITY, BIOSECURITY
  vaccineOrDrug: text("vaccine_or_drug"),
  diseaseOrCondition: text("disease_or_condition"),
  dosage: text("dosage"),
  administeredBy: text("administered_by"), // vet or staff name
  birdsAffected: integer("birds_affected").default(0),
  mortalityCount: integer("mortality_count").default(0),
  costGhs: doublePrecision("cost_ghs").default(0),
  nextDueDate: text("next_due_date"),
  outcome: text("outcome"), // RESOLVED, ONGOING, MONITORING
  notes: text("notes"),
  recordedDate: text("recorded_date").notNull(),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P5. Egg / Broiler Production
export const poultryProduction = pgTable("poultry_production", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  flockId: integer("flock_id"),
  batchNumber: text("batch_number"),
  productionType: text("production_type").notNull(), // EGGS, BROILER_WEIGHT, or a custom master-product key
  // Egg fields
  eggsCollected: integer("eggs_collected").default(0),
  traysProduced: doublePrecision("trays_produced").default(0),
  crackedEggs: integer("cracked_eggs").default(0),
  gradeA: integer("grade_a").default(0),
  gradeB: integer("grade_b").default(0),
  // Broiler fields
  birdsHarvested: integer("birds_harvested").default(0),
  totalWeightKg: doublePrecision("total_weight_kg").default(0),
  avgWeightKg: doublePrecision("avg_weight_kg").default(0),
  // Custom master-product fields (productionType = poultry_products.product_key)
  quantityProduced: doublePrecision("quantity_produced").default(0), // in the product's own unit
  productName: text("product_name"), // snapshot for reports/exports
  unit: text("unit"), // snapshot of the product unit (Trays, Birds, Kg, …)
  // Shared
  layPercentage: doublePrecision("lay_percentage").default(0),
  fcr: doublePrecision("fcr").default(0), // feed conversion ratio
  revenueGhs: doublePrecision("revenue_ghs").default(0), // auto-linked sales revenue
  recordedDate: text("recorded_date").notNull(),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P5b. Poultry Master Product List — the farm's production types & sellable
// products. Seeded with EGGS + BROILER (system); any product the user adds
// while logging production is stored here and automatically linked into
// Inventory (by SKU), Stock, Sales pickers and Reports.
export const poultryProducts = pgTable("poultry_products", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  productKey: text("product_key").notNull(), // EGGS | BROILER_WEIGHT | custom UPPER_SNAKE
  name: text("name").notNull(), // display name, e.g. "Duck Egg Crates"
  category: text("category").notNull().default("Poultry Products"),
  unit: text("unit").notNull().default("Units"), // Trays, Birds, Kg, Pieces, Crates…
  sku: text("sku").notNull(), // inventory link — production stocks this SKU in
  costPriceGhs: doublePrecision("cost_price_ghs").default(0),
  sellingPriceGhs: doublePrecision("selling_price_ghs").default(0),
  minStockThreshold: doublePrecision("min_stock_threshold").default(50),
  isSystem: boolean("is_system").default(false), // EGGS / BROILER_WEIGHT seeds
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("poultry_products_business_key_unique").on(t.businessId, t.productKey),
]);

// P5c. Daily Weight Log — one row per weighing event. BIRD: average live
// body weight of a sample of birds from a flock (broilers AND layers);
// EGG: average egg weight of a sample for a layer flock. Weights are stored
// in GRAMS. Flock/batch/branch are auto-filled from the selected flock, and
// the growth analytics join these rows to feed, mortality and production by
// (batch, date) to derive growth rate, average weight by age, estimated
// biomass and calculated FCR.
export const poultryWeightLogs = pgTable("poultry_weight_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  flockId: integer("flock_id").notNull(),
  batchNumber: text("batch_number").notNull(),
  weightKind: text("weight_kind").notNull(), // BIRD | EGG
  sampleSize: integer("sample_size").notNull().default(1), // birds / eggs weighed
  avgWeightG: doublePrecision("avg_weight_g").notNull(), // grams per bird / per egg
  recordedDate: text("recorded_date").notNull(), // YYYY-MM-DD
  notes: text("notes"),
  recordedByName: text("recorded_by_name"),
  recordedByRole: text("recorded_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// P6. Daily Activity Checklist
export const poultryChecklists = pgTable("poultry_checklists", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  checklistDate: text("checklist_date").notNull(),
  taskKey: text("task_key").notNull(), // e.g. FEED_MORNING, WATER_CHECK
  taskLabel: text("task_label").notNull(),
  category: text("category"), // FEEDING, WATER, HEALTH, CLEANING, SECURITY, PRODUCTION
  isCompleted: boolean("is_completed").default(false),
  completedByName: text("completed_by_name"),
  completedByRole: text("completed_by_role"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 11. Block Factory Log (Blocks molded, bags cement used, breakage rate)
export const blockFactoryLogs = pgTable("block_factory_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  batchId: text("batch_id").notNull(),
  blockType: text("block_type").notNull(), // '6-INCH-SOLID', '6-INCH-HOLLOW', 'PAVING-BRICKS', '5-INCH-SOLID'
  bagsCementUsed: integer("bags_cement_used").notNull(),
  blocksMolded: integer("blocks_molded").notNull(),
  blocksBroken: integer("blocks_broken").default(0),
  qualityGrade: text("quality_grade").default("GRADE_A_STANDARD"),
  recordedDate: text("recorded_date").notNull(),
});

// 11b. Block Factory Orders
export const blockFactoryOrders = pgTable("block_factory_orders", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  orderNumber: text("order_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  blockType: text("block_type").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceGhs: doublePrecision("unit_price_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING, IN_PROGRESS, COMPLETED, CANCELLED
  dueDate: text("due_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 11c. Block Factory Deliveries
export const blockFactoryDeliveries = pgTable("block_factory_deliveries", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  deliveryNumber: text("delivery_number").notNull().unique(),
  orderNumber: text("order_number"),
  customerName: text("customer_name").notNull(),
  blockType: text("block_type"),
  quantity: integer("quantity").notNull(),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  status: text("status").notNull().default("SCHEDULED"), // SCHEDULED, IN_TRANSIT, DELIVERED, CANCELLED
  deliveryDate: text("delivery_date").notNull(),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 11d. Block Factory Daily Activity Checklist
export const blockFactoryChecklists = pgTable("block_factory_checklists", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  checklistDate: text("checklist_date").notNull(),
  taskKey: text("task_key").notNull(), // e.g. MACHINE_STARTUP, MATERIAL_COUNT
  taskLabel: text("task_label").notNull(),
  category: text("category"), // PRODUCTION, MATERIALS, MACHINERY, QUALITY, CLEANING, SECURITY, DELIVERIES
  isCompleted: boolean("is_completed").default(false),
  completedByName: text("completed_by_name"),
  completedByRole: text("completed_by_role"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 11e. Block Types Master List (production master data — user-extensible)
export const blockTypes = pgTable("block_types", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  typeKey: text("type_key").notNull(), // canonical key stored on production/orders/deliveries, e.g. "6-INCH-SOLID"
  name: text("name").notNull(), // display label, e.g. "6-Inch Solid Blocks"
  dimensions: text("dimensions"), // e.g. "6in x 9in x 18in"
  style: text("style").default("OTHER"), // SOLID, HOLLOW, PAVING, INTERLOCKING, OTHER
  defaultUnitPriceGhs: doublePrecision("default_unit_price_ghs"),
  sku: text("sku"), // linked finished-goods inventory SKU (auto-created for new types)
  isActive: boolean("is_active").default(true),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 11f. Block Factory Quality Control — one row per QC check at any pipeline
// stage (RAW_MATERIAL → MIXING → PRODUCTION → CURING → FINISHED_BLOCK). A
// check captures the sample, measured result vs the required standard, a
// Pass/Fail verdict, notes, date+time, tester and optional photo evidence.
// Finer metrics (weight, dimensions, density, cracks, surface quality,
// defects, curing day, compressive strength) live in typed columns so the QC
// dashboard can chart strength/weight trends, defect and rejection rates, and
// link every batch Raw Materials → Production → Curing → QC → Stock → Sales.
export const blockQcChecks = pgTable("block_qc_checks", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  stage: text("stage").notNull(), // RAW_MATERIAL | MIXING | PRODUCTION | CURING | FINISHED_BLOCK
  batchId: text("batch_id"), // links block_factory_logs.batch_id (null for raw-material checks)
  batchNumber: text("batch_number"), // display copy kept for purge/forensics stability
  blockType: text("block_type"), // e.g. 6-INCH-SOLID
  sampleRef: text("sample_ref"), // e.g. "Sample 3 — 5 blocks from the east stack"
  testName: text("test_name").notNull(), // e.g. "Compressive strength", "Sand silt content"
  requiredStandard: text("required_standard"), // e.g. "≥ 3.5 MPa (GS 1193)"
  testResult: text("test_result"), // human-readable result, e.g. "4.2 MPa — uniform crush"
  resultValue: doublePrecision("result_value"), // numeric parse for trend charts
  resultUnit: text("result_unit"), // MPa | kg | mm | kg/m3 | % | count
  passFail: text("pass_fail").notNull().default("PASS"), // PASS | FAIL
  // typed measurements (optional, stage-appropriate)
  weightKg: doublePrecision("weight_kg"),
  lengthMm: doublePrecision("length_mm"),
  widthMm: doublePrecision("width_mm"),
  heightMm: doublePrecision("height_mm"),
  densityKgm3: doublePrecision("density_kgm3"),
  compressiveStrengthMpa: doublePrecision("compressive_strength_mpa"),
  cracksCount: integer("cracks_count"),
  surfaceQuality: text("surface_quality"), // GOOD | FAIR | POOR
  defectsCount: integer("defects_count"),
  curingDays: integer("curing_days"),
  rejectedBlocks: integer("rejected_blocks").default(0),
  notes: text("notes"),
  photo: text("photo"), // photo evidence (compressed data URL), like the logo system
  testedAt: timestamp("tested_at").notNull().defaultNow(), // date & time of the check
  testerName: text("tester_name"),
  testerRole: text("tester_role"),
  recordedByName: text("recorded_by_name"),
  recordedByRole: text("recorded_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 12. Aquaculture Log (Tilapia/Catfish, water quality pH & dissolved O2, FCR)
export const aquacultureLogs = pgTable("aquaculture_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  pondId: text("pond_id").notNull(), // e.g. "POND-VOLTA-01", "CAGE-04"
  species: text("species").notNull(), // 'VOLTA_TILAPIA', 'AFRICAN_CATFISH'
  stockCount: integer("stock_count").notNull(),
  averageWeightGrams: doublePrecision("average_weight_grams").notNull(),
  phLevel: doublePrecision("ph_level").notNull(), // e.g. 7.2
  dissolvedOxygen: doublePrecision("dissolved_oxygen").notNull(), // mg/L e.g. 6.5
  fcr: doublePrecision("fcr").notNull(), // Feed conversion ratio e.g. 1.35
  recordedDate: text("recorded_date").notNull(),
});

// ─── AQUACULTURE (CONCEPTUAL FARM) MANAGEMENT ─────────────────────────

// A1. Ponds / Cages / Tanks
export const aquaculturePonds = pgTable("aquaculture_ponds", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  pondId: text("pond_id").notNull().unique(),
  name: text("name").notNull(), // e.g. "Cage 4 – Volta River"
  type: text("type").notNull(), // "POND","CAGE","TANK","BIOFLOC","EARTH_POND"
  capacityLiters: doublePrecision("capacity_liters").notNull(),
  currentBiomassKg: doublePrecision("current_biomass_kg").default(0),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE, STOCKED, EMPTY, MAINTENANCE, PREPARE_NEXT_CYCLE
  phTargetMin: doublePrecision("ph_target_min").default(6.5),
  phTargetMax: doublePrecision("ph_target_max").default(8.5),
  doTargetMinMgL: doublePrecision("do_target_min_mg_l").default(5.0),
  doTargetMaxMgL: doublePrecision("do_target_max_mg_l").default(8.0),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A2. Stock / Batch Management
export const aquacultureBatches = pgTable("aquaculture_batches", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  batchNumber: text("batch_number").notNull().unique(),
  pondId: integer("pond_id"),
  species: text("species").notNull(), // VOLTA_TILAPIA, AFRICAN_CATFISH, RED_TILAPIA
  strainGenetics: text("strain_genetics"),
  hatchDate: text("hatch_date").notNull(),
  initialCount: integer("initial_count").notNull(),
  currentCount: integer("current_count").notNull(),
  mortalityTotal: integer("mortality_total").default(0),
  avgWeightGrams: doublePrecision("avg_weight_grams").default(0),
  targetHarvestDate: text("target_harvest_date"),
  status: text("status").notNull().default("GROWING"), // GROWING, HARVESTED, SOLD, CULLED
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A3. Feed Management
export const aquacultureFeedLogs = pgTable("aquaculture_feed_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  batchId: integer("batch_id"),
  pondId: integer("pond_id"),
  feedType: text("feed_type").notNull(), // FLOATING, SINKING, STARTER, GROWER, FINISHER
  brandSupplier: text("brand_supplier"),
  quantityKg: doublePrecision("quantity_kg").notNull(),
  costPerKgGhs: doublePrecision("cost_per_kg_ghs").default(0),
  totalCostGhs: doublePrecision("total_cost_ghs").default(0),
  entryType: text("entry_type").notNull().default("CONSUMPTION"), // PURCHASE, CONSUMPTION
  recordedDate: text("recorded_date").notNull(),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A4. Water Quality Logs
export const aquacultureWaterQualityLogs = pgTable("aquaculture_water_quality_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  pondId: integer("pond_id"),
  sampleDate: text("sample_date").notNull(),
  waterLiters: doublePrecision("water_liters").default(0),
  phLevel: doublePrecision("ph_level").notNull(),
  dissolvedOxygenMgL: doublePrecision("dissolved_oxygen_mg_l").notNull(),
  temperatureC: doublePrecision("temperature_c"),
  ammoniaMgL: doublePrecision("ammonia_mg_l").default(0),
  turbidity: text("turbidity"), // CLEAR, MODERATE, HIGH
  nitrateMgL: doublePrecision("nitrate_mg_l").default(0),
  treatmentUsed: text("treatment_used"),
  publishedByName: text("published_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A5. Harvest Management
export const aquacultureHarvests = pgTable("aquaculture_harvests", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  batchId: integer("batch_id"),
  pondId: integer("pond_id").notNull(),
  species: text("species").notNull(),
  harvestedCount: integer("harvested_count").notNull(),
  totalWeightKg: doublePrecision("total_weight_kg").notNull(),
  avgWeightKg: doublePrecision("avg_weight_kg").default(0),
  revenueGhs: doublePrecision("revenue_ghs").default(0),
  saleDate: text("sale_date").notNull(),
  buyerName: text("buyer_name"),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A5b. Daily Fish Weight Log — one row per sampling/weighing event: fish
// netted from a pond/tank for a batch and weighed. avgWeightGrams is the mean
// weight of the sampled fish (grams). Batch / pond / species / branch are
// auto-filled from the selected batch; saving also refreshes the batch's
// avgWeightGrams. Growth analytics join these rows with feed consumption,
// harvests and mortality to derive growth rate, average weight by age,
// biomass, FCR and survival.
export const aquacultureWeightLogs = pgTable("aquaculture_weight_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  batchId: integer("batch_id").notNull(),
  batchNumber: text("batch_number").notNull(),
  pondId: integer("pond_id"),
  species: text("species").notNull(),
  sampleSize: integer("sample_size").notNull().default(1), // fish weighed
  avgWeightG: doublePrecision("avg_weight_g").notNull(),
  recordedDate: text("recorded_date").notNull(), // YYYY-MM-DD
  notes: text("notes"),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// A6. Daily Tasks / Checklist for Aquaculture
export const aquacultureChecklists = pgTable("aquaculture_checklists", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  checklistDate: text("checklist_date").notNull(),
  taskKey: text("task_key").notNull(), // e.g. AERATION_CHECK, DO_PH_TEST, FEED_MORNING, MORTALITY_CHECK, FILTER_CLEAN
  taskLabel: text("task_label").notNull(),
  category: text("category"), // WATER, FEEDING, HEALTH, CLEANING, SECURITY, PRODUCTION
  isCompleted: boolean("is_completed").default(false),
  completedByName: text("completed_by_name"),
  completedByRole: text("completed_by_role"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 13. Livestock Log (Cattle, Small Ruminants tags, vaccination, breeding)
export const livestockLogs = pgTable("livestock_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  tagNumber: text("tag_number").notNull(), // e.g. "GH-COW-104"
  animalType: text("animal_type").notNull(), // 'CATTLE', 'GOAT', 'SHEEP'
  breed: text("breed").notNull(), // 'SANGA', 'WEST_AFRICAN_DWARF', 'DJALLONKE'
  weightKg: doublePrecision("weight_kg").notNull(),
  vaccinationStatus: text("vaccination_status").notNull(), // 'UP_TO_DATE', 'DUE_THIS_MONTH', 'PENDING'
  pregnantStatus: boolean("pregnant_status").default(false),
  recordedDate: text("recorded_date").notNull(),
});

// 14. Restaurant & Food Log (Orders, popular dish, waste %, MoMo receipts)
export const restaurantLogs = pgTable("restaurant_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  shiftDate: text("shift_date").notNull(),
  totalOrders: integer("total_orders").notNull(),
  mostPopularDish: text("most_popular_dish").notNull(), // e.g. "Jollof Rice with Tilapia & Pepper Sauce"
  foodCostPercent: doublePrecision("food_cost_percent").notNull(), // e.g. 28.5%
  wastePercent: doublePrecision("waste_percent").notNull(), // e.g. 3.2%
  momoReceiptsGhs: doublePrecision("momo_receipts_ghs").notNull(),
  cashReceiptsGhs: doublePrecision("cash_receipts_ghs").notNull(),
});

// 15. Electronic Shop Log (Serial/IMEI warranty, products, retail stock)
export const electronicsLogs = pgTable("electronics_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  serialNumber: text("serial_number").notNull().unique(), // e.g. "SN-SOLAR-5KW-2026-991"
  productName: text("product_name").notNull(), // e.g. "5kVA Solar Hybrid Inverter"
  brand: text("brand").notNull(), // e.g. "Felicity", "Samsung", "LG"
  warrantyMonths: integer("warranty_months").notNull(), // e.g. 24
  inStock: boolean("in_stock").default(true),
  retailPriceGhs: doublePrecision("retail_price_ghs").notNull(),
  lastCheckedDate: text("last_checked_date").notNull(),
});

// 16. Car Wash Log (Vehicles washed, bay usage, water/chemical usage)
export const carWashLogs = pgTable("car_wash_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  shiftDate: text("shift_date").notNull(),
  vehiclesWashed: integer("vehicles_washed").notNull(),
  chemicalUsedLiters: doublePrecision("chemical_used_liters").notNull(),
  totalRevenueGhs: doublePrecision("total_revenue_ghs").notNull(),
  waterPressurePsi: integer("water_pressure_psi").default(3200),
  recordedDate: text("recorded_date").notNull(),
});

// 16B. Hardware Store — Goods Received / Yard Ops Log. Every logged receipt
// tops up the matching inventory item (or creates it) and optionally books
// the landed cost as an EXPENSE, so the yard log IS the stock intake ledger.
export const hardwareLogs = pgTable("hardware_logs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  receiveNoteNumber: text("receive_note_number").notNull().unique(), // e.g. "GRN-HW-2026-1042"
  supplierName: text("supplier_name").notNull(),
  itemName: text("item_name").notNull(), // e.g. "Ghacem 42.5R Cement 50kg"
  quantityReceived: doublePrecision("quantity_received").notNull(),
  unit: text("unit").notNull().default("Units"), // Bags, Lengths, Sheets, Boxes…
  unitCostGhs: doublePrecision("unit_cost_ghs").default(0),
  condition: text("condition").notNull().default("GOOD"), // GOOD, PARTIAL, DAMAGED
  receivedBy: text("received_by"),
  recordedDate: text("recorded_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// H2. Hardware Store — Customer Orders (contractor / builder material orders
// with a fulfilment pipeline; delivering one deducts stock + books revenue)
export const hardwareOrders = pgTable("hardware_orders", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  orderNumber: text("order_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  itemName: text("item_name").notNull(),
  inventoryId: integer("inventory_id"),
  quantity: doublePrecision("quantity").notNull(),
  unitPriceGhs: doublePrecision("unit_price_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING, READY, DELIVERED, CANCELLED
  dueDate: text("due_date"),
  deliverySite: text("delivery_site"), // e.g. "East Legon Site, Plot 14"
  readyAt: text("ready_at"), // date order status first reached READY (tracking)
  fulfilledDate: text("fulfilled_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// H3. Hardware Store — Supplier Purchases / Restock POs. RECEIVED stock flows
// into Inventory (+quantity / new SKU) and Finance (expense) in one step.
export const hardwarePurchases = pgTable("hardware_purchases", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  purchaseNumber: text("purchase_number").notNull().unique(), // e.g. "PO-HW-2026-231"
  supplierName: text("supplier_name").notNull(),
  itemName: text("item_name").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  unitCostGhs: doublePrecision("unit_cost_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("ORDERED"), // ORDERED, RECEIVED, CANCELLED
  orderDate: text("order_date").notNull(),
  receivedDate: text("received_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// H4. Hardware Store — Site Deliveries / Dispatch. A completed standalone
// delivery deducts the dispatched quantity from stock (order-linked
// deliveries inherit the order's fulfilment instead — never double-counted).
export const hardwareDeliveries = pgTable("hardware_deliveries", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  deliveryNumber: text("delivery_number").notNull().unique(), // e.g. "DLV-HW-2026-087"
  orderNumber: text("order_number"), // optional link to a customer order
  customerName: text("customer_name").notNull(),
  siteAddress: text("site_address"),
  driverName: text("driver_name"),
  vehicleNumber: text("vehicle_number"),
  itemName: text("item_name").notNull(),
  inventoryId: integer("inventory_id"),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull().default("Units"),
  status: text("status").notNull().default("SCHEDULED"), // SCHEDULED, EN_ROUTE, DELIVERED, CANCELLED
  dispatchDate: text("dispatch_date").notNull(),
  enRouteAt: text("en_route_at"), // date delivery first departed (tracking)
  deliveredDate: text("delivered_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── Auto Car Wash module: services, bookings, work-queue, activities ───────

export const carWashServices = pgTable("car_wash_services", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  name: text("name").notNull(), // e.g. "Executive Interior Detail"
  category: text("category").notNull(), // WASH_PACKAGE, DETAILING, WAXING, POLISHING, INTERIOR_CLEANING, EXTERIOR_CLEANING, CUSTOM
  description: text("description"),
  priceGhs: doublePrecision("price_ghs").notNull(),
  durationMinutes: integer("duration_minutes").default(45),
  includesItems: text("includes_items"), // what the offer includes: "Foam shampoo, wax coat, tyre shine…"
  supplyInventoryId: integer("supply_inventory_id"), // consumable stock item (chemical drum) used per job
  supplyUsageLiters: doublePrecision("supply_usage_liters").default(0), // liters drawn from that item per job
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const carWashBookings = pgTable("car_wash_bookings", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  bookingNumber: text("booking_number").notNull().unique(), // e.g. "BK-WASH-2026-48213"
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  vehicleLabel: text("vehicle_label"), // e.g. "Toyota Camry 2021 — GR-5521-23"
  serviceId: integer("service_id"),
  serviceName: text("service_name").notNull(),
  bookingDate: text("booking_date").notNull(), // scheduled day
  timeSlot: text("time_slot"), // e.g. "10:30"
  assignedStaffName: text("assigned_staff_name"),
  status: text("status").notNull().default("BOOKED"), // BOOKED, CHECKED_IN, COMPLETED, CANCELLED
  checkedInAt: text("checked_in_at"), // booking became an active wash
  completedAt: text("completed_at"),
  priceGhs: doublePrecision("price_ghs").notNull().default(0),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const carWashWashes = pgTable("car_wash_washes", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  washNumber: text("wash_number").notNull().unique(), // e.g. "WSH-2026-77120"
  bookingId: integer("booking_id"),
  customerId: integer("customer_id"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  vehicleLabel: text("vehicle_label").notNull(),
  serviceId: integer("service_id"),
  serviceName: text("service_name").notNull(),
  staffId: integer("staff_id"),
  staffName: text("staff_name"),
  status: text("status").notNull().default("IN_PROGRESS"), // IN_PROGRESS, COMPLETED, CANCELLED
  priceGhs: doublePrecision("price_ghs").notNull().default(0),
  startedAt: text("started_at").notNull(),
  doneAt: text("done_at"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const carWashActivities = pgTable("car_wash_activities", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  action: text("action").notNull(), // SERVICE_CREATED, BOOKING_CREATED, CHECK_IN, WASH_COMPLETED, EXPENSE_LOGGED, CANCELLED, ...
  detail: text("detail").notNull(),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  refNumber: text("ref_number"), // booking/wash number involved
  recordedAt: timestamp("recorded_at").defaultNow(),
});

// ── Telecom & Digital Services (MoMo / airtime / data bundles / Wi-Fi) ─────
// Agent lines (MoMo SIMs, airtime wallets, hotspot routers) carry the
// e-money float and physical cash each till holds; every MoMo/airtime/data/
// Wi-Fi sale is a telecom_txns row (with commission, cost & profit) that also
// posts to the shared Finance ledger; Wi-Fi vouchers carry printable codes,
// access PINs and QR payloads with activation-based expiry.
export const telecomLines = pgTable("telecom_lines", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  network: text("network").notNull(), // MTN, TELECEL, AT, WIFI
  kind: text("kind").notNull(), // MOMO_AGENT, AIRTIME_WALLET, DATA_WALLET, WIFI_HOTSPOT
  label: text("label").notNull(), // e.g. "MTN MoMo Agent Till 1"
  msisdn: text("msisdn"), // agent number / SIM number
  floatGhs: doublePrecision("float_ghs").notNull().default(0), // e-money float balance
  cashGhs: doublePrecision("cash_ghs").notNull().default(0), // physical cash at this till
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const telecomTxns = pgTable("telecom_txns", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  txnNumber: text("txn_number").notNull().unique(), // e.g. "TEL-2026-48213"
  lineId: integer("line_id"), // agent line used (MoMo/airtime/data)
  network: text("network"), // MTN / TELECEL / AT / WIFI
  type: text("type").notNull(), // MOMO_DEPOSIT, MOMO_WITHDRAWAL, MOMO_TRANSFER, AIRTIME, DATA, WIFI_VOUCHER
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  amountGhs: doublePrecision("amount_ghs").notNull().default(0), // face value of the transaction
  chargeGhs: doublePrecision("charge_ghs").notNull().default(0), // convenience fee charged to the customer
  commissionGhs: doublePrecision("commission_ghs").notNull().default(0), // MoMo commission earned / airtime-data margin
  costGhs: doublePrecision("cost_ghs").notNull().default(0), // wholesale cost paid from float (airtime/data)
  status: text("status").notNull().default("SUCCESS"), // SUCCESS, FAILED
  failReason: text("fail_reason"),
  reference: text("reference"), // network transaction reference
  paymentMethod: text("payment_method").default("CASH"),
  voucherId: integer("voucher_id"), // Wi-Fi voucher sold in this txn
  txnDate: text("txn_date").notNull(),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const telecomWifiPackages = pgTable("telecom_wifi_packages", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  name: text("name").notNull(), // e.g. "1-Day Unlimited"
  durationHours: integer("duration_hours").notNull(), // validity once activated
  dataCapMb: integer("data_cap_mb"), // null = unlimited
  priceGhs: doublePrecision("price_ghs").notNull(),
  routerLabel: text("router_label"), // hotspot the voucher is valid on, e.g. "Wi-Fi Zone A"
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const telecomVouchers = pgTable("telecom_vouchers", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  packageId: integer("package_id").notNull(),
  packageName: text("package_name").notNull(),
  code: text("code").notNull().unique(), // printed login code, e.g. "WF-8F3K-2Q9X"
  accessCode: text("access_code").notNull(), // 6-digit access PIN
  qrData: text("qr_data"), // QR data-URL encoding code+PIN for scan-to-connect
  status: text("status").notNull().default("AVAILABLE"), // AVAILABLE, SOLD, USED, EXPIRED, REVOKED
  customerName: text("customer_name"), // the Wi-Fi user once sold
  customerPhone: text("customer_phone"),
  priceGhs: doublePrecision("price_ghs").notNull().default(0),
  soldAt: timestamp("sold_at"),
  activatedAt: timestamp("activated_at"),
  expiresAt: timestamp("expires_at"), // activation + package duration
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const telecomActivities = pgTable("telecom_activities", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  action: text("action").notNull(), // LINE_CREATED, FLOAT_TOPUP, TXN_SUCCESS, TXN_FAILED, PACKAGE_CREATED, VOUCHERS_GENERATED, VOUCHER_SOLD, VOUCHER_EXPIRED, ...
  detail: text("detail").notNull(),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  refNumber: text("ref_number"),
  recordedAt: timestamp("recorded_at").defaultNow(),
});

// 17. AI Strategic Insights & Risk Recommendations
export const aiInsights = pgTable("ai_insights", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id"), // null = Enterprise-wide insight
  title: text("title").notNull(),
  category: text("category").notNull(), // 'OPPORTUNITY', 'RISK', 'EFFICIENCY', 'FORECAST', 'COMPLIANCE'
  impactLevel: text("impact_level").notNull(), // 'HIGH', 'MEDIUM', 'CRITICAL'
  recommendation: text("recommendation").notNull(),
  metricAffected: text("metric_affected").notNull(), // e.g. "Net Profit (+GH₵ 42,000)", "Breakage Rate (-4.5%)"
  projectedGainGhs: doublePrecision("projected_gain_ghs").default(0),
  status: text("status").default("NEW"), // 'NEW', 'ACTIONED', 'ARCHIVED'
  createdAt: timestamp("created_at").defaultNow(),
});

// 18. Scenario Planning & What-If Simulations
export const scenarioSimulations = pgTable("scenario_simulations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  targetBusinessId: integer("target_business_id"), // null = All businesses
  variableChanged: text("variable_changed").notNull(), // e.g. "Feed Price", "Cement Price", "Solar Demand", "New Kumasi Branch"
  percentChange: doublePrecision("percent_change").notNull(), // e.g. +15 or -10
  expectedRevenueImpactGhs: doublePrecision("expected_revenue_impact_ghs").notNull(),
  expectedProfitImpactGhs: doublePrecision("expected_profit_impact_ghs").notNull(),
  expectedRoiDelta: doublePrecision("expected_roi_delta").notNull(), // e.g. +3.4% or -1.8%
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// 19. Future-Ready Integrations Hub (MoMo, Banking, POS, IoT, CCTV)
export const integrations = pgTable("integrations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // 'PAYMENTS', 'BANKING', 'ACCOUNTING', 'POS_HARDWARE', 'IOT_SENSORS', 'CCTV_SECURITY'
  provider: text("provider").notNull(), // e.g. "MTN MoMo API", "Ecobank Ghana API", "Xero Sync", "Hikvision CCTV Cloud"
  status: text("status").notNull(), // 'CONNECTED', 'READY_TO_CONNECT', 'OFFLINE_SYNCING'
  lastSync: text("last_sync").notNull(),
  configJson: jsonb("config_json"),
});

// 19b. CCTV Security Cameras — organised Business → Branch → Cameras.
// The OWNER manages every camera; managers manage only cameras in businesses
// they can access AND only after the OWNER grants them canManageCctv.
export const cctvCameras = pgTable("cctv_cameras", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(), // owning business (businesses.id)
  branchCode: text("branch_code").notNull(), // branch/register code, e.g. POULTRY-01
  branchName: text("branch_name"),
  name: text("name").notNull(), // camera name, e.g. "Yard & Feed Storage Camera"
  location: text("location").notNull(), // physical mounting point
  brand: text("brand").notNull(), // HIKVISION | DAHUA | UNIVIEW | AXIS | REOLINK | TP_LINK_VIGI | EZVIZ | ANNKE | OTHER
  cameraType: text("camera_type").notNull(), // IP_CAMERA | PTZ_IP_CAMERA | WIFI_CAMERA | NVR_SYSTEM | DVR_SYSTEM | NVR_CHANNEL | DVR_CHANNEL | ANALOG_CAMERA
  model: text("model"),
  connectionType: text("connection_type").notNull(), // POE_RTSP | ONVIF | WIFI | CLOUD_P2P | COAXIAL_BNC | NVR_CHANNEL | DVR_CHANNEL
  host: text("host"), // IP address / hostname / cloud device ID
  port: integer("port"), // e.g. 554 (RTSP), 80/443 (HTTP), 37777 (Dahua)
  streamUrl: text("stream_url"), // full RTSP/HTTP stream URL when known
  username: text("username"),
  password: text("password"), // device credential — never returned by the GET API
  snapshotUrl: text("snapshot_url"), // preview/demo frame for the live monitor
  status: text("status").notNull().default("ONLINE"), // ONLINE | OFFLINE | MAINTENANCE
  notes: text("notes"),
  lastTestAt: timestamp("last_test_at"),
  lastTestResult: text("last_test_result"),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  updatedByName: text("updated_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 19c. Enterprise Payroll — runs, per-employee entries & attendance.
// Lifecycle: DRAFT → REVIEWED → APPROVED → PAID (payment posts a real EXPENSE
// transaction so payroll flows into Finance & Reports automatically).
// Permissions follow the existing shared-record model: the OWNER always;
// managers only with the OWNER-granted canManageRecords flag and only inside
// their accessible businesses (enforced server-side per request).
export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  period: text("period").notNull(), // "2026-08" — payroll month
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code").notNull(),
  branchName: text("branch_name"),
  status: text("status").notNull().default("DRAFT"), // DRAFT | REVIEWED | APPROVED | PAID
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id"),
  createdByName: text("created_by_name"),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at"),
  approvedByName: text("approved_by_name"),
  approvedAt: timestamp("approved_at"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const payrollEntries = pgTable("payroll_entries", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull(), // payroll_runs.id
  employeeId: integer("employee_id").notNull(),
  employeeName: text("employee_name").notNull(),
  employeeRole: text("employee_role"),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code").notNull(),
  baseSalaryGhs: doublePrecision("base_salary_ghs").notNull(),
  allowancesGhs: doublePrecision("allowances_ghs").notNull().default(0),
  allowanceNote: text("allowance_note"),
  overtimeHours: doublePrecision("overtime_hours").notNull().default(0),
  overtimePayGhs: doublePrecision("overtime_pay_ghs").notNull().default(0),
  deductionsGhs: doublePrecision("deductions_ghs").notNull().default(0),
  deductionNote: text("deduction_note"),
  // ── Statutory engine (Ghana): SSNIT T1 (5.5% EE / 13% ER), Tier-2 pension,
  //    PAYE bands, plus any custom statutory items from payroll_statutory_config.
  //    All computed server-side at run creation / manual adjustment; legacy
  //    (pre-statutory) paid entries keep null columns and stay locked. ──────
  applyStatutory: boolean("apply_statutory").notNull().default(true),
  grossPayGhs: doublePrecision("gross_pay_ghs"), // basic + allowances + OT pay
  ssnitEmployeeGhs: doublePrecision("ssnit_employee_ghs"), // employee deduction
  ssnitEmployerGhs: doublePrecision("ssnit_employer_ghs"), // employer contribution
  tier2Ghs: doublePrecision("tier2_ghs"), // occupational pension (bearer per config)
  tier2Bearer: text("tier2_bearer"), // EMPLOYER | EMPLOYEE (snapshot at calc time)
  taxableIncomeGhs: doublePrecision("taxable_income_ghs"), // gross − employee SSNIT
  payeGhs: doublePrecision("paye_ghs"), // PAYE tax on taxable income
  customDeductions: jsonb("custom_deductions"), // [{name, amount, bearer}] snapshot
  totalEmployeeDeductionsGhs: doublePrecision("total_employee_deductions_ghs"), // SSNIT EE + PAYE + manual + employee-borne items
  employerContributionsGhs: doublePrecision("employer_contributions_ghs"), // SSNIT ER + employer-borne items
  employerCostGhs: doublePrecision("employer_cost_ghs"), // gross + employer contributions
  netPayGhs: doublePrecision("net_pay_ghs").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | PAID
  paymentMethod: text("payment_method"), // CASH | MTN_MOMO | BANK_TRANSFER | OTHER
  paidAt: timestamp("paid_at"),
  paidByName: text("paid_by_name"),
  transactionId: integer("transaction_id"), // ledger link (transactions.id)
  createdAt: timestamp("created_at").defaultNow(),
});

export const payrollAttendance = pgTable("payroll_attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull(),
  employeeName: text("employee_name").notNull(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code").notNull(),
  date: text("date").notNull(), // "2026-08-20"
  status: text("status").notNull(), // PRESENT | HALF_DAY | ABSENT | LEAVE | OFF_DAY
  hoursWorked: doublePrecision("hours_worked").notNull().default(0),
  overtimeHours: doublePrecision("overtime_hours").notNull().default(0),
  leaveType: text("leave_type"), // ANNUAL | SICK | MATERNITY | UNPAID | null
  note: text("note"),
  recordedByUserId: integer("recorded_by_user_id"),
  recordedByName: text("recorded_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 19e. Staff Clock In / Clock Out — the real-time attendance log. One row per
// shift: who (user + linked employee), where (assigned Business & Branch,
// auto-recorded), when (date + in/out timestamps), and the worker's GPS fix
// captured at each event. Distance from the branch anchor (businesses.gps_*)
// flags off-site clock events for manager review. On clock-out the shift's
// hours + overtime are derived and flow into payroll_attendance (never
// clobbering a manager's manual register row), which is exactly what the
// payroll run engine consumes — Attendance → Payroll → Reports stays linked.
export const attendanceLogs = pgTable("attendance_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(), // users.id of the person clocking
  employeeId: integer("employee_id"), // employees.id when the user matches a staff row
  employeeName: text("employee_name").notNull(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code").notNull(),
  branchName: text("branch_name"),
  date: text("date").notNull(), // shift day, YYYY-MM-DD (day of clock-in)
  clockInAt: timestamp("clock_in_at").notNull(),
  clockInLat: doublePrecision("clock_in_lat"),
  clockInLng: doublePrecision("clock_in_lng"),
  clockInAccuracyM: doublePrecision("clock_in_accuracy_m"),
  clockInMethod: text("clock_in_method").notNull().default("GPS"), // GPS | MANUAL (no fix)
  clockInDistanceM: doublePrecision("clock_in_distance_m"), // metres from branch anchor
  clockOutAt: timestamp("clock_out_at"),
  clockOutLat: doublePrecision("clock_out_lat"),
  clockOutLng: doublePrecision("clock_out_lng"),
  clockOutAccuracyM: doublePrecision("clock_out_accuracy_m"),
  clockOutMethod: text("clock_out_method"), // GPS | MANUAL | null while open
  clockOutDistanceM: doublePrecision("clock_out_distance_m"),
  hoursWorked: doublePrecision("hours_worked"), // derived at clock-out (2dp)
  overtimeHours: doublePrecision("overtime_hours"), // derived: max(0, hours − 8)
  offSiteIn: boolean("off_site_in").notNull().default(false),
  offSiteOut: boolean("off_site_out").notNull().default(false),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow(),
});

/** Statutory rates & configuration for payroll — one live row (id=1).
 *  Editable by the OWNER / owner-authorized managers from the Payroll
 *  Center "Statutory Settings" tab so the system keeps pace with Ghana
 *  regulation changes (SSNIT T1 %EE/%ER, Tier-2 %, bearer, PAYE bands and
 *  any custom statutory contributions). New runs and manual entry edits are
 *  computed with these rates; PAID entries are never recomputed. */
export const payrollStatutoryConfig = pgTable("payroll_statutory_config", {
  id: serial("id").primaryKey(),
  ssnitEmployeePct: doublePrecision("ssnit_employee_pct").notNull().default(5.5), // employee deduction (% of basic)
  ssnitEmployerPct: doublePrecision("ssnit_employer_pct").notNull().default(13), // employer contribution (% of basic)
  tier2Pct: doublePrecision("tier2_pct").notNull().default(5), // Tier-2 occupational pension (% of basic)
  tier2Bearer: text("tier2_bearer").notNull().default("EMPLOYER"), // EMPLOYER | EMPLOYEE
  payeBands: jsonb("paye_bands").notNull(), // progressive monthly bands [{upto: number|null, ratePct}]
  customItems: jsonb("custom_items").notNull().default([]), // [{name, pct, bearer: EMPLOYEE|EMPLOYER, base: BASIC|GROSS}]
  note: text("note"),
  updatedByUserId: integer("updated_by_user_id"),
  updatedByName: text("updated_by_name"),
  updatedByRole: text("updated_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 20. Asset Downloads Audit Trail
// Tracks every asset record download with unique ID, QR code, and downloader details
// 19d. Supervisor & Auditor Control Center.
// Reviews attach DIRECTLY to the existing worker records (transactions &
// sales, inventory, employees, payroll runs & attendance, assets, CCTV,
// operations/production logs) — no duplicate checklists are ever created.
// The audit_trail table keeps a complete, immutable log of every action
// taken inside the center (reviews, resolutions, access grants, delegation).
export const AUDIT_MODULES = [
  "OPERATIONS",
  "FINANCE",
  "INVENTORY",
  "EMPLOYEES",
  "PAYROLL",
  "ATTENDANCE",
  "ASSETS",
  "CCTV",
] as const;

/** Issue lifecycle for flagged records / correction requests:
 *  FLAGGED (auditor raised it, routed to the assigned user) →
 *  UNDER_REVIEW (assigned user responded & sent it back for review) →
 *  CORRECTION_REQUIRED (auditor sent it back for fixes) →
 *  RESOLVED (assigned user completed the correction) →
 *  VERIFIED (auditor verified & closed the issue — terminal).
 *  COMMENT reviews carry INFO. "OPEN" from the first release is treated as
 *  FLAGGED everywhere. */
export const ISSUE_STATUSES = [
  "FLAGGED",
  "UNDER_REVIEW",
  "CORRECTION_REQUIRED",
  "RESOLVED",
  "VERIFIED",
] as const;
/** Statuses that still sit on somebody's desk (incl. legacy OPEN). */
export const ISSUE_OPEN_STATUSES = ["FLAGGED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "RESOLVED", "OPEN"] as const;
export const ISSUE_PIPELINE_LABELS: Record<string, string> = {
  FLAGGED: "Flagged",
  UNDER_REVIEW: "Under Review",
  CORRECTION_REQUIRED: "Correction Required",
  RESOLVED: "Resolved",
  VERIFIED: "Verified",
  INFO: "Comment",
  OPEN: "Flagged", // legacy
};

/** Auditor access grants. The OWNER may grant anyone; a manager carrying the
 *  canManageAuditors flag may grant only inside their accessible businesses.
 *  `modules` limits what the auditor is allowed to see and review;auditors
 *  never see anything outside their grants. */
export const auditAssignments = pgTable("audit_assignments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(), // the auditor (an existing GoMina user)
  userName: text("user_name").notNull(),
  userRole: text("user_role").notNull(),
  businessId: integer("business_id").notNull(), // business being audited
  branchCode: text("branch_code"), // null = every branch of the business
  modules: jsonb("modules").notNull(), // AUDIT_MODULES subset
  note: text("note"),
  isActive: boolean("is_active").notNull().default(true),
  grantedByUserId: integer("granted_by_user_id").notNull(),
  grantedByName: text("granted_by_name").notNull(),
  grantedByRole: text("granted_by_role").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** A review action on an existing record — this IS the issue head when the
 *  action is FLAGGED / CORRECTION_REQUESTED. Issues follow the pipeline
 *  FLAGGED → UNDER_REVIEW → CORRECTION_REQUIRED → RESOLVED → VERIFIED and are
 *  routed straight to the assigned user's dashboard; every step is mirrored
 *  in audit_issue_updates and audit_trail, and the row always stays linked to
 *  the original checklist / activity / record via recordType+recordSource+recordId. */
export const auditReviews = pgTable("audit_reviews", {
  id: serial("id").primaryKey(),
  recordType: text("record_type").notNull(), // TRANSACTION | INVENTORY_ITEM | EMPLOYEE | PAYROLL_RUN | PAYROLL_ATTENDANCE | ASSET | CCTV_CAMERA | OPERATION_LOG | CHECKLIST
  recordSource: text("record_source"), // underlying table for OPERATION_LOG / CHECKLIST rows
  recordId: integer("record_id").notNull(),
  recordRef: text("record_ref"), // natural key: TRX number, SKU, asset code, CHK date…
  recordTitle: text("record_title").notNull(), // snapshot so the trail survives edits
  module: text("module").notNull(), // one of AUDIT_MODULES
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  workerName: text("worker_name"), // employee/recorder the record belongs to
  action: text("action").notNull(), // VERIFIED | FLAGGED | COMMENT | CORRECTION_REQUESTED
  status: text("status").notNull().default("INFO"), // FLAGGED | UNDER_REVIEW | CORRECTION_REQUIRED | RESOLVED | VERIFIED | INFO (OPEN = legacy FLAGGED)
  issueTitle: text("issue_title"), // short label shown on dashboards & notifications
  reason: text("reason"), // why flagged / why correction requested / verification basis
  comment: text("comment"),
  evidence: text("evidence"), // evidence note / link
  evidencePhoto: text("evidence_photo"), // attached photo (data URL)
  assignedUserId: integer("assigned_user_id"), // GoMina user the issue is routed to
  assignedUserName: text("assigned_user_name"),
  assignedUserRole: text("assigned_user_role"),
  reviewerUserId: integer("reviewer_user_id").notNull(),
  reviewerName: text("reviewer_name").notNull(),
  reviewerRole: text("reviewer_role").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  // Latest response from the assigned user (full conversation in audit_issue_updates)
  responseNote: text("response_note"),
  responseEvidence: text("response_evidence"),
  responsePhoto: text("response_photo"),
  responseByName: text("response_by_name"),
  responseAt: timestamp("response_at"),
  resolvedByUserId: integer("resolved_by_user_id"),
  resolvedByName: text("resolved_by_name"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNote: text("resolution_note"),
});

/** Immutable per-issue conversation: who did what, when, notes & evidence,
 *  with the status transition each step caused. */
export const auditIssueUpdates = pgTable("audit_issue_updates", {
  id: serial("id").primaryKey(),
  issueId: integer("issue_id").notNull(), // audit_reviews.id
  actorUserId: integer("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(), // FLAG | REQUEST_CORRECTION | RESPOND | MARK_REVIEW | MARK_RESOLVED | VERIFY | COMMENT
  statusFrom: text("status_from"),
  statusTo: text("status_to"),
  note: text("note"),
  evidence: text("evidence"),
  photo: text("photo"),
  createdAt: timestamp("created_at").defaultNow(),
});

/** Dashboard notifications — flagged issues & required corrections land on the
 *  assigned user's bell instantly; responses land on the reviewer's bell. */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(), // recipient
  type: text("type").notNull(), // AUDIT_ISSUE_ASSIGNED | AUDIT_CORRECTION_REQUIRED | AUDIT_ISSUE_RESPONSE | AUDIT_ISSUE_RESOLVED | AUDIT_ISSUE_VERIFIED
  title: text("title").notNull(),
  body: text("body"),
  issueId: integer("issue_id"), // audit_reviews.id
  recordType: text("record_type"),
  recordId: integer("record_id"),
  recordRef: text("record_ref"),
  businessId: integer("business_id"),
  branchCode: text("branch_code"),
  actorName: text("actor_name"), // who triggered it
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Web Push (phone/laptop notifications) ─────────────────────────────
/** VAPID keypair (single live row, id=1) — auto-generated once, reused so
 *  existing browser subscriptions never break. */
export const pushConfig = pgTable("push_config", {
  id: serial("id").primaryKey(),
  vapidPublic: text("vapid_public").notNull(),
  vapidPrivate: text("vapid_private").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/** One row per browser/device a user subscribed for push notifications. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
});

/** Per-user notification preferences — master switch + per-category toggles
 *  (orders, approvals, alerts, tasks, messages, reports). Defaults: all on. */
export const userPushSettings = pgTable("user_push_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  orders: boolean("orders").notNull().default(true),
  approvals: boolean("approvals").notNull().default(true),
  alerts: boolean("alerts").notNull().default(true),
  tasks: boolean("tasks").notNull().default(true),
  messages: boolean("messages").notNull().default(true),
  reports: boolean("reports").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/** Immutable log of everything that happens inside the Audit Center. */
export const auditTrail = pgTable("audit_trail", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id").notNull(),
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(), // VERIFY | FLAG | COMMENT | REQUEST_CORRECTION | RESOLVE | GRANT_ACCESS | UPDATE_GRANT | REVOKE_ACCESS | DELEGATE | REVOKE_DELEGATION
  targetType: text("target_type").notNull(), // RECORD | USER | GRANT
  targetLabel: text("target_label").notNull(), // e.g. "TRX-2026-1001" or "Comfort Agbenyega"
  recordType: text("record_type"),
  recordId: integer("record_id"),
  businessId: integer("business_id"),
  branchCode: text("branch_code"),
  reason: text("reason"),
  detail: text("detail"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const assetDownloads = pgTable("asset_downloads", {
  id: serial("id").primaryKey(),
  downloadId: text("download_id").notNull().unique(), // Unique download identifier (e.g., DL-2024-AST-001)
  downloaderUserId: integer("downloader_user_id").notNull(),
  downloaderName: text("downloader_name").notNull(),
  downloaderRole: text("downloader_role").notNull(),
  downloaderBusinessId: integer("downloader_business_id"),
  downloaderBranchCode: text("downloader_branch_code"),
  downloaderBranchName: text("downloader_branch_name"),
  format: text("format").notNull(), // 'EXCEL', 'PDF', 'CSV'
  recordCount: integer("record_count").notNull(),
  qrCodeData: text("qr_code_data").notNull(), // Base64 encoded QR code image
  qrCodePayload: jsonb("qr_code_payload"), // QR code content (download details)
  createdAt: timestamp("created_at").defaultNow(),
  status: text("status").notNull().default("COMPLETED"), // 'COMPLETED' or 'APPROVED'
});

// P7. Enterprise Daily Checklists (unified across all 7 business modules)
// 7a. Checklist item templates — the manageable master list of tasks per business+branch.
//     OWNER / GENERAL_MANAGER / BRANCH_MANAGER can add, edit, activate & deactivate items
//     and assign them to a user/worker. Deactivated items stay in history.
export const checklistTemplates = pgTable("checklist_templates", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  taskKey: text("task_key").notNull(),
  taskLabel: text("task_label").notNull(),
  category: text("category").default("GENERAL"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  assignedToUserId: integer("assigned_to_user_id"),
  assignedToName: text("assigned_to_name"),
  assignedToRole: text("assigned_to_role"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at"),
});

// 7b. Daily checklist entries — one row per task per business+branch+date.
//     Generated from active templates; completion records who did it and when.
export const checklistEntries = pgTable("checklist_entries", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  checklistDate: text("checklist_date").notNull(),
  templateId: integer("template_id"),
  taskKey: text("task_key").notNull(),
  taskLabel: text("task_label").notNull(),
  category: text("category").default("GENERAL"),
  assignedToUserId: integer("assigned_to_user_id"),
  assignedToName: text("assigned_to_name"),
  assignedToRole: text("assigned_to_role"),
  isCompleted: boolean("is_completed").default(false),
  completedByName: text("completed_by_name"),
  completedByRole: text("completed_by_role"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// 7c. Daily Notes — free-form end-of-day notes workers file under the Daily
//     Checklist (activities, observations, problems, notices). Every note is
//     analysed by GoMina AI on submission: issues detected, severity scored,
//     concise summary generated — feeding the business' living history.
export const dailyNotes = pgTable("daily_notes", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  noteDate: text("note_date").notNull(), // YYYY-MM-DD (branch business day)
  userId: integer("user_id"),
  userName: text("user_name").notNull(),
  userRole: text("user_role"),
  content: text("content").notNull(),
  wordCount: integer("word_count").default(0),
  // ── GoMina AI analysis snapshot ──
  aiSummary: text("ai_summary"),
  aiIssues: jsonb("ai_issues").default([]), // [{category,label,severity,matches[]}]
  aiSeverity: text("ai_severity").default("INFO"), // INFO | WATCH | URGENT
  aiFlags: jsonb("ai_flags").default([]), // short chip strings for the UI
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at"),
});

// 7d. Business Insights — the AI's continuously-updated memory of a business:
//     a rolling narrative, an issue register (recurring problems with counts),
//     category trend counters and a capped chronological history digest of
//     every analysed day. Updated atomically whenever a daily note lands.
export const businessInsights = pgTable("business_insights", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull().unique(),
  notesAnalyzed: integer("notes_analyzed").notNull().default(0),
  lastNoteDate: text("last_note_date"),
  rollingSummary: text("rolling_summary"), // AI narrative of recent operations
  issueRegister: jsonb("issue_register").notNull().default([]), // [{category,label,severity,count,firstDate,lastDate}]
  categoryTrends: jsonb("category_trends").notNull().default({}), // {CATEGORY: totalMentions}
  history: jsonb("history").notNull().default([]), // [{date,summary,severity,issues[],noteCount}] newest first, capped
  updatedAt: timestamp("updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// T1. Electronics Shop — Customer Orders (sales pipeline with fulfillment status)
export const electronicsOrders = pgTable("electronics_orders", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  orderNumber: text("order_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  itemName: text("item_name").notNull(),
  inventoryId: integer("inventory_id"),
  quantity: integer("quantity").notNull(),
  unitPriceGhs: doublePrecision("unit_price_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING, READY, DELIVERED, CANCELLED
  dueDate: text("due_date"),
  fulfilledDate: text("fulfilled_date"), // set when the order completed its sale (stock deducted + finance recorded)
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// T2. Electronics Shop — Serial Number Tracking (per-unit lifecycle & warranty)
export const electronicsSerials = pgTable("electronics_serials", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  serialNumber: text("serial_number").notNull().unique(),
  productName: text("product_name").notNull(),
  brand: text("brand"),
  inventoryId: integer("inventory_id"),
  status: text("status").notNull().default("IN_STOCK"), // IN_STOCK, SOLD, RESERVED, RETURNED, UNDER_REPAIR
  customerName: text("customer_name"),
  saleDate: text("sale_date"),
  warrantyMonths: integer("warranty_months").default(12),
  warrantyEnd: text("warranty_end"),
  priceGhs: doublePrecision("price_ghs").default(0),
  createdByName: text("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
});

// T3. Electronics Shop — Warranty Claims, Returns & Repairs
export const electronicsWarranties = pgTable("electronics_warranties", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  claimNumber: text("claim_number").notNull().unique(),
  productName: text("product_name").notNull(),
  serialNumber: text("serial_number"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone"),
  issueType: text("issue_type").notNull().default("WARRANTY_CLAIM"), // WARRANTY_CLAIM, RETURN, REPAIR
  status: text("status").notNull().default("OPEN"), // OPEN, IN_PROGRESS, RESOLVED, CANCELLED
  description: text("description"),
  costGhs: doublePrecision("cost_ghs").default(0),
  loggedDate: text("logged_date").notNull(),
  resolvedDate: text("resolved_date"),
  handledByName: text("handled_by_name"),
  handledByRole: text("handled_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// T4. Electronics Shop — Supplier Purchases (received stock auto-books inventory + expense)
export const electronicsPurchases = pgTable("electronics_purchases", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  purchaseNumber: text("purchase_number").notNull().unique(),
  supplierName: text("supplier_name").notNull(),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitCostGhs: doublePrecision("unit_cost_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("ORDERED"), // ORDERED, RECEIVED, CANCELLED
  orderDate: text("order_date").notNull(),
  receivedDate: text("received_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// R1. Restaurant & Kitchen — Orders (kitchen ticket pipeline)
export const restaurantOrders = pgTable("restaurant_orders", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  orderNumber: text("order_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  itemName: text("item_name").notNull(),
  menuItemId: integer("menu_item_id"),
  quantity: integer("quantity").notNull(),
  unitPriceGhs: doublePrecision("unit_price_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  orderType: text("order_type").notNull().default("DINE_IN"), // DINE_IN, TAKEAWAY, DELIVERY
  status: text("status").notNull().default("QUEUED"), // QUEUED, COOKING, READY, SERVED, CANCELLED
  orderedDate: text("ordered_date").notNull(),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});

// R2. Restaurant & Kitchen — Menu master (price + recipe cost per plate drives food-cost analytics)
export const restaurantMenuItems = pgTable("restaurant_menu_items", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  name: text("name").notNull(),
  category: text("category").default("MAIN"), // STARTER, MAIN, SIDE, DRINK, DESSERT
  priceGhs: doublePrecision("price_ghs").notNull(),
  costGhs: doublePrecision("cost_ghs").default(0), // recipe cost per plate
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// R3. Restaurant & Kitchen — Food Waste log (decrements stock, feeds cost analytics)
export const restaurantWaste = pgTable("restaurant_waste", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  itemName: text("item_name").notNull(),
  inventoryId: integer("inventory_id"),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").default("Units"),
  reason: text("reason").notNull().default("SPOILAGE"), // SPOILAGE, EXPIRED, OVERCOOKED, PREP_LOSS, CUSTOMER_RETURN
  costGhs: doublePrecision("cost_ghs").default(0),
  loggedDate: text("logged_date").notNull(),
  recordedByName: text("recorded_by_name"),
  recordedByRole: text("recorded_by_role"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// R4. Restaurant & Kitchen — Supplier Purchases (RECEIVED stock-ins update inventory + finance)
export const restaurantPurchases = pgTable("restaurant_purchases", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull(),
  branchCode: text("branch_code"),
  purchaseNumber: text("purchase_number").notNull().unique(),
  supplierName: text("supplier_name").notNull(),
  itemName: text("item_name").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").default("Kg"),
  unitCostGhs: doublePrecision("unit_cost_ghs").notNull(),
  totalGhs: doublePrecision("total_ghs").notNull(),
  status: text("status").notNull().default("ORDERED"), // ORDERED, RECEIVED, CANCELLED
  orderDate: text("order_date").notNull(),
  receivedDate: text("received_date"),
  notes: text("notes"),
  createdByName: text("created_by_name"),
  createdByRole: text("created_by_role"),
  createdAt: timestamp("created_at").defaultNow(),
});
