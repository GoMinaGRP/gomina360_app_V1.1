// Seeds realistic demo activity for each of the LAST 7 DAYS (today + the six
// days before) so the Audit & Review → Records day grouping — Today,
// Yesterday, then each previous date — has content to show on a freshly
// recovered database. Without it, a reseeded demo has records only for
// "today" (everything is created at recovery time) plus backdated fixtures,
// and the 7-day zone renders as just "Today" + History.
//
// Idempotent: every row carries a stable key (DEMO7D-… transaction numbers,
// demo7d_* task keys) and is skipped when it already exists. Run any time:
//   node dev-tooling/seed-recent-demo.mjs
import { createRequire } from "node:module";
const { Client } = createRequire(import.meta.url)("pg");

const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const c = new Client(DB);
await c.connect();

const day = async (offset) => (await c.query(`SELECT to_char(CURRENT_DATE - ${offset}, 'YYYY-MM-DD') AS d`)).rows[0].d;

let created = 0, skipped = 0;
for (let offset = 0; offset <= 6; offset++) {
  const d = await day(offset);
  const stamp = d.replaceAll("-", "");

  // Three finance records for the day — a sale, an expense, a MoMo transfer —
  // recorded at realistic clock times (so within-day newest-first ordering
  // and the HH:MM stamps are demonstrable).
  const txns = [
    { n: 1, type: "INCOME", cat: "Egg Sales", amt: 1850 + offset * 45, method: "MTN_MOMO", clock: "07:4" + (5 + offset % 4), desc: "Morning egg sales — crates supplied to market traders", biz: 1, branch: "POULTRY-01", by: "Akua Donkor", role: "WORKER", uid: 10 },
    { n: 2, type: "EXPENSE", cat: "Feed Expense", amt: 940 + offset * 12.5, method: "CASH", clock: "12:1" + (offset % 9), desc: "Layer mash restock — 50kg bags from Ghafeed", biz: 1, branch: "POULTRY-01", by: "Kwame Mina", role: "OWNER", uid: 1 },
    { n: 3, type: "INCOME", cat: "Block Sales", amt: 2360 + offset * 80, method: "BANK_TRANSFER", clock: "16:5" + (2 + offset % 6), desc: "Bulk block order — site delivery, invoiced to contractor", biz: 2, branch: "BLOCK-01", by: "Kwame Mina", role: "OWNER", uid: 1 },
  ];
  for (const t of txns) {
    const num = `DEMO7D-T${stamp}-${t.n}`;
    const have = await c.query(`SELECT 1 FROM transactions WHERE transaction_number = $1`, [num]);
    if (have.rowCount) { skipped++; continue; }
    await c.query(
      `INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETED',$10,$11,$12, ($13::date + time '${t.clock}'))`,
      [num, t.biz, t.branch, t.type, t.cat, t.amt, t.method, t.desc, d, t.by, t.role, t.uid, d],
    );
    created++;
  }

  // Two completed daily-checklist tasks for the day (assigned to Akua), so
  // the OPERATIONS module shows per-day activity as well.
  const tasks = [
    { key: "demo7d_poultry_round", label: "Morning poultry house round & water check", cat: "POULTRY", clock: "06:3" + (offset % 9) },
    { key: "demo7d_store_close", label: "Close-of-day store reconciliation", cat: "SALES", clock: "18:2" + (offset % 8) },
  ];
  for (const t of tasks) {
    const have = await c.query(
      `SELECT 1 FROM checklist_entries WHERE business_id = 1 AND task_key = $1 AND checklist_date = $2`,
      [t.key, d],
    );
    if (have.rowCount) { skipped++; continue; }
    await c.query(
      `INSERT INTO checklist_entries (business_id, branch_code, checklist_date, task_key, task_label, category, is_completed, completed_at, completed_by_name, completed_by_role, notes, assigned_to_name, assigned_to_user_id)
       VALUES (1, 'POULTRY-01', $1, $2, $3, $4, TRUE, ($5::date + time '${t.clock}'), 'Akua Donkor', 'WORKER', 'DEMO7D — routine completion, no exceptions noted', 'Akua Donkor', 10)`,
      [d, t.key, t.label, t.cat, d],
    );
    created++;
  }
  console.log(`· ${d}: day window populated (offset -${offset})`);
}

console.log(`seed-recent-demo: ${created} rows created, ${skipped} already present (idempotent skip)`);
await c.end();
