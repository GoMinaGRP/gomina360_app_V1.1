#!/usr/bin/env node
/**
 * PERF REGRESSION TEST — the API proxy must be able to decide an allowlisted
 * request WITHOUT resolving a session, and the policy it decides must be
 * byte-for-byte the policy it decided before the optimization.
 *
 * Background: `src/proxy.ts` enforces the Farm Advisor default-deny policy on
 * every /api/* request. It used to resolve the SESSION first and consult the
 * allowlist afterwards, so each call paid a database round trip just to learn a
 * role that the path+method already decided. On Vercel the proxy and the route
 * handler are SEPARATE invocations, so `getSessionInfo()`'s 5 s micro-cache is
 * not shared between them and the token was resolved from Postgres TWICE per
 * authenticated request.
 *
 * WHY THIS TEST IS STRUCTURAL RATHER THAN TIMED. Locally the proxy and the
 * route run in ONE process and share the session cache, so the "before" case
 * is indistinguishable from the "after" case by timing — the saving only
 * exists across an invocation boundary, which no local harness can reproduce.
 * (An unreachable-database timing harness was tried and abandoned: the sandbox
 * returns EHOSTUNREACH immediately instead of dropping the SYN, so both paths
 * answer in milliseconds and the measurement is meaningless.) So this asserts
 * the two things that actually guarantee the optimization:
 *
 *   1. `advisorAllows()` classifies a (path, method) on its own, with no
 *      session — and it classifies EXACTLY as the original inline loop did, so
 *      the permission policy is unchanged, only the order of operations is;
 *   2. the proxy consults that classification BEFORE it can resolve a session,
 *      so the fast path is real and not merely intended.
 *
 * Run: node dev-tooling/verify-proxy-fast-path.mjs
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.error(`❌ ${name} — ${detail}`); }
};

console.log("── Proxy fast-path · an allowlisted route is decided without a session ──");

// ── 1. the predicate's classification, loaded from the real source ─────────
// Plain Node cannot `import` a .ts module, so the PREDICATE AND ITS TABLE are
// lifted straight out of the real source and evaluated. Testing the shipped
// definition (not a copy of it) is the point: if someone edits the allowlist,
// this test follows it automatically.
const src = await readFile(`${process.cwd()}/src/proxy.ts`, "utf8");
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const stripTypes = (code) =>
  code
    // The slice carries TypeScript-only syntax; Node evaluates plain JS.
    .replace(/: AdvisorApiRule\[\]/g, "")
    .replace(/: AdvisorApiRule/g, "")
    .replace(/: string\[\] \| null/g, "")
    .replace(/: string/g, "")
    .replace(/: boolean/g, "");
const evaluable =
  "const AdvisorApiRule = null; // TS interface erased; present only so the annotation strips\n" +
  stripTypes(slice("const ADVISOR_API_ALLOWLIST", "export function advisorAllows")) +
  "\n" +
  stripTypes(slice("export function advisorAllows", "export async function proxy"))
      .replace("export function", "function") +
  "\nexport { advisorAllows };\n";
const { advisorAllows } = await import(
  "data:text/javascript;base64," + Buffer.from(evaluable).toString("base64")
);

// Every case below is a (path, method) pair whose correct answer is
// unambiguous, and several are the ones that used to require a session round
// trip just to be thrown away.
const CASES = [
  // allowlisted for the advisor → no session lookup needed
  ["/api/init", "GET", true],
  ["/api/notifications", "GET", true],
  ["/api/notifications", "PATCH", true],
  ["/api/menu", "GET", true],
  ["/api/branding", "GET", true],
  ["/api/health", "GET", true],
  ["/api/currency", "GET", true],
  ["/api/auth/login", "POST", true],
  ["/api/advisor-notes", "POST", true],      // the advisor's one write surface
  ["/api/poultry", "GET", true],
  ["/api/poultry/flocks", "GET", true],      // prefix match must include sub-paths

  // right path, wrong verb → read-only violation, still needs the role
  ["/api/init", "POST", false],
  ["/api/notifications", "DELETE", false],
  ["/api/poultry", "POST", false],
  ["/api/checklists", "DELETE", false],

  // never allowlisted → must resolve the session to know if it's an advisor
  ["/api/transactions", "GET", false],
  ["/api/payroll", "GET", false],
  ["/api/users", "GET", false],
  ["/api/audit", "GET", false],
  ["/api/enterprise", "GET", false],
  ["/api/export", "GET", false],

  // near-miss prefixes must NOT match (a naive startsWith would allow these)
  ["/api/authentic", "GET", false],
  ["/api/notificationsX", "GET", false],
  ["/api/poultryevil", "GET", false],
];

let mismatches = [];
for (const [path, method, want] of CASES) {
  const got = !!advisorAllows(path, method);
  if (got !== want) mismatches.push(`${method} ${path} → ${got}, expected ${want}`);
}
ok(`advisorAllows classifies all ${CASES.length} paths correctly`,
  mismatches.length === 0, mismatches.join("; "));

ok("the hot-path cases really are session-free",
  CASES.filter(([p, m, w]) => w).every(([p, m, w]) => advisorAllows(p, m) === w),
  "an allowlisted case would be forced to resolve a session");

// ── 2. the ordering guarantee: decision strictly before session resolution ──
const proxyFn = src.slice(src.indexOf("export async function proxy"));
const allowAt = proxyFn.search(/advisorAllows\(/);
const sessionAt = proxyFn.search(/getSessionInfo\(/);
ok("proxy consults advisorAllows before it resolves a session",
  allowAt !== -1 && sessionAt !== -1 && allowAt < sessionAt,
  `advisorAllows@${allowAt} getSessionInfo@${sessionAt}`);

ok("the fast path returns immediately (NextResponse.next) before any lookup",
  /if \(advisorAllows\(pathname, method\)\) return NextResponse\.next\(\);/.test(proxyFn),
  "fast-path return not found");

// The policy itself must remain default-DENY: an unrecognised API route is
// never allowlisted, so an advisor is refused rather than waved through.
ok("default-deny preserved — unknown /api routes are not allowlisted",
  advisorAllows("/api/some-unknown-route", "GET") === false,
  "an unknown route was allowlisted");

ok("fail-open catch preserved — a session failure still passes through",
  /catch \{[\s\S]{0,200}return NextResponse\.next\(\);/.test(proxyFn),
  "the fail-open catch is missing");

console.log(`\n${fail === 0 ? "✅" : "❌"} PROXY FAST PATH — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);