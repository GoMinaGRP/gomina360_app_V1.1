// Starts the workspace-local PostgreSQL (embedded-postgres) on 127.0.0.1:5432
// with data dir $PGDATA (default /home/user/pgtooling/pgdata).
// Deps resolve from /home/user/pgtooling/node_modules (see recover.sh).
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const EmbeddedPostgres = req("embedded-postgres").default ?? req("embedded-postgres");

const pg = new EmbeddedPostgres({
  databaseDir: process.env.PGDATA || "/home/user/pgtooling/pgdata",
  user: "postgres",
  password: "postgres",
  port: 5432,
  persistent: true,
});

await pg.initialise();
await pg.start();
console.log("PG started on 5432");
try {
  await pg.createDatabase("app_db");
  console.log("app_db created");
} catch (e) {
  console.log("createDatabase: " + e.message);
}
setInterval(() => {}, 1 << 30);
