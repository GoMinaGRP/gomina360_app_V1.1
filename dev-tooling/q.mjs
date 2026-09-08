// Ad-hoc SQL runner: node dev-tooling/q.mjs "<sql>" (multi-statement OK).
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const sql = process.argv[2];
if (!sql) { console.error('usage: node dev-tooling/q.mjs "<sql>"'); process.exit(1); }
const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
try {
  const res = await client.query(sql);
  for (const r of Array.isArray(res) ? res : [res]) {
    if (r.rows && r.rows.length) console.log(JSON.stringify(r.rows, null, 1));
    else console.log(`[${r.command}] rows=${r.rowCount ?? "n/a"}`);
  }
} finally {
  await client.end();
}
