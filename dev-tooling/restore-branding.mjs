// Branding self-heal: restores the owner's REAL GoMina crest (business logo,
// per-branch logos and company logo) from the branding backup whenever the
// live database row has been blanked (e.g. after a sandbox rebuild that
// rolled the DB back to an older snapshot).
//
// Safety rules:
//  • NEVER overwrite a non-empty live value — if the DB holds data, a newer
//    deliberate upload by the user always wins.
//  • Values are restored byte-identically (md5-verified against the backup).
//
// Search order for the backup file:
//  1. /home/user/branding-backup.json       (workspace-level copy)
//  2. dev-tooling/backups/branding-backup.json (repo copy, survives wipes)
//
// Run: node dev-tooling/restore-branding.mjs

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const CANDIDATES = [
  "/home/user/branding-backup.json",
  new URL("./backups/branding-backup.json", import.meta.url).pathname,
];
const backupPath = CANDIDATES.find((p) => existsSync(p));
if (!backupPath) {
  console.log("restore-branding: no backup file found — nothing to do");
  process.exit(0);
}
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const md5 = (s) => createHash("md5").update(s ?? "").digest("hex");

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();

let healedBiz = 0, healedBranch = 0, healedCompany = 0, keptNewer = 0;

// ── Business logos + per-branch overrides ─────────────────────────────────
for (const b of backup.businesses || []) {
  const row = (await client.query("SELECT logo, branch_logos FROM businesses WHERE id=$1", [b.id])).rows[0];
  if (!row) continue;

  const backupLogo = b.logo || "";
  const liveLogo = row.logo || "";
  if (!liveLogo && backupLogo) {
    await client.query("UPDATE businesses SET logo=$2 WHERE id=$1", [b.id, backupLogo]);
    const after = (await client.query("SELECT logo FROM businesses WHERE id=$1", [b.id])).rows[0].logo || "";
    if (md5(after) !== md5(backupLogo)) throw new Error(`logo restore for business ${b.id} not byte-identical`);
    console.log(`✔ business ${b.code}: crest restored (${backupLogo.length} chars, md5 ${md5(after).slice(0, 8)}✓)`);
    healedBiz++;
  } else if (liveLogo && backupLogo && md5(liveLogo) !== md5(backupLogo)) {
    console.log(`• business ${b.code}: live logo differs from backup — keeping LIVE (newer upload wins)`);
    keptNewer++;
  }

  const backupBL = b.branchLogos && typeof b.branchLogos === "object" ? b.branchLogos : null;
  const liveBLTxt = JSON.stringify(row.branch_logos ?? {});
  const backupBLTxt = backupBL ? JSON.stringify(backupBL) : "{}";
  if (backupBL && Object.keys(backupBL).length > 0 && liveBLTxt === "{}") {
    await client.query("UPDATE businesses SET branch_logos=$2 WHERE id=$1", [b.id, backupBLTxt]);
    const after = JSON.stringify((await client.query("SELECT branch_logos FROM businesses WHERE id=$1", [b.id])).rows[0].branch_logos ?? {});
    if (md5(after) !== md5(backupBLTxt)) throw new Error(`branch_logos restore for business ${b.id} not byte-identical`);
    console.log(`✔ business ${b.code}: branch logos restored (${Object.keys(backupBL).length} branch(es), md5 ${md5(after).slice(0, 8)}✓)`);
    healedBranch++;
  }
}

// ── Company-level crest (group settings, id=1) ────────────────────────────
const cs = backup.companySettings || {};
if (cs.company_logo) {
  const row = (await client.query("SELECT company_logo FROM company_settings WHERE id=1")).rows[0];
  if (row && !(row.company_logo || "")) {
    await client.query("UPDATE company_settings SET company_logo=$1 WHERE id=1", [cs.company_logo]);
    const after = (await client.query("SELECT company_logo FROM company_settings WHERE id=1")).rows[0].company_logo || "";
    if (md5(after) !== md5(cs.company_logo)) throw new Error("company_logo restore not byte-identical");
    console.log(`✔ company crest restored (${cs.company_logo.length} chars, md5 ${md5(after).slice(0, 8)}✓)`);
    healedCompany++;
  }
}

console.log(`restore-branding: ${healedBiz} business crest(s) + ${healedBranch} branch-logo set(s) + ${healedCompany} company crest healed; ${keptNewer} newer live value(s) kept as-is`);
await client.end();
