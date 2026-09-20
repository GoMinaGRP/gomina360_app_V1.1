/**
 * Org-membership backfill (Signed-In Staff Phase D3 — finding F-7), idempotent.
 *
 * Any user with NO row in organization_members is enrolled into the org that
 * OWNS their primary branch (assigned_business_id → businesses.owner_id →
 * organizations.owner_user_id, first ACTIVE org by id). Users with no branch
 * (HQ / platform accounts) fall back to org #1, matching the original
 * migrate-multiowner Phase-1 convention. users.primary_org_id is set when
 * empty. Safe to run repeatedly. Usage:
 *   DATABASE_URL=postgres://… node dev-tooling/backfill-org-members.mjs
 */
import { createRequire } from "node:module";
const { Client } = createRequire(import.meta.url)("pg");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

async function main() {
  const c = new Client(DB);
  await c.connect();
  console.log("· connected", DB.replace(/:[^:@/]+@/, ":***@"));
  await c.query("SELECT pg_advisory_xact_lock(731947)"); // org-backfill lock
  await c.query("BEGIN");
  try {
    const orphan = await c.query(`
      SELECT u.id, u.name, u.role, u.assigned_business_id AS biz
      FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)
      ORDER BY u.id`);
    console.log(`· org-less users: ${orphan.rowCount}`);
    let enrolled = 0;
    for (const u of orphan.rows) {
      let orgId = null;
      if (u.biz != null) {
        const b = await c.query(`SELECT owner_id FROM businesses WHERE id = $1`, [u.biz]);
        const ownerId = b.rows[0]?.owner_id ?? null;
        if (ownerId != null) {
          const o = await c.query(
            `SELECT id FROM organizations WHERE owner_user_id = $1 ORDER BY id ASC LIMIT 1`,
            [ownerId],
          );
          orgId = o.rows[0]?.id ?? null;
        }
      }
      if (orgId == null) {
        const fb = await c.query(`SELECT id FROM organizations WHERE id = 1`);
        orgId = fb.rows[0]?.id ?? null;
      }
      if (orgId == null) continue; // no orgs at all — nothing safe to do
      const roleInOrg = u.role === "OWNER" ? "OWNER" : "MEMBER";
      await c.query(
        `INSERT INTO organization_members (organization_id, user_id, role_in_org, is_primary, created_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [orgId, u.id, roleInOrg],
      );
      await c.query(`UPDATE users SET primary_org_id = $1 WHERE id = $2 AND primary_org_id IS NULL`, [orgId, u.id]);
      console.log(`  ✔ user #${u.id} (${u.name}) → org #${orgId}`);
      enrolled++;
    }
    console.log(`· enrolled: ${enrolled}`);
    await c.query("COMMIT");
    console.log("DONE_ORG_BACKFILL");
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("FAIL_ORG_BACKFILL", e?.message || e);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();
