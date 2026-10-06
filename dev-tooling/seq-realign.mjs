/**
 * seq-realign.mjs — forward-only serial-sequence realignment, shared by the
 * schema reconciler (`migrate-production-schema.mjs`, run by `npm run
 * db:migrate` on every build) and the sandbox bootstrap (`migrate-multiowner.mjs`).
 *
 * WHY THIS EXISTS (bug fixed 2026-10)
 * -----------------------------------
 * Seeded/restored rows are inserted with EXPLICIT ids, which bypass the
 * sequence: after such a seed the sequence lags the table and the next runtime
 * insert collides (23505). The historical repair was
 *
 *     setval(seq, max(id), count(*) > 0)
 *
 * …which also REWINDS the sequence whenever the highest-numbered rows have been
 * deleted (a normal event: test suites, demo resets, deleted organizations).
 * Rewinding makes the database REUSE primary keys of deleted rows. In this
 * schema every organization gets a `company_settings` row with a UNIQUE
 * organization_id, and that row was not always removed with its organization:
 * a reused organization id then hit the stale row and provisioning died with
 *
 *     duplicate key value violates unique constraint "company_settings_org_uq"
 *
 * …AFTER the organization and its owner had already been inserted — an orphan
 * workspace plus a registration request that could never be provisioned.
 *
 * The repair therefore only ever moves a sequence FORWARD:
 *
 *     setval(seq, greatest(max(id), current_value), (count(*) > 0) OR is_called)
 *
 *  · table has rows ⇒ next value is max(id)+1 (or higher, never lower);
 *  · table empty, sequence never used ⇒ stays unused, first row takes id 1;
 *  · table empty, sequence already advanced ⇒ stays advanced (no reuse).
 */

/**
 * Realign every `public` serial `id` sequence in a forward-only fashion.
 * @param {import("pg").Client} client connected pg client
 * @param {(msg: string) => void} [log] optional logger
 */
export async function realignSequencesForwardOnly(client, log) {
  const tables = await client.query(
    `select t.relname as table_name
       from pg_class t join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relkind = 'r'`,
  );
  let checked = 0;
  for (const { table_name } of tables.rows) {
    // Natural-key tables (e.g. system_markers) have no `id`; pg_get_serial_sequence
    // raises for those — skip them instead of failing the migration.
    const seq = await client.query(`select pg_get_serial_sequence($1, 'id') as s`, [`public.${table_name}`]);
    const full = seq.rows[0]?.s;
    if (!full) continue;
    const short = full.startsWith("public.") ? full.slice(7) : full;
    const q = `'${short.replace(/'/g, "''")}'`;
    await client.query(
      `select setval(${q},
         greatest((select coalesce(max(id), 0) from public.${table_name}),
                  (select last_value from ${short})),
         ((select count(*) > 0 from public.${table_name}) or (select is_called from ${short})))`,
    );
    checked++;
  }
  log?.(`[seq] ${checked} serial sequence(s) realigned forward-only (never rewound)`);
}
