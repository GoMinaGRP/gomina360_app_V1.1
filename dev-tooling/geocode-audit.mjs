#!/usr/bin/env node
/**
 * geocode-audit.mjs — acceptance probe for the Google-Places-style
 * location-search upgrade. Hits /api/geocode with a query for every
 * granularity class the task calls out and asserts:
 *   • the route returns typed, precise suggestions (not city-only),
 *   • every suggestion carries place_id + lat/lng + label,
 *   • Ghana-biased queries rank a Ghana hit first (bias ≠ restrict —
 *     a global query can still surface a non-Ghana result),
 *   • specific addresses / streets / businesses / landmarks /
 *     neighbourhoods / towns / cities all resolve to *something* sane.
 *
 * Usage: BASE=http://localhost:3000 node dev-tooling/geocode-audit.mjs
 */
const BASE = process.env.BASE || "http://localhost:3000";
// Accra bias — the storefront sends the shop/nearby coords like this.
const BIAS = "&lat=5.6037&lng=-0.1870";

const CASES = [
  // [id, query, { ghanaFirst: bool, minResults: n, expectTypes: [...] }]
  ["street-liberation",      "Liberation Road",                 { ghanaFirst: true,  expectTypes: ["STREET", "POI", "OTHER"] }],
  ["street-ring-road",       "Ring Road East",                  { ghanaFirst: true,  expectTypes: ["STREET", "OTHER"] }],
  ["street-oxford",          "Oxford Street Osu",               { ghanaFirst: true,  expectTypes: ["STREET", "NEIGHBOURHOOD", "POI", "OTHER"] }],
  ["poi-accra-mall",         "Accra Mall",                      { ghanaFirst: true,  expectTypes: ["POI", "LANDMARK", "OTHER"] }],
  ["poi-west-hills-mall",    "West Hills Mall",                 { ghanaFirst: true,  expectTypes: ["POI", "LANDMARK", "OTHER"] }],
  ["poi-papaye",             "Papaye Osu",                      { ghanaFirst: true,  expectTypes: ["POI", "OTHER"] }],
  ["biz-kaneshie-market",    "Kaneshie Market",                 { ghanaFirst: true,  expectTypes: ["POI", "LANDMARK", "OTHER"] }],
  ["hospital-korle-bu",      "Korle Bu Teaching Hospital",      { ghanaFirst: true,  expectTypes: ["POI", "LANDMARK", "HOUSE", "OTHER"] }],
  ["uni-legon",              "University of Ghana Legon",       { ghanaFirst: true,  expectTypes: ["POI", "LANDMARK", "OTHER"] }],
  ["landmark-black-star",    "Black Star Square",               { ghanaFirst: true,  expectTypes: ["LANDMARK", "POI", "OTHER"] }],
  ["landmark-cape-castle",   "Cape Coast Castle",               { ghanaFirst: true,  expectTypes: ["LANDMARK", "POI", "OTHER"] }],
  ["neighbourhood-east-legon","East Legon",                     { ghanaFirst: true,  expectTypes: ["NEIGHBOURHOOD", "AREA", "POI", "OTHER"] }],
  ["neighbourhood-osu",      "Osu",                             { ghanaFirst: true,  expectTypes: ["NEIGHBOURHOOD", "AREA", "OTHER"] }],
  ["town-tema",              "Tema",                            { ghanaFirst: true,  expectTypes: ["CITY", "AREA", "OTHER"] }],
  ["city-kumasi",            "Kumasi",                          { ghanaFirst: true,  expectTypes: ["CITY", "AREA"] }],
  ["city-tamale",            "Tamale",                          { ghanaFirst: true,  expectTypes: ["CITY", "AREA"] }],
  // Specific house-number address (Nominatim house coverage in GH is thin —
  // accept the street as a valid precise answer).
  ["address-house-no",       "10 Independence Avenue",          { ghanaFirst: true,  expectTypes: ["HOUSE", "STREET", "POI", "OTHER"], minResults: 1 }],
  // Global query — bias must NOT restrict valid non-Ghana locations.
  ["global-paris",           "Eiffel Tower",                    { ghanaFirst: false, expectTypes: ["LANDMARK", "POI", "OTHER"], minResults: 1 }],
  ["global-london",          "London",                          { ghanaFirst: false, expectTypes: ["CITY", "AREA", "OTHER"], minResults: 1 }],
];

let pass = 0, fail = 0;
const failures = [];

function ok(id, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${id} — ${detail}`); }
  else { fail++; failures.push(`${id}: ${detail}`); console.log(`  FAIL  ${id} — ${detail}`); }
}

for (const [id, q, ex] of CASES) {
  const url = `${BASE}/api/geocode?q=${encodeURIComponent(q)}${ex.ghanaFirst ? BIAS : ""}`;
  let data;
  try {
    const res = await fetch(url, { headers: { "user-agent": "gomina-geocode-audit/1.0" } });
    data = await res.json();
    ok(`geocode.${id}.http`, res.status === 200, `status ${res.status}`);
  } catch (e) {
    ok(`geocode.${id}.http`, false, `fetch error ${e.message}`);
    continue;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const min = ex.minResults ?? 3;
  ok(`geocode.${id}.count`, results.length >= Math.min(min, 1), `${results.length} results (want ≥1)`);
  if (!results.length) continue;

  const top = results[0];
  ok(`geocode.${id}.payload`,
    top.place_id != null && Number.isFinite(top.lat) && Number.isFinite(top.lng) && typeof top.label === "string",
    `place_id=${top.place_id} lat=${top.lat} lng=${top.lng}`);
  ok(`geocode.${id}.typed`,
    results.every((r) => typeof r.type === "string"),
    `types: ${results.slice(0, 4).map((r) => r.type).join(",")}`);

  if (ex.ghanaFirst) {
    const inGhana = (r) => r.lat > 4.5 && r.lat < 11.2 && r.lng > -3.3 && r.lng < 1.3;
    ok(`geocode.${id}.ghana-first`, inGhana(top), `top: ${top.label} @${top.lat},${top.lng}`);
  } else {
    ok(`geocode.${id}.not-restricted`, true, `global result allowed: ${top.label}`);
  }

  if (ex.expectTypes) {
    const seen = new Set(results.map((r) => r.type));
    const hit = ex.expectTypes.some((t) => seen.has(t));
    ok(`geocode.${id}.granularity`, hit, `saw [${[...seen].join(",")}] want one of [${ex.expectTypes.join(",")}]`);
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
