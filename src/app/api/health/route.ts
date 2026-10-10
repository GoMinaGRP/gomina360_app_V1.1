import { resolvedDbEnvName } from "@/db";
import { userBusinessAccess, users, userSessions } from "@/db/schema";

export const dynamic = "force-dynamic";

const LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1|\[::1\])$/i;

/**
 * Map a root-cause DB error to ONE actionable remediation line. Everything an
 * operator needs to self-fix a broken deployment is right in this JSON —
 * symptom → exact cause → exact action. Order matters: most specific first.
 */
function hintFor(root: any): string | null {
  const msg = String(root?.message || "");
  const m = msg.toLowerCase();
  const code = root?.code;

  // Our own configuration errors (missing env / loopback on a managed host).
  if (/not configured|misconfiguration/i.test(msg)) {
    return "Set DATABASE_URL to your MANAGED PostgreSQL connection string in Vercel → Project → Settings → Environment Variables (Production AND Preview), then redeploy — OR attach the database via the Storage tab so Vercel auto-creates POSTGRES_URL / POSTGRES_PRISMA_URL (also accepted). 127.0.0.1/localhost can never work on Vercel — that address means the serverless function itself.";
  }
  // A table exists but is older than the application schema.
  if (code === "42703" || /column "?[a-z_]+"? does not exist/.test(m)) {
    return "The connected database schema is older than this deployment. Run the checked-in migration against this exact database: DATABASE_URL=\"<managed-url>\" npm run db:migrate — then redeploy. Do not run the command without the managed URL.";
  }
  // Schema was never pushed to this database.
  if (code === "42P01" || /relation "?[a-z_]+"? does not exist/.test(m)) {
    return "The database has no tables yet. From your machine run: DATABASE_URL=\"<managed-url>\" npx drizzle-kit push  — then open https://<your-app>/api/init once to seed the owner account.";
  }
  // Database name in the URL doesn't exist on that server.
  if (code === "3D000" || /database "[^"]+" does not exist/.test(m)) {
    return "The database NAME in your connection string does not exist on that server — create the database, or fix the path segment of the URL (the part after the last '/').";
  }
  // Wrong credentials.
  if (code === "28P01" || m.includes("password authentication failed")) {
    return "Database credentials rejected — wrong username or password in your connection string. Re-copy the full connection string from your Postgres provider (URL-encode special characters in the password, e.g. @ → %40).";
  }
  // Connection-slot exhaustion.
  if (code === "53300" || /too many (client|connection)|remaining connection slots/.test(m)) {
    return "Connection limit reached. Use your provider's POOLED/serverless URL (Neon '-pooler', Supabase port 6543, Vercel Postgres pooled) and keep PG_POOL_MAX=2 on Vercel.";
  }
  // DNS.
  if (/enotfound|eai_again/.test(m)) {
    return "DNS cannot resolve the database host — the hostname in your connection string is wrong or truncated. (If it is 127.0.0.1/localhost you copied the local sandbox URL — use the MANAGED one instead.)";
  }
  // TCP refused.
  if (m.includes("econnrefused")) {
    return "TCP connection refused — wrong host or port, the database is stopped, or the connection string points at 127.0.0.1/localhost (on Vercel nothing listens there).";
  }
  // Network timeout / reset.
  if (/etimedout|timed? out|econnreset/.test(m)) {
    return "Network timeout — an IP allowlist/firewall is blocking Vercel, the database is inside a private VPC (Vercel can't reach it), or a serverless database is asleep (retry in ~30s).";
  }
  // TLS.
  if (/self.signed|certificate|ssl|tls/.test(m)) {
    return "TLS handshake problem — append ?sslmode=no-verify to your connection string, or remove ssl parameters from the URL and set PGSSLMODE=require as a separate variable.";
  }
  return null;
}

// Sanitized snapshot of where the app THINKS the database lives (no creds).
/**
 * PERF · report whether the database and the functions are in the SAME region.
 *
 * `vercel.json` pins the serverless functions to one region, and the database
 * lives wherever its provider was created. When those two disagree, every
 * single query crosses an ocean, and the tax is invisible in local development
 * because everything is on loopback. This is the single most common cause of
 * "the deployed app is slow" — and until now nothing in the app said so.
 *
 * Neon encodes the region in the hostname, e.g.
 *   ep-name-abc123-pooler.eu-central-1.aws.neon.tech
 * so the pairing can be checked without any extra configuration. A host that
 * does not announce a region simply reports `unknown` — never a false alarm.
 */
const VERCEL_REGION_TO_AWS: Record<string, string> = {
  fra1: "eu-central-1",
  ams1: "eu-west-1",
  lhr1: "eu-west-2",
  dub1: "eu-west-1",
  iad1: "us-east-1",
  sfo1: "us-west-1",
  ord1: "us-east-2",
  pdx1: "us-west-2",
  gru1: "sa-east-1",
  syd1: "ap-southeast-2",
  sin1: "ap-southeast-1",
};

function regionDiag(hostname: string): Record<string, unknown> {
  const dbRegion = hostname.match(/\.([a-z]{2}-[a-z]+-\d)\./)?.[1] ?? null;
  const vercelRegion = process.env.VERCEL_REGION || null;
  if (!dbRegion || !vercelRegion) {
    return {
      dbRegion,
      vercelRegion,
      regionNote: dbRegion
        ? "Set VERCEL_REGION awareness by checking the Vercel project region against the Neon region in vercel.json."
        : "This database hostname does not advertise a region; confirm it matches vercel.json by hand.",
    };
  }
  const expected = VERCEL_REGION_TO_AWS[vercelRegion] ?? null;
  const matched = expected ? expected === dbRegion : null;
  return {
    dbRegion,
    vercelRegion,
    regionMatched: matched,
    regionNote: matched
      ? `Database and functions are both in ${dbRegion}.`
      : expected
        ? `MISMATCH — functions run in ${vercelRegion} (${expected}) but the database is in ${dbRegion}. Every query pays an extra ocean crossing. Move the database to ${expected}, or change "regions" in vercel.json to a region near ${dbRegion}.`
        : `Functions run in ${vercelRegion}; database is in ${dbRegion}. Compare them manually — no built-in mapping for ${vercelRegion}.`,
  };
}

// Sanitized snapshot of where the app THINKS the database lives (no creds).
function connectionDiag(): Record<string, unknown> | null {
  const viaEnv = resolvedDbEnvName();
  const url = viaEnv ? process.env[viaEnv] : undefined;
  const base: Record<string, unknown> = {
    dbUrlEnv: viaEnv, // which variable name supplies the connection (null = none set)
    databaseUrlSet: !!process.env.DATABASE_URL?.trim(),
    postgresUrlSet: !!process.env.POSTGRES_URL?.trim(),
    postgresPrismaUrlSet: !!process.env.POSTGRES_PRISMA_URL?.trim(),
    vercel: !!process.env.VERCEL,
    requireExternalDb: process.env.REQUIRE_EXTERNAL_DB === "true",
    poolMax: Math.max(1, Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 2 : 10)),
  };
  if (!url) return base;
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//i, "https://"));
    return {
      ...base,
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, ""),
      user: u.username ? `${u.username.slice(0, 2)}…` : null,
      loopbackHost: LOCAL_HOST_PATTERN.test(u.hostname),
      sslmode: u.searchParams.get("sslmode"),
      ...regionDiag(u.hostname),
    };
  } catch {
    return { ...base, host: "<unparsable DATABASE_URL>" };
  }
}

export async function GET() {
  try {
    // The db module builds its pool lazily on first query, so a missing or
    // misconfigured DATABASE_URL throws HERE with a clear configuration
    // error — report it as JSON instead of a bare 500.
    const { db } = await import("@/db");

    // This is a readiness probe, not merely a PostgreSQL socket check. Login
    // reads every users column, creates a user_sessions row and (for non-owner
    // accounts) reads user_business_access. A bare `select 1` can therefore be
    // green while every real sign-in fails because the deployed database has
    // an absent or stale auth schema. Selecting each complete table makes
    // PostgreSQL validate the same tables and columns without mutating data.
    await db.select().from(users).limit(1);
    await db.select().from(userSessions).limit(1);
    await db.select().from(userBusinessAccess).limit(1);

    // F-14 · scheduler visibility. Vercel does not retry a failed cron and
    // does not alert on one, so "overdue activities quietly stopped being
    // processed" was invisible until someone noticed a missing escalation.
    // The last successful sweep is the single number that answers it, and it
    // must never turn THIS endpoint red — a stale sweep is a reportable
    // condition, not an outage of the app.
    let dailyOps: Record<string, unknown> | null = null;
    try {
      const { lastDailyOps } = await import("@/lib/dailyOps");
      dailyOps = await lastDailyOps();
    } catch {
      dailyOps = { error: "daily-ops status unavailable" };
    }

    return Response.json({ ok: true, dailyOps });
  } catch (e: any) {
    // Operators: this is THE one-stop diagnosis for any DB outage. Drizzle
    // wraps driver errors in "Failed query", so unwrap `cause` to surface the
    // REAL reason — ECONNREFUSED / ENOTFOUND (unreachable host), 28P01 (wrong
    // password), "too many clients" (pool limits), config errors, … — never
    // the connection string itself.
    const root = (e?.cause?.message ? e.cause : e) as any;
    return Response.json(
      {
        ok: false,
        error: root?.message || "Database unavailable",
        code: root?.code || null,
        hint: hintFor(root),
        // Include the sanitized connection snapshot only when explicitly
        // debugging (DB_DEBUG=true) — never expose host details by default.
        ...(process.env.DB_DEBUG === "true" ? { diag: connectionDiag() } : {}),
      },
      { status: 500 },
    );
  }
}
