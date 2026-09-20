// Starts the workspace-local PostgreSQL (embedded-postgres) on 127.0.0.1:5432
// with data dir $PGDATA (default /home/user/pgtooling/pgdata).
// Self-healing: the tooling dir lives outside the git repo and does NOT
// survive sandbox snapshot resets — re-install deps on demand before boot.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TOOLS = "/home/user/pgtooling";
if (!existsSync(`${TOOLS}/node_modules/embedded-postgres`)) {
  console.log("· tooling deps missing (snapshot reset?) — reinstalling…");
  execFileSync("mkdir", ["-p", TOOLS]);
  if (!existsSync(`${TOOLS}/package.json`)) {
    execFileSync("npm", ["init", "-y"], { cwd: TOOLS, stdio: "ignore" });
  }
  execFileSync("npm", ["install", "embedded-postgres@latest", "pg@8.20.0"], { cwd: TOOLS, stdio: "inherit" });
}
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
