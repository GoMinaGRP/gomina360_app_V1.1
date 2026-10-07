/**
 * Multi-owner migration — Phase 1 backfill (idempotent, additive-only).
 *
 * Creates org #1 ("GoMina Group"), marks the original Owner super admin,
 * enrolls every existing user as an org-1 member, and backfills the new
 * tenant columns via joins through businesses.owner_id.
 * Safe to run repeatedly. Usage: node dev-tooling/migrate-multiowner.mjs
 */
import { createRequire } from "node:module";
import { realignSequencesForwardOnly } from "./seq-realign.mjs";
const { Client } = createRequire(import.meta.url)("pg");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

async function main() {
  const c = new Client(DB);
  await c.connect();
  console.log("· connected", DB.replace(/:[^:@/]+@/, ":***@"));
  await c.query("SELECT pg_advisory_xact_lock(731946)"); // multi-owner migration lock
  await c.query("BEGIN");
  try {
    // ── 1. org #1 + super admin + memberships ──────────────────────────
    await c.query(`INSERT INTO organizations (id, name, slug, status, contact_email, owner_user_id, created_by_user_id)
                   SELECT 1, 'GoMina Group', 'gomina-group', 'ACTIVE', 'kwame.owner@gomina360.com', 1, 1
                   WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 1)`);
    // Serial realignment sweep: seeded explicit-id rows desynchronise the
    // serial sequence, so realign every public sequence against its live
    // max(id) — FORWARD-ONLY, never rewound (see dev-tooling/seq-realign.mjs
    // for why rewinding caused duplicate-key failures on organization id reuse).
    await realignSequencesForwardOnly(c, (m) => console.log(m));

    await c.query(`UPDATE users SET is_super_admin = TRUE WHERE id = 1 AND (is_super_admin IS DISTINCT FROM TRUE)`);
    await c.query(`UPDATE users SET primary_org_id = 1 WHERE primary_org_id IS NULL`);
    await c.query(`INSERT INTO organization_members (organization_id, user_id, role_in_org, is_primary)
                   SELECT 1, id, CASE WHEN role = 'OWNER' THEN 'OWNER' ELSE 'MEMBER' END, TRUE
                   FROM users
                   ON CONFLICT (organization_id, user_id) DO NOTHING`);
    await c.query(`UPDATE organizations SET owner_user_id = 1, updated_at = NOW() WHERE id = 1 AND owner_user_id IS NULL`);

    // ── 2. businesses ──────────────────────────────────────────────────
    const b = await c.query(`UPDATE businesses SET owner_id = 1 WHERE owner_id IS NULL`);
    console.log("· businesses backfilled", b.rowCount);
    await c.query(`ALTER TABLE businesses ALTER COLUMN owner_id SET NOT NULL`);
    await c.query(`CREATE INDEX IF NOT EXISTS businesses_owner_id_idx ON businesses (owner_id)`);

    // ── 3. businessId-anchored audit/download tables (join backfill) ───
    const linkBackfill = [
      // table, join column (nullable business id), fallback org
      ["record_deletion_logs", null], // has no business column → default below from snapshot
      ["asset_downloads", "downloader_business_id"],
      ["inventory_downloads", "downloader_business_id"],
    ];
    for (const [t, col] of linkBackfill) {
      if (col) {
        await c.query(`UPDATE ${t} x SET owner_id = b.owner_id FROM businesses b
                       WHERE x.${col} = b.id AND x.owner_id IS NULL`);
      }
      const r = await c.query(`UPDATE ${t} SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log(`· ${t} default backfill`, r.rowCount);
    }
    // record_deletion_logs via snapshot businessId when available
    await c.query(`UPDATE record_deletion_logs r SET owner_id = b.owner_id
                   FROM businesses b
                   WHERE (r.record_snapshot->>'businessId')::int = b.id AND r.owner_id = 1`);

    // asset_audit_logs: via assets → businesses
    await c.query(`UPDATE asset_audit_logs a SET owner_id = b.owner_id
                   FROM assets, businesses b
                   WHERE a.asset_id = assets.id AND assets.business_id = b.id AND a.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE asset_audit_logs SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· asset_audit_logs backfilled", r.rowCount);
    }

    // ── 4. nullable-businessId business tables ─────────────────────────
    await c.query(`UPDATE customers x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE customers SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· customers backfilled", r.rowCount);
    }
    await c.query(`UPDATE ai_insights x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE ai_insights SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· ai_insights backfilled", r.rowCount);
    }
    // Never attribute a platform-scope notification to a tenant: platform rows
    // carry business_id = NULL AND owner_id = NULL by design. Recipient org
    // first, then the org-1 fallback for business-scoped rows only (see the
    // same rule in migrate-production-schema.mjs).
    await c.query(`UPDATE notifications x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    // Platform-scope types are excluded: their recipient (the Super Admin) is a
    // tenant user, so recipient derivation would wrongly bind them to org 1.
    await c.query(`UPDATE notifications n SET owner_id = ou.primary_org_id FROM users ou
                   WHERE n.user_id = ou.id AND ou.primary_org_id IS NOT NULL AND n.owner_id IS NULL
                     AND n.type <> 'PLATFORM_REQUEST_NEW'`);
    {
      const r = await c.query(`UPDATE notifications SET owner_id = 1 WHERE owner_id IS NULL AND business_id IS NOT NULL`);
      console.log("· notifications backfilled", r.rowCount);
    }
    await c.query(`UPDATE universal_exports x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    await c.query(`UPDATE universal_exports x SET owner_id = u.primary_org_id FROM users u
                   WHERE x.requester_user_id = u.id AND x.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE universal_exports SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· universal_exports backfilled", r.rowCount);
    }
    await c.query(`UPDATE audit_trail x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    await c.query(`UPDATE audit_trail x SET owner_id = u.primary_org_id FROM users u
                   WHERE x.actor_user_id = u.id AND x.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE audit_trail SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· audit_trail backfilled", r.rowCount);
    }

    // ── 5. global tables → org 1 ownership ─────────────────────────────
    for (const t of ["suppliers", "integrations", "scenario_simulations"]) {
      const r = await c.query(`UPDATE ${t} SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log(`· ${t} backfilled`, r.rowCount);
    }
    // expense categories: business join, then composite unique enforcement
    await c.query(`UPDATE expense_categories x SET owner_id = b.owner_id FROM businesses b
                   WHERE x.business_id = b.id AND x.owner_id IS NULL`);
    {
      const r = await c.query(`UPDATE expense_categories SET owner_id = 1 WHERE owner_id IS NULL`);
      console.log("· expense_categories backfilled", r.rowCount);
    }
    await c.query(`ALTER TABLE expense_categories ALTER COLUMN owner_id SET NOT NULL`);

    // ── 6. singleton → per-org settings rows ───────────────────────────
    for (const t of ["company_settings", "customer_support_info", "payroll_statutory_config"]) {
      const r = await c.query(`UPDATE ${t} SET organization_id = 1 WHERE organization_id IS NULL`);
      console.log(`· ${t} linked to org 1`, r.rowCount);
    }
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS company_settings_org_uq ON company_settings (organization_id)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS customer_support_info_org_uq ON customer_support_info (organization_id)`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS payroll_statutory_config_org_uq ON payroll_statutory_config (organization_id)`);

    // indexes for tenant filtering
    for (const t of ["customers","suppliers","integrations","ai_insights","scenario_simulations",
                     "notifications","audit_trail","universal_exports","record_deletion_logs",
                     "asset_audit_logs","asset_downloads","inventory_downloads","expense_categories"]) {
      await c.query(`CREATE INDEX IF NOT EXISTS ${t}_owner_id_idx ON ${t} (owner_id)`);
    }

    await c.query("COMMIT");
    console.log("✅ multi-owner backfill committed");
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("❌ rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
