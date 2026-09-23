// Quick API exercise for /api/poultry/benchmarks (dev use).
// Run: node dev-tooling/api-bench-smoke.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: process.env.OWNER_PW || "Owner@GoMina26" }),
});
const cookie = login.headers.get("set-cookie").split(";")[0];
console.log("login:", login.status);
const B = `${BASE}/api/poultry/benchmarks`;

// 1. GET with templates
let r = await fetch(`${B}?businessId=1`, { headers: { cookie } });
let d = await r.json();
console.log("GET profiles:", r.status, "profiles:", d.profiles.length, "templates:", d.templates.map((t) => t.name));

// 2. POST a template-derived profile
const tpl = d.templates[0];
r = await fetch(B, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "PROFILE", data: { businessId: 1, name: "TEST Broiler Std", birdType: "BROILERS", isDefault: true, curves: tpl.curves, createdByName: "test" } }),
});
d = await r.json();
console.log("POST profile:", r.status, d.success, d.item?.id, "curves:", Object.keys(d.item?.curves || {}));
const pid = d.item?.id;

// 3. POST invalid curves (single point → 400)
r = await fetch(B, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "PROFILE", data: { businessId: 1, name: "BAD", birdType: "BROILERS", curves: { BODY_WEIGHT_KG: { by: "ageDays", points: [[7, 1]] } } } }),
});
d = await r.json();
console.log("POST invalid curve (expect 400):", r.status, d.error);

// 4. PATCH rename + tolerance
r = await fetch(B, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "PROFILE", id: pid, data: { name: "TEST Broiler Std v2", toleranceWarnPct: 4 } }),
});
d = await r.json();
console.log("PATCH:", r.status, d.item?.name, d.item?.toleranceWarnPct);

// 5. Flock PATCH pin profile
r = await fetch(`${BASE}/api/poultry`, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "FLOCK", id: 2, data: { benchmarkProfileId: pid } }),
});
d = await r.json();
console.log("Flock PATCH pin profile:", r.status, d.item?.benchmarkProfileId);

// 6. DELETE blocked while in use
r = await fetch(B, {
  method: "DELETE", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "PROFILE", id: pid }),
});
d = await r.json();
console.log("DELETE in-use (expect 409):", r.status, String(d.error).slice(0, 70));

// 7. unpin then delete
r = await fetch(`${BASE}/api/poultry`, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "FLOCK", id: 2, data: { benchmarkProfileId: null } }),
});
console.log("unpin:", r.status);
r = await fetch(B, {
  method: "DELETE", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ entity: "PROFILE", id: pid }),
});
d = await r.json();
console.log("DELETE:", r.status, d.success, d.removed?.name);
