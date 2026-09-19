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
  /** Granularity class shared with the live upstreams (Nominatim/Photon):
   *  HOUSE (building/address), STREET (road/way), POI (business/
   *  establishment/mall/hospital), LANDMARK, NEIGHBOURHOOD, CITY, AREA. */
  type?: "HOUSE" | "STREET" | "POI" | "LANDMARK" | "NEIGHBOURHOOD" | "CITY" | "AREA";
}

/** Legacy entries only carry `kind`; map it to the granularity class. */
export function gazetteerType(e: GazetteerEntry): NonNullable<GazetteerEntry["type"]> {
  if (e.type) return e.type;
  switch (e.kind) {
    case "town": return "CITY";
    case "market": return "POI";
    case "landmark": return "LANDMARK";
    default: return "NEIGHBOURHOOD";
  }
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
  // ── Streets (major delivery roads) ─────────────────────────────────────
  { label: "Liberation Road, Airport, Accra", lat: 5.5908, lng: -0.1715, kind: "area", type: "STREET" },
  { label: "Ring Road Central, Accra", lat: 5.5602, lng: -0.1979, kind: "area", type: "STREET" },
  { label: "Independence Avenue, Ridge, Accra", lat: 5.5639, lng: -0.2050, kind: "area", type: "STREET" },
  { label: "Aviation Road, Airport, Accra", lat: 5.5988, lng: -0.1763, kind: "area", type: "STREET" },
  { label: "Dzordzor Street, Osu, Accra", lat: 5.5556, lng: -0.1772, kind: "area", type: "STREET" },
  { label: "28th February Road, Central Accra", lat: 5.5530, lng: -0.2031, kind: "area", type: "STREET" },
  { label: "Barnes Road, Tudu, Accra", lat: 5.5490, lng: -0.2100, kind: "area", type: "STREET" },
  { label: "Graphic Road, Korle Gonno, Accra", lat: 5.5368, lng: -0.2198, kind: "area", type: "STREET" },
  { label: "Achimota Road (N1), Accra", lat: 5.6110, lng: -0.2230, kind: "area", type: "STREET" },
  { label: "George Walker Bush Highway (N6), Accra", lat: 5.6175, lng: -0.2830, kind: "area", type: "STREET" },
  { label: "Ridge Road, Ridge, Accra", lat: 5.5675, lng: -0.1964, kind: "area", type: "STREET" },
  { label: "Castle Road, Christiansborg, Accra", lat: 5.5448, lng: -0.1825, kind: "area", type: "STREET" },
  { label: "Temple Road, Kaneshie, Accra", lat: 5.5710, lng: -0.2360, kind: "area", type: "STREET" },
  { label: "Farrar Avenue, Adabraka, Accra", lat: 5.5615, lng: -0.2155, kind: "area", type: "STREET" },
  { label: "Nkrumah Avenue, Adum, Kumasi", lat: 6.6925, lng: -1.6245, kind: "area", type: "STREET" },
  { label: "Harbour Road, Takoradi Port", lat: 4.8918, lng: -1.7435, kind: "area", type: "STREET" },
  // ── Businesses / establishments (POI) ────────────────────────────────
  { label: "Accra Mall, Tetteh Quarshie, Accra", lat: 5.6117, lng: -0.1716, kind: "landmark", type: "POI" },
  { label: "Achimota Retail Centre, Achimota, Accra", lat: 5.6172, lng: -0.2335, kind: "market", type: "POI" },
  { label: "West Hills Mall, Dukonah, Weija", lat: 5.5306, lng: -0.3644, kind: "market", type: "POI" },
  { label: "Junction Mall, Nungua, Accra", lat: 5.6011, lng: -0.0728, kind: "market", type: "POI" },
  { label: "Marina Mall, Tema South", lat: 5.6350, lng: 0.0048, kind: "market", type: "POI" },
  { label: "Kumasi City Mall, Asokwa, Kumasi", lat: 6.6636, lng: -1.6002, kind: "market", type: "POI" },
  { label: "Accra Brewery Ltd, Castle Road, Accra", lat: 5.5452, lng: -0.1852, kind: "area", type: "POI" },
  { label: "Voltic House, Airport, Accra", lat: 5.5945, lng: -0.1768, kind: "area", type: "POI" },
  { label: "Zenith Bank Head Office, Accra", lat: 5.5959, lng: -0.1710, kind: "area", type: "POI" },
  { label: "Papaye Fast Food, Osu, Accra", lat: 5.5625, lng: -0.1825, kind: "area", type: "POI" },
  // ── Hospitals / clinics (POI) ────────────────────────────────────────
  { label: "Korle Bu Teaching Hospital, Accra", lat: 5.5382, lng: -0.2288, kind: "landmark", type: "POI" },
  { label: "37 Military Hospital, Accra", lat: 5.5902, lng: -0.1822, kind: "landmark", type: "POI" },
  { label: "Greater Accra Regional (Ridge) Hospital", lat: 5.5730, lng: -0.1938, kind: "landmark", type: "POI" },
  { label: "Komfo Anokye Teaching Hospital, Kumasi", lat: 6.6950, lng: -1.6110, kind: "landmark", type: "POI" },
  { label: "Tamale Teaching Hospital, Tamale", lat: 9.4122, lng: -0.8432, kind: "landmark", type: "POI" },
  { label: "Cape Coast Teaching Hospital", lat: 5.1170, lng: -1.2490, kind: "landmark", type: "POI" },
  { label: "Koforidua Regional Hospital", lat: 6.0932, lng: -0.2555, kind: "landmark", type: "POI" },
  { label: "Ho Teaching Hospital, Ho", lat: 6.6120, lng: 0.4712, kind: "landmark", type: "POI" },
  // ── Universities / schools (POI) ─────────────────────────────────────
  { label: "University of Ghana (Legon), Main Gate, Accra", lat: 5.6508, lng: -0.1870, kind: "landmark", type: "POI" },
  { label: "Kwame Nkrumah University of Science and Technology (KNUST), Kumasi", lat: 6.6706, lng: -1.5722, kind: "landmark", type: "POI" },
  { label: "University of Cape Coast, Main Gate", lat: 5.1159, lng: -1.2925, kind: "landmark", type: "POI" },
  { label: "University for Development Studies, Tamale Campus", lat: 9.4265, lng: -0.8510, kind: "landmark", type: "POI" },
  { label: "Accra Technical University, Tudu, Accra", lat: 5.5490, lng: -0.2098, kind: "landmark", type: "POI" },
  { label: "Achimota School, Accra", lat: 5.6128, lng: -0.2344, kind: "landmark", type: "POI" },
  // ── Landmarks ─────────────────────────────────────────────────────────
  { label: "Black Star Gate (Independence Arch), Accra", lat: 5.5488, lng: -0.1824, kind: "landmark", type: "LANDMARK" },
  { label: "Independence Square, Accra", lat: 5.5494, lng: -0.1827, kind: "landmark", type: "LANDMARK" },
  { label: "Kwame Nkrumah Memorial Park, Accra", lat: 5.5500, lng: -0.1990, kind: "landmark", type: "LANDMARK" },
  { label: "Christiansborg Castle (Osu Castle), Accra", lat: 5.5466, lng: -0.1825, kind: "landmark", type: "LANDMARK" },
  { label: "Accra International Conference Centre", lat: 5.5485, lng: -0.2009, kind: "landmark", type: "LANDMARK" },
  { label: "National Theatre of Ghana, Accra", lat: 5.5518, lng: -0.1985, kind: "landmark", type: "LANDMARK" },
  { label: "Cape Coast Castle, Cape Coast", lat: 5.1061, lng: -1.2450, kind: "landmark", type: "LANDMARK" },
  { label: "Elmina Castle (St. George's Castle), Elmina", lat: 5.0845, lng: -1.3472, kind: "landmark", type: "LANDMARK" },
  { label: "Aburi Botanical Gardens, Aburi", lat: 5.8440, lng: -0.1802, kind: "landmark", type: "LANDMARK" },
  { label: "Kintampo Falls, Bono East", lat: 8.0858, lng: -1.6964, kind: "landmark", type: "LANDMARK" },
  { label: "Mole National Park Main Entrance, Damongo", lat: 9.2470, lng: -1.8450, kind: "landmark", type: "LANDMARK" },
  { label: "Lake Bosomtwe, Ashanti Region", lat: 6.5043, lng: -1.3973, kind: "landmark", type: "LANDMARK" },
  { label: "Kakum National Park, Central Region", lat: 5.3522, lng: -1.3870, kind: "landmark", type: "LANDMARK" },
  { label: "Fort Prinzenstein, Keta", lat: 5.8950, lng: 0.9860, kind: "landmark", type: "LANDMARK" },
  { label: "Larabanga Mosque, Savannah Region", lat: 9.2220, lng: -1.8800, kind: "landmark", type: "LANDMARK" },
  // ── Neighborhoods / suburbs ───────────────────────────────────────────
  { label: "Osu Christianborg, Accra", lat: 5.5620, lng: -0.1850, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Osu Odumase, Accra", lat: 5.5580, lng: -0.1880, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Ringway Estates, Accra", lat: 5.5642, lng: -0.1929, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Abelenkpe, Accra", lat: 5.6040, lng: -0.2025, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Taifa, Accra", lat: 5.6325, lng: -0.2610, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Asylum Down, Accra", lat: 5.5703, lng: -0.2049, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Old Tafo, Ashanti Region", lat: 6.7040, lng: -1.6185, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Santasi, Kumasi", lat: 6.7033, lng: -1.6444, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Atonsu, Kumasi", lat: 6.6570, lng: -1.5907, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "New Adenta, Accra", lat: 5.7120, lng: -0.1580, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Spintex Community 16, Accra", lat: 5.6020, lng: -0.0720, kind: "area", type: "NEIGHBOURHOOD" },
  { label: "Comet Estates, Legon Hills", lat: 5.7200, lng: -0.1820, kind: "area", type: "NEIGHBOURHOOD" },
  // ── World cities (graceful degradation when upstreams unreachable) ────
  { label: "Lagos Island, Lagos, Nigeria", lat: 6.4541, lng: 3.3947, kind: "town", type: "CITY" },
  { label: "Abuja, Nigeria", lat: 9.0579, lng: 7.4951, kind: "town", type: "CITY" },
  { label: "Abidjan, Côte d'Ivoire", lat: 5.3600, lng: -4.0083, kind: "town", type: "CITY" },
  { label: "Dakar, Senegal", lat: 14.7167, lng: -17.4677, kind: "town", type: "CITY" },
  { label: "London, United Kingdom", lat: 51.5072, lng: -0.1276, kind: "town", type: "CITY" },
  { label: "New York City, United States", lat: 40.7128, lng: -74.0060, kind: "town", type: "CITY" },
  { label: "Dubai, United Arab Emirates", lat: 25.2048, lng: 55.2708, kind: "town", type: "CITY" },
  { label: "Toronto, Canada", lat: 43.6532, lng: -79.3832, kind: "town", type: "CITY" },
  // ── World landmarks (best-effort degraded-mode coverage) ────────────────
  { label: "Eiffel Tower, Paris, France", lat: 48.8584, lng: 2.2945, kind: "landmark", type: "LANDMARK" },
  { label: "Statue of Liberty, New York City, United States", lat: 40.6892, lng: -74.0445, kind: "landmark", type: "LANDMARK" },
  { label: "Big Ben, London, United Kingdom", lat: 51.5007, lng: -0.1246, kind: "landmark", type: "LANDMARK" },
  { label: "Burj Khalifa, Dubai, United Arab Emirates", lat: 25.1972, lng: 55.2744, kind: "landmark", type: "LANDMARK" },
  { label: "Sydney Opera House, Sydney, Australia", lat: -33.8568, lng: 151.2153, kind: "landmark", type: "LANDMARK" },
  { label: "CN Tower, Toronto, Canada", lat: 43.6426, lng: -79.3871, kind: "landmark", type: "LANDMARK" },
  { label: "Nairobi, Kenya", lat: -1.2921, lng: 36.8219, kind: "town", type: "CITY" },
  { label: "Johannesburg, South Africa", lat: -26.2041, lng: 28.0473, kind: "town", type: "CITY" },
  { label: "Kigali, Rwanda", lat: -1.9403, lng: 29.8739, kind: "town", type: "CITY" },
  { label: "Paris, France", lat: 48.8566, lng: 2.3522, kind: "town", type: "CITY" },
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
