/**
 * Offline Ghana gazetteer — a curated fallback the /api/geocode router uses
 * when the external geocoding upstreams (Nominatim / Photon) are unreachable
 * from the server. Without it, the order page's Places selector silently
 * yields an empty dropdown ("degraded"), which customers experience as a
 * broken address field. Entries cover Greater Accra delivery areas first
 * (where most branches operate) plus every regional capital and the major
 * commercial towns, with town-centre coordinates good to ~1 km — plenty for
 * seeding the delivery pin, which the customer then drags to their doorstep.
 *
 * Matching is case-insensitive substring with prefix ranking; ~8 results max.
 */
export interface GazetteerEntry {
  label: string;
  lat: number;
  lng: number;
  kind: "area" | "town" | "landmark" | "market";
}

export const GHANA_GAZETTEER: GazetteerEntry[] = [
  // ── Greater Accra — delivery areas & neighbourhoods ──────────────────
  { label: "Osu, Accra", lat: 5.556, lng: -0.183, kind: "town" },
  { label: "Oxford Street, Osu, Accra", lat: 5.5517, lng: -0.1799, kind: "landmark" },
  { label: "Labadi, Accra", lat: 5.5607, lng: -0.1492, kind: "town" },
  { label: "La (Labone), Accra", lat: 5.5690, lng: -0.1463, kind: "town" },
  { label: "Cantonments, Accra", lat: 5.5856, lng: -0.1681, kind: "area" },
  { label: "Airport Residential Area, Accra", lat: 5.5903, lng: -0.1719, kind: "area" },
  { label: "Accra Mall, Tetteh Quarshie", lat: 5.6117, lng: -0.1716, kind: "landmark" },
  { label: "East Legon, Accra", lat: 5.6303, lng: -0.1617, kind: "area" },
  { label: "West Legon, Accra", lat: 5.6489, lng: -0.1931, kind: "area" },
  { label: "Dansoman, Accra", lat: 5.5458, lng: -0.2631, kind: "area" },
  { label: "Kaneshie, Accra", lat: 5.5631, lng: -0.2360, kind: "town" },
  { label: "Kaneshie Market, Accra", lat: 5.5675, lng: -0.2362, kind: "market" },
  { label: "Achimota, Accra", lat: 5.6106, lng: -0.2257, kind: "area" },
  { label: "Achimota Shopping Mall, Accra", lat: 5.6162, lng: -0.2289, kind: "landmark" },
  { label: "Madina, Accra", lat: 5.6742, lng: -0.1672, kind: "area" },
  { label: "Madina Zongo Junction, Accra", lat: 5.6712, lng: -0.1706, kind: "landmark" },
  { label: "Adenta, Accra", lat: 5.7013, lng: -0.1667, kind: "area" },
  { label: "Spintex Road, Accra", lat: 5.6170, lng: -0.0683, kind: "area" },
  { label: "Tema Community 1", lat: 5.6665, lng: -0.0165, kind: "area" },
  { label: "Tema Harbour, Tema", lat: 5.6389, lng: -0.0098, kind: "landmark" },
  { label: "Ashaiman, Tema", lat: 5.6959, lng: -0.0303, kind: "town" },
  { label: "Nungua, Accra", lat: 5.5888, lng: -0.0762, kind: "area" },
  { label: "Sakumono, Tema", lat: 5.6119, lng: -0.0478, kind: "area" },
  { label: "Darkuman, Accra", lat: 5.5834, lng: -0.2540, kind: "area" },
  { label: "Kwame Nkrumah Circle, Accra", lat: 5.5733, lng: -0.2050, kind: "landmark" },
  { label: "Makola Market, Accra", lat: 5.5461, lng: -0.2073, kind: "market" },
  { label: "Agbogbloshie Market, Accra", lat: 5.5438, lng: -0.2207, kind: "market" },
  { label: "Ridge, Accra", lat: 5.5661, lng: -0.1992, kind: "area" },
  { label: "Nima, Accra", lat: 5.5831, lng: -0.1993, kind: "area" },
  { label: "New Town, Accra", lat: 5.5896, lng: -0.2130, kind: "area" },
  { label: "Abossey Okai, Accra", lat: 5.5610, lng: -0.2236, kind: "area" },
  { label: "Teshie, Accra", lat: 5.5800, lng: -0.1121, kind: "town" },
  { label: "Banana Inn, New Achimota", lat: 5.6160, lng: -0.2390, kind: "area" },
  { label: "Nungua Barrier, Accra", lat: 5.6010, lng: -0.0665, kind: "landmark" },
  { label: "Lapaz, Accra", lat: 5.6129, lng: -0.2458, kind: "area" },
  { label: "Nyaho Clinic Area, Airport City, Accra", lat: 5.5985, lng: -0.1710, kind: "area" },
  { label: "37 Military Hospital Area, Accra", lat: 5.5900, lng: -0.1812, kind: "area" },
  { label: "Tetteh Quarshie Interchange, Accra", lat: 5.6034, lng: -0.1751, kind: "landmark" },
  { label: "Kasoa Old Market, Kasoa", lat: 5.5330, lng: -0.4699, kind: "market" },
  { label: "Weija, Accra", lat: 5.5669, lng: -0.3388, kind: "town" },
  { label: "Dome, Accra", lat: 5.6452, lng: -0.2302, kind: "area" },
  { label: "Pokuase, Accra", lat: 5.6696, lng: -0.2839, kind: "town" },
  { label: "Amasaman, Ga West", lat: 5.7069, lng: -0.3103, kind: "town" },
  { label: "Oyarifa, Accra", lat: 5.7030, lng: -0.1342, kind: "town" },
  { label: "Haatso, Accra", lat: 5.6580, lng: -0.1875, kind: "area" },
  { label: "Kwabenya, Accra", lat: 5.6803, lng: -0.2026, kind: "town" },
  { label: "Kisseman, Accra", lat: 5.6280, lng: -0.1833, kind: "area" },
  { label: "Dzorwulu, Accra", lat: 5.6010, lng: -0.2000, kind: "area" },
  { label: "Adabraka, Accra", lat: 5.5605, lng: -0.2150, kind: "area" },
  { label: "Osu Ringway, Accra", lat: 5.5632, lng: -0.1917, kind: "area" },
  { label: "Tudu, Accra", lat: 5.5479, lng: -0.2114, kind: "area" },
  { label: "Mataheko, Accra", lat: 5.5760, lng: -0.1775, kind: "area" },
  { label: "Sowutuom, Accra", lat: 5.6081, lng: -0.2660, kind: "town" },
  { label: "Ogbojo, Accra", lat: 5.6610, lng: -0.1488, kind: "area" },
  { label: "Trasacco Valley, East Legon Hills, Accra", lat: 5.6427, lng: -0.1327, kind: "area" },
  { label: "Comet Estates, Ga East", lat: 5.7200, lng: -0.1820, kind: "area" },
  // ── Regional capitals & major towns ────────────────────────────────────
  { label: "Kumasi, Ashanti Region", lat: 6.6885, lng: -1.6244, kind: "town" },
  { label: "Kejetia Market, Kumasi", lat: 6.6887, lng: -1.6253, kind: "market" },
  { label: "Techiman, Bono East", lat: 7.5864, lng: -1.9381, kind: "town" },
  { label: "Sunyani, Bono Region", lat: 7.3399, lng: -2.3268, kind: "town" },
  { label: "Cape Coast, Central Region", lat: 5.1053, lng: -1.2466, kind: "town" },
  { label: "Elmina, Central Region", lat: 5.0845, lng: -1.3472, kind: "town" },
  { label: "Takoradi, Western Region", lat: 4.8844, lng: -1.7553, kind: "town" },
  { label: "Sekondi, Western Region", lat: 4.9340, lng: -1.7080, kind: "town" },
  { label: "Tarkwa, Western Region", lat: 5.3011, lng: -1.9933, kind: "town" },
  { label: "Koforidua, Eastern Region", lat: 6.0940, lng: -0.2591, kind: "town" },
  { label: "Nkawkaw, Eastern Region", lat: 6.5520, lng: -0.7630, kind: "town" },
  { label: "Ho, Volta Region", lat: 6.6101, lng: 0.4785, kind: "town" },
  { label: "Hohoe, Volta Region", lat: 7.1521, lng: 0.4741, kind: "town" },
  { label: "Aflao, Volta Region", lat: 6.1198, lng: 1.1876, kind: "town" },
  { label: "Tamale, Northern Region", lat: 9.4008, lng: -0.8393, kind: "town" },
  { label: "Yendi, Northern Region", lat: 9.4420, lng: -0.0095, kind: "town" },
  { label: "Bolgatanga, Upper East", lat: 10.7855, lng: -0.8514, kind: "town" },
  { label: "Wa, Upper West", lat: 10.0601, lng: -2.5099, kind: "town" },
  { label: "Damongo, Savannah Region", lat: 9.0830, lng: -1.8181, kind: "town" },
  { label: "Bole, Savannah Region", lat: 9.0350, lng: -2.4830, kind: "town" },
  { label: "Nalerigu, North East Region", lat: 10.5333, lng: -0.3666, kind: "town" },
  { label: "Walewale, North East Region", lat: 10.3528, lng: -0.8008, kind: "town" },
  { label: "Buipe, Savannah Region", lat: 8.7930, lng: -1.4650, kind: "town" },
  { label: "Berekum, Bono Region", lat: 7.4634, lng: -2.5872, kind: "town" },
  { label: "Dormaa Ahenkro, Bono Region", lat: 7.2767, lng: -2.8742, kind: "town" },
  { label: "Kenyaasi, Ahafo Region", lat: 6.9568, lng: -2.3834, kind: "town" },
  { label: "Goaso, Ahafo Region", lat: 6.8049, lng: -2.5171, kind: "town" },
  { label: "Sampa, Bono Region", lat: 8.0264, lng: -3.2011, kind: "town" },
  { label: "Obuasi, Ashanti Region", lat: 6.1937, lng: -1.6612, kind: "town" },
  { label: "Konongo, Ashanti Region", lat: 6.6138, lng: -1.2187, kind: "town" },
  { label: "Ejisu, Ashanti Region", lat: 6.7259, lng: -1.4652, kind: "town" },
  { label: "Mankessim, Central Region", lat: 5.2669, lng: -0.7719, kind: "town" },
  { label: "Saltpond, Central Region", lat: 5.2017, lng: -1.0641, kind: "town" },
  { label: "Winneba, Central Region", lat: 5.3423, lng: -0.6258, kind: "town" },
  { label: "Swedru, Central Region", lat: 5.5361, lng: -0.7093, kind: "town" },
  { label: "Axim, Western Region", lat: 4.8666, lng: -2.2394, kind: "town" },
  { label: "Half Assini, Western Region", lat: 5.0458, lng: -2.8858, kind: "town" },
  { label: "Prestea, Western Region", lat: 5.4516, lng: -2.1385, kind: "town" },
  { label: "Nsawam, Eastern Region", lat: 5.8070, lng: -0.3550, kind: "town" },
  { label: "Aburi, Eastern Region", lat: 5.8511, lng: -0.1753, kind: "town" },
  { label: "Akosombo, Eastern Region", lat: 6.3010, lng: 0.0600, kind: "town" },
  { label: "Somanya, Eastern Region", lat: 6.0890, lng: -0.0230, kind: "town" },
  { label: "Keta, Volta Region", lat: 5.8958, lng: 0.9879, kind: "town" },
  { label: "Dzodze, Volta Region", lat: 6.2420, lng: 1.0340, kind: "town" },
  ];

/** Rank and return up to `limit` gazetteer matches for a free-text query. */
export function gazetteerSearch(q: string, limit = 8): GazetteerEntry[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const scored: { e: GazetteerEntry; score: number }[] = [];
  const words = needle.split(/[\s,]+/).filter((w) => w.length >= 2);
  for (const e of GHANA_GAZETTEER) {
    const label = e.label.toLowerCase();
    // Partial-hit tolerance: a customer may squash words ("osoxford"), typo,
    // or omit filler words. Require at least 60% of query words to appear
    // (never zero), and always require the full needle or a majority.
    const hits = words.filter((w) => label.includes(w)).length;
    if (hits === 0 || hits < Math.ceil(words.length * 0.6)) {
      if (!label.includes(needle)) continue;
    }
    let score = hits * 100;
    if (label.startsWith(needle)) score += 120;
    if (label.includes(needle)) score += 60;
    if (label.includes(` ${words[0]},`) || label.includes(`${words[0]},`)) score += 30;
    score += Math.max(0, 30 - e.label.length);
    if (e.kind === "landmark" || e.kind === "market") score += 8;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}
