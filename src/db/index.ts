import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

type DrizzleDb = ReturnType<typeof drizzle>;

/**
 * THE one and only server-side database connection.
 *
 * Every API route (auth/login, auth/me, menu, businesses, orders, tracking,
 * inventory, finance, payroll, telecom, exports, …) and every server lib
 * (auth, trackingServer, provisioning, analytics) talks to PostgreSQL through
 * THIS Drizzle instance — there is intentionally no second Pool/Client
 * anywhere in src/.
 *
 * Configuration (Vercel / production and local dev alike):
 * - The connection comes ONLY from `process.env.DATABASE_URL`.
 * - There is NO fallback to 127.0.0.1:5432, localhost or any hardcoded
 *   instance — never, in any environment.
 * - Missing DATABASE_URL → configuration error on FIRST database use (never
 *   at import/build time), surfaced by GET /api/health as
 *   `{ ok: false, error: "<this message>", hint: "…" }` (500).
 * - On a MANAGED production host (Vercel — `VERCEL` env — or any host with
 *   `REQUIRE_EXTERNAL_DB=true`), a DATABASE_URL pointing at localhost /
 *   127.0.0.1 / loopback is a configuration error: managed production must
 *   never quietly talk to a local database. (Self-hosted appliances that
 *   deliberately run Postgres next to the app simply don't set VERCEL /
 *   REQUIRE_EXTERNAL_DB.)
 */

const LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1|\[::1\])$/i;

function resolveDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.trim()) {
    throw new Error(
      "GoMina 360 database is NOT configured: the DATABASE_URL environment variable is missing. " +
        "Set DATABASE_URL to your production PostgreSQL connection string (e.g. in Vercel → Settings → Environment Variables). " +
        "The server refuses to fall back to 127.0.0.1:5432 or localhost.",
    );
  }
  const loopbackBlocked = !!process.env.VERCEL || process.env.REQUIRE_EXTERNAL_DB === "true";
  if (loopbackBlocked) {
    let host = "";
    try {
      host = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//i, "https://")).hostname;
    } catch {
      /* unparsable URL — let the driver report it */
    }
    if (host && LOCAL_HOST_PATTERN.test(host)) {
      throw new Error(
        `GoMina 360 database misconfiguration: DATABASE_URL points at a local/loopback host ("${host}") on a managed production host. ` +
          "Point DATABASE_URL at your managed production PostgreSQL instance instead.",
      );
    }
  }
  return databaseUrl;
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

// Render a sanitized, credential-free description of the connection for logs.
function describeConnection(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl.replace(/^postgres(ql)?:\/\//i, "https://"));
    const sslMode =
      process.env.PGSSLMODE === "require"
        ? "require(PGSSLMODE override)"
        : process.env.PGSSLMODE === "disable"
        ? "disabled(PGSSLMODE override)"
        : u.searchParams.get("sslmode") || (u.searchParams.has("ssl") ? u.searchParams.get("ssl")! : "provider-default");
    return `host=${u.hostname} port=${u.port || 5432} database=${u.pathname.replace(/^\//, "")} sslmode=${sslMode}`;
  } catch {
    return "host=<unparsable DATABASE_URL>";
  }
}

/**
 * Create (once per process) or return the process-wide pool.
 *
 * LAZY BY DESIGN: the pool — and therefore resolveDatabaseUrl()'s hard
 * configuration error — materialises on the FIRST query, never at module
 * import time. That means:
 *  - `next build` on Vercel can never crash while collecting page data just
 *    because DATABASE_URL is missing from the build scope; the missing
 *    configuration surfaces instead as a clear 500 JSON on /api/health and
 *    a friendly message on the sign-in page.
 *  - Serverless cold starts only pay for a pool when a request actually
 *    needs the database.
 *
 * On Vercel/serverless this single global is reused across warm invocations
 * of the function, which keeps many routes from each opening their own pool
 * against the provider's connection limit (the classic "too many clients" /
 * slot-reserved production outage).
 */
export function getPool(): Pool {
  let pool = globalForDb.__arenaNextJsPostgresqlPool;
  if (!pool) {
    const databaseUrl = resolveDatabaseUrl(); // throws the clear config error HERE — on first use
    pool = new Pool({
      connectionString: databaseUrl,
      // SSL is driven by the connection string itself (sslmode=require etc., as
      // managed hosts like Vercel Postgres/Neon/Supabase provide); PGSSLMODE is
      // honoured as an explicit override.
      ssl:
        process.env.PGSSLMODE === "require"
          ? { rejectUnauthorized: false }
          : process.env.PGSSLMODE === "disable"
          ? false
          : undefined,
      // Serverless-friendly sizing: one function instance must not fan out 10+
      // sockets — managed Postgres free tiers hard-cap client connections.
      // Tune explicitly with PG_POOL_MAX when your plan allows more.
      max: Math.max(1, Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 2 : 10)),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    globalForDb.__arenaNextJsPostgresqlPool = pool;
    // One sanitized line per cold start — appears in the Vercel function logs
    // (Runtime Logs tab) and tells the operator EXACTLY which database the
    // deployment is really talking to, without ever printing credentials.
    console.log(`[db] pool created → ${describeConnection(databaseUrl)} max=${pool.options.max} vercel=${!!process.env.VERCEL}`);
  }
  return pool;
}

let cachedDb: DrizzleDb | undefined;

export function getDb(): DrizzleDb {
  return (cachedDb ??= drizzle(getPool()));
}

// Transparent lazy handles: every existing `import { db } from "@/db"` keeps
// working, but nothing touches the environment or the network until the
// first property access (i.e. the first real query).
const lazy = <T extends object>(resolve: () => T): T =>
  new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve() as any;
      const value = real[prop];
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_target, prop) {
      return prop in (resolve() as any);
    },
  });

export const pool = lazy(getPool);
export const db = lazy(getDb);
