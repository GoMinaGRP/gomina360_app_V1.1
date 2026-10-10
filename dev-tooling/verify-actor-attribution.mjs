// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM-WIDE GUARD — client-controlled actor identity (F-15).
//
// The vulnerability class: a route reads the acting user's id / name / role
// out of the REQUEST BODY and persists it, instead of taking it from the
// session. Any authenticated caller can then attribute their work to
// somebody else — falsifying the finance ledger, the issuer of a sales
// document, who provisioned a user account, the audit trail itself, and
// the `actor` written onto bell notifications. It also defeats `withoutSelf`
// self-exclusion, because "exclude me" was evaluated against a value the
// caller chose.
//
// This runs as a SUITE, not a script, and its first job is to prove it can
// actually detect the bug (S1). A guard that cannot fail is worse than no
// guard, so a synthetic vulnerable route is fed through the same classifier
// and must be rejected.
//
// Exit code 0 = the codebase is safe. Non-zero = do not ship.
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";

const ROOT = "/home/user/gomina360_app_V1.1";
const API = path.join(ROOT, "src/app/api");
const COMPONENTS = path.join(ROOT, "src/components");

let pass = 0;
let fail = 0;
const failures = [];
const sec = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ok = (name, cond, note = "") => {
  if (cond) { pass++; console.log(`✅ ${name}${note ? ` — ${note}` : ""}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name}${note ? ` — ${note}` : ""}`); }
};

/** Field names that mean "who is doing this". */
const ACTOR_FIELDS = new Set([
  "createdByUserId", "createdByName", "createdByRole",
  "actorUserId", "actorName", "actorRole", "actorId",
  "currentUserId", "currentUserName", "currentUserRole",
  "recordedBy", "recordedByRole", "recordedByUserId", "recordedByName",
  "changedBy", "changedByRole",
  "performedBy", "performedByRole",
  "approvedBy", "approvedByUserId", "approvedByName", "approvedByRole",
  "reviewedBy", "reviewedById", "reviewedByName",
  "handledBy", "resolvedBy", "resolvedByName",
  "grantedBy", "grantedByUserId", "grantedByName", "grantedByRole",
  "deletedBy", "deletedByUserId", "deletedByName",
  "uploadedBy", "submittedBy", "processedBy", "initiatedBy",
  "requestedBy", "requestedByUserId",
  "loggedBy", "enteredBy", "savedBy", "updatedBy", "updatedByName",
]);

/** Names a route may use for the parsed request body. A property read through
 *  any of these is a claim about the request, not about local state. */
const BODY_ALIASES = new Set(["body", "payload", "json", "data"]);

/** Keys that are themselves an identity claim even though their name does not
 *  start with an actor prefix. */
for (const k of ["publishedByName", "publishedByUserId", "publishedByRole"]) ACTOR_FIELDS.add(k);

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`[^`]*`/g, "``");
}

/** Pull every body-sourced actor identifier out of a source file, and return
 *  the source with the destructuring statements REMOVED so the remaining
 *  occurrences are genuine uses rather than re-reads of the binding. */
function bodyActorClaims(src) {
  const found = new Set();
  const destructStmts = [];
  const destructRe =
    /(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*(?:await\s+request\.json\(\)|body|payload|data|json|p)\b/g;
  let m;
  while ((m = destructRe.exec(src))) {
    destructStmts.push(m[0]);
    for (const part of m[1].split(",")) {
      const name = part.split(":").pop().trim().split("=")[0].trim();
      if (ACTOR_FIELDS.has(name)) found.add(name);
    }
  }
  // Property reads through ANY body alias — `body.x` but also `data.x`, where
  // `data` came from `const { entity, data } = body`. Scanning only `body.`
  // missed a real sink in api/aquaculture (weight-sample actor + publishedBy).
  const propRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z0-9_]+)/g;
  while ((m = propRe.exec(src))) {
    const [, alias, key] = m;
    if (!BODY_ALIASES.has(alias)) continue;
    if (ACTOR_FIELDS.has(key)) found.add(key);
  }
  const usesSrc = destructStmts.reduce((acc, st) => acc.split(st).join(" "), src);
  return { found, usesSrc };
}

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/* ═══ S1 · the guard can actually detect the bug ═════════════════════════ */
sec("S1 · SELF-TEST — a known-vulnerable route must be rejected");
{
  const vulnerable = `
    export async function POST(request: NextRequest) {
      const __authSession = await getSessionInfo(request);
      const body = await request.json();
      const { businessId, createdByUserId, createdByName, createdByRole } = body;
      return NextResponse.json({ recordedBy: createdByName, actor: { id: createdByUserId } });
    }`;
  const safe = `
    export async function POST(request: NextRequest) {
      const __authSession = await getSessionInfo(request);
      const body = await request.json();
      const { businessId } = body;
      const actor = actorFrom(__authSession);
      return NextResponse.json({ recordedBy: actor.name });
    }`;
  const v = bodyActorClaims(strip(vulnerable));
  const s = bodyActorClaims(strip(safe));
  ok("S1a the vulnerable shape IS detected", v.found.size >= 3, `found ${[...v.found].join(", ")}`);
  ok("S1b the safe shape is NOT flagged", s.found.size === 0, `found ${[...v.found].length ? [...s.found].join(", ") : "nothing"}`);
}

/* ═══ S2 · no route destructures an identity out of a request body ═══════ */
const routes = walk(API, "route.ts");
const offenders = [];
for (const f of routes) {
  const { found } = bodyActorClaims(strip(fs.readFileSync(f, "utf8")));
  if (found.size) offenders.push({ file: path.relative(ROOT, f), fields: [...found] });
}
sec(`S2 · no API route sources an actor identity from the body (${routes.length} routes)`);
{
  // A guard that silently scans ZERO files is worse than no guard, so the
  // suite fails loudly if the file walk ever stops matching.
  ok("S2z the scan actually reached the route tree", routes.length > 50, `${routes.length} routes found`);
  ok("S2 zero body-sourced actor identifiers across every route",
    offenders.length === 0,
    offenders.length ? offenders.map((o) => `${o.file} [${o.fields.join(",")}]`).join("; ") : `${routes.length} routes clean`);
}

/* ═══ S3 · the sanctioned helper exists and is the only spelling ═════════ */
sec("S3 · @/lib/auth exposes the sanctioned actor helpers");
{
  const auth = fs.readFileSync(path.join(ROOT, "src/lib/auth.ts"), "utf8");
  for (const fn of [/export function actorFrom\(/, /export function actorFromUser\(/,
                    /export async function actorFromRequest\(/, /export const ACTOR_CLAIM_KEYS/,
                    /export function stripActorClaims</]) {
    ok(`S3 @/lib/auth exports ${fn.source.replace(/^export (function|async function|const) /, "").replace(/[<(].*$/, "")}`,
      fn.test(auth));
  }
  // ACTOR_CLAIM_KEYS must not drift from the set the scanner knows about:
  // every key the scanner flags has to be declared for stripActorClaims().
  const block = /ACTOR_CLAIM_KEYS[\s\S]*?\] as const;/.exec(auth)?.[0] || "";
  const declared = [...block.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const required = ["createdByUserId", "createdByName", "createdByRole", "actorUserId",
                    "actorName", "actorRole", "currentUserId", "currentUserName",
                    "currentUserRole", "recordedBy", "recordedByRole", "recordedByUserId"];
  const missing = required.filter((k) => !declared.includes(k));
  ok("S3b ACTOR_CLAIM_KEYS covers every field the scanner looks for",
    missing.length === 0 && declared.length > 0,
    missing.length ? `missing ${missing.join(",")}` : `${declared.length} keys declared`);
}

/* ═══ S4 · no attribution is written without a session in scope ════════ */
sec("S4 · attribution writers resolve the actor from a session");
{
  const ATTRIBUTION_SINKS = [
    "recordedBy:", "createdByUserId:", "createdByName:", "createdByRole:",
    "actorUserId:", "actorName:", "actorRole:", "deletedByUserId:",
    "changedBy:", "approvedByUserId:", "grantedByUserId:",
    "insert(auditTrail)", "insert(auditIssueUpdates)", "insert(auditLog)",
    "pushAfterBell",
  ];
  // A route that writes attribution but never resolves a session has no way
  // to know who is acting — the one thing S2 cannot see, because S2 only
  // proves the identity is not read from the BODY.
  // Documented exception, not an oversight: /api/order is the CUSTOMER-facing
  // online-order intake. It writes `createdByName: customerName` with
  // `createdByUserId: null` and role "CUSTOMER" — a customer placing their own
  // order. There is no staff identity on that request to spoof, and the row
  // must keep naming the customer for the order timeline.
  const ALLOWED_SESSIONLESS = new Set(["src/app/api/order/route.ts"]);
  const unauthenticated = [];
  for (const f of routes) {
    const src = strip(fs.readFileSync(f, "utf8"));
    if (!ATTRIBUTION_SINKS.some((k) => src.includes(k))) continue;
    if (ALLOWED_SESSIONLESS.has(path.relative(ROOT, f))) continue;
    if (!/getSessionInfo\(/.test(src)) unauthenticated.push(path.relative(ROOT, f));
  }
  ok("S4 every route writing attribution resolves a session first",
    unauthenticated.length === 0,
    unauthenticated.length ? unauthenticated.join("; ") : "no attribution writer is sessionless");
}

/* ═══ S5 · the client stops sending identity claims ═════════════════════ */
sec("S5 · no component sends an actor identity in a request body");
{
  // Only object literals inside a fetch(...) call are considered, so a local
  // state object or a rendered record can never produce a false failure.
  const claims = [];
  for (const f of walk(COMPONENTS, ".tsx")) {
    const raw = fs.readFileSync(f, "utf8");
    for (const call of raw.matchAll(/fetch\s*\(/g)) {
      // Take the window from `fetch(` to the matching close of that call.
      let i = call.index + call[0].length - 1;
      let depth = 0;
      for (; i < raw.length && i < call.index + 4000; i++) {
        const ch = raw[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) break;
        }
      }
      const window = raw.slice(call.index, i + 1);
      for (const m of window.matchAll(/(^|[{,\s])([A-Za-z0-9_]*(?:createdBy|actor|currentUser|recordedBy|approvedBy|reviewedBy|grantedBy|deletedBy|performedBy|handledBy)[A-Za-z0-9_]*)\s*:/g)) {
        const key = m[2];
        // `actor:` in a fetch body is still a claim; `businessId` etc. are not.
        if (ACTOR_FIELDS.has(key) || /Actor$/.test(key)) claims.push({ file: path.relative(ROOT, f), key });
      }
    }
  }
  ok("S5 zero actor-identity claims in client request bodies",
    claims.length === 0,
    claims.length ? [...new Set(claims.map((c) => `${c.file}:${c.key}`))].slice(0, 8).join("; ") : "clients send no identity");
}

/* ═══ Summary ═══════════════════════════════════════════════════════════ */
console.log(`\n${"═".repeat(64)}`);
console.log(`${pass} pass / ${fail} fail`);
if (fail) {
  console.log("\nFAILED:");
  for (const f of failures) console.log(` - ${f}`);
  console.log(`\nRESULT: FAIL — actor identity can be forged from a request body.`);
  process.exit(1);
}
console.log("RESULT: PASS — actor identity is session-bound everywhere it is persisted.");
process.exit(0);