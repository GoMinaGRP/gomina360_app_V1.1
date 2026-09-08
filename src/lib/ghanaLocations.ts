/**
 * GoMina 360 — Standardized Ghana Location System
 *
 * All 16 official regions of Ghana and their Metropolitan, Municipal and
 * District Assemblies (MMDAs). Used across every module (users, branches,
 * customers, suppliers, farms, assets, employees, reports) so that location
 * data is consistent and reportable enterprise-wide.
 *
 * Selection model:  Region (strict dropdown) → District (dropdown + free text) → Town (free text)
 */

export interface GhanaRegion {
  name: string;
  capital: string;
  districts: string[];
}

export const GHANA_REGIONS: GhanaRegion[] = [
  {
    name: "Greater Accra",
    capital: "Accra",
    districts: [
      "Accra Metropolitan",
      "Ablekuma Central Municipal",
      "Ablekuma North Municipal",
      "Ablekuma West Municipal",
      "Ada East",
      "Ada West",
      "Adentan Municipal",
      "Ashaiman Municipal",
      "Ayawaso Central Municipal",
      "Ayawaso East Municipal",
      "Ayawaso North Municipal",
      "Ayawaso West Municipal",
      "Ga Central Municipal",
      "Ga East Municipal",
      "Ga North Municipal",
      "Ga South Municipal",
      "Ga West Municipal",
      "Korle Klottey Municipal",
      "Kpone Katamanso Municipal",
      "Krowor Municipal",
      "La Dade Kotopon Municipal",
      "La Nkwantanang Madina Municipal",
      "Ledzokuku Municipal",
      "Ningo Prampram",
      "Okaikwei North Municipal",
      "Shai Osudoku",
      "Tema Metropolitan",
      "Tema West Municipal",
      "Weija Gbawe Municipal",
    ],
  },
  {
    name: "Ashanti",
    capital: "Kumasi",
    districts: [
      "Adansi Asokwa",
      "Adansi North",
      "Adansi South",
      "Afigya Kwabre North",
      "Afigya Kwabre South",
      "Ahafo Ano North Municipal",
      "Ahafo Ano South East",
      "Ahafo Ano South West",
      "Akrofuom",
      "Amansie Central",
      "Amansie South",
      "Amansie West",
      "Asante Akim Central Municipal",
      "Asante Akim North",
      "Asante Akim South Municipal",
      "Asokore Mampong Municipal",
      "Asokwa Municipal",
      "Atwima Kwanwoma",
      "Atwima Mponua",
      "Atwima Nwabiagya Municipal",
      "Atwima Nwabiagya North",
      "Bekwai Municipal",
      "Bosome Freho",
      "Bosomtwe",
      "Ejisu Municipal",
      "Ejura Sekyedumase Municipal",
      "Juaben Municipal",
      "Kumasi Metropolitan",
      "Kwabre East Municipal",
      "Kwadaso Municipal",
      "Mampong Municipal",
      "Obuasi East",
      "Obuasi Municipal",
      "Offinso Municipal",
      "Offinso North",
      "Oforikrom Municipal",
      "Old Tafo Municipal",
      "Sekyere Afram Plains",
      "Sekyere Central",
      "Sekyere East",
      "Sekyere Kumawu",
      "Sekyere South",
      "Suame Municipal",
    ],
  },
  {
    name: "Western",
    capital: "Sekondi-Takoradi",
    districts: [
      "Ahanta West Municipal",
      "Amenfi Central",
      "Amenfi West Municipal",
      "Effia Kwesimintsim Municipal",
      "Ellembelle",
      "Jomoro Municipal",
      "Mpohor",
      "Nzema East Municipal",
      "Prestea Huni Valley Municipal",
      "Sekondi Takoradi Metropolitan",
      "Shama",
      "Tarkwa Nsuaem Municipal",
      "Wassa Amenfi East Municipal",
      "Wassa East",
    ],
  },
  {
    name: "Western North",
    capital: "Sefwi Wiawso",
    districts: [
      "Aowin Municipal",
      "Bia East",
      "Bia West",
      "Bibiani Anhwiaso Bekwai Municipal",
      "Bodi",
      "Juaboso",
      "Sefwi Akontombra",
      "Sefwi Wiawso Municipal",
      "Suaman",
    ],
  },
  {
    name: "Central",
    capital: "Cape Coast",
    districts: [
      "Abura Asebu Kwamankese",
      "Agona East",
      "Agona West Municipal",
      "Ajumako Enyan Essiam",
      "Asikuma Odoben Brakwa",
      "Assin Central Municipal",
      "Assin North",
      "Assin South",
      "Awutu Senya East Municipal",
      "Awutu Senya West",
      "Cape Coast Metropolitan",
      "Effutu Municipal",
      "Ekumfi",
      "Gomoa Central",
      "Gomoa East",
      "Gomoa West",
      "Komenda Edina Eguafo Abirem Municipal",
      "Mfantsiman Municipal",
      "Twifo Atti Morkwa",
      "Twifo Hemang Lower Denkyira",
      "Upper Denkyira East Municipal",
      "Upper Denkyira West",
    ],
  },
  {
    name: "Eastern",
    capital: "Koforidua",
    districts: [
      "Abuakwa North Municipal",
      "Abuakwa South Municipal",
      "Achiase",
      "Akuapim North Municipal",
      "Akuapim South",
      "Akyemansa",
      "Asene Manso Akroso",
      "Asuogyaman",
      "Atiwa East",
      "Atiwa West",
      "Ayensuano",
      "Birim Central Municipal",
      "Birim North",
      "Birim South",
      "Denkyembour",
      "Fanteakwa North",
      "Fanteakwa South",
      "Kwaebibirem Municipal",
      "Kwahu Afram Plains North",
      "Kwahu Afram Plains South",
      "Kwahu East",
      "Kwahu South",
      "Kwahu West Municipal",
      "Lower Manya Krobo Municipal",
      "New Juaben North Municipal",
      "New Juaben South Municipal",
      "Nsawam Adoagyiri Municipal",
      "Okere",
      "Suhum Municipal",
      "Upper Manya Krobo",
      "Upper West Akim",
      "West Akim Municipal",
      "Yilo Krobo Municipal",
    ],
  },
  {
    name: "Volta",
    capital: "Ho",
    districts: [
      "Adaklu",
      "Afadzato South",
      "Agotime Ziope",
      "Akatsi North",
      "Akatsi South",
      "Anloga",
      "Central Tongu",
      "Ho Municipal",
      "Ho West",
      "Hohoe Municipal",
      "Keta Municipal",
      "Ketu North Municipal",
      "Ketu South Municipal",
      "Kpando Municipal",
      "North Dayi",
      "North Tongu",
      "South Dayi",
      "South Tongu",
    ],
  },
  {
    name: "Oti",
    capital: "Dambai",
    districts: [
      "Biakoye",
      "Guan",
      "Jasikan",
      "Kadjebi",
      "Krachi East Municipal",
      "Krachi Nchumuru",
      "Krachi West",
      "Nkwanta North",
      "Nkwanta South Municipal",
    ],
  },
  {
    name: "Northern",
    capital: "Tamale",
    districts: [
      "Gushegu Municipal",
      "Karaga",
      "Kpandai",
      "Kumbungu",
      "Mion",
      "Nanton",
      "Nanumba North Municipal",
      "Nanumba South",
      "Saboba",
      "Sagnarigu Municipal",
      "Savelugu Municipal",
      "Tamale Metropolitan",
      "Tatale Sanguli",
      "Tolon",
      "Yendi Municipal",
      "Zabzugu",
    ],
  },
  {
    name: "Savannah",
    capital: "Damongo",
    districts: [
      "Bole",
      "Central Gonja",
      "East Gonja Municipal",
      "North East Gonja",
      "North Gonja",
      "Sawla Tuna Kalba",
      "West Gonja Municipal",
    ],
  },
  {
    name: "North East",
    capital: "Nalerigu",
    districts: [
      "Bunkpurugu Nakpanduri",
      "Chereponi",
      "East Mamprusi Municipal",
      "Mamprugu Moagduri",
      "West Mamprusi Municipal",
      "Yunyoo Nasuan",
    ],
  },
  {
    name: "Upper East",
    capital: "Bolgatanga",
    districts: [
      "Bawku Municipal",
      "Bawku West",
      "Binduri",
      "Bolgatanga Municipal",
      "Bolgatanga East",
      "Bongo",
      "Builsa North Municipal",
      "Builsa South",
      "Garu",
      "Kassena Nankana Municipal",
      "Kassena Nankana West",
      "Nabdam",
      "Pusiga",
      "Talensi",
      "Tempane",
    ],
  },
  {
    name: "Upper West",
    capital: "Wa",
    districts: [
      "Daffiama Bussie Issa",
      "Jirapa Municipal",
      "Lambussie Karni",
      "Lawra Municipal",
      "Nadowli Kaleo",
      "Nandom Municipal",
      "Sissala East Municipal",
      "Sissala West",
      "Wa East",
      "Wa Municipal",
      "Wa West",
    ],
  },
  {
    name: "Bono",
    capital: "Sunyani",
    districts: [
      "Banda",
      "Berekum East Municipal",
      "Berekum West",
      "Dormaa Central Municipal",
      "Dormaa East",
      "Dormaa West",
      "Jaman North",
      "Jaman South Municipal",
      "Sunyani Municipal",
      "Sunyani West Municipal",
      "Tain",
      "Wenchi Municipal",
    ],
  },
  {
    name: "Bono East",
    capital: "Techiman",
    districts: [
      "Atebubu Amantin Municipal",
      "Kintampo North Municipal",
      "Kintampo South",
      "Nkoranza North",
      "Nkoranza South Municipal",
      "Pru East",
      "Pru West",
      "Sene East",
      "Sene West",
      "Techiman Municipal",
      "Techiman North",
    ],
  },
  {
    name: "Ahafo",
    capital: "Goaso",
    districts: [
      "Asunafo North Municipal",
      "Asunafo South",
      "Asutifi North",
      "Asutifi South",
      "Tano North Municipal",
      "Tano South Municipal",
    ],
  },
];

/** Flat list of the 16 region names for quick dropdown population. */
export const REGION_NAMES: string[] = GHANA_REGIONS.map((r) => r.name);

/** Returns the districts (MMDAs) belonging to a region. Empty if unknown. */
export function getDistricts(regionName: string): string[] {
  const region = GHANA_REGIONS.find(
    (r) => r.name.toLowerCase() === (regionName || "").trim().toLowerCase()
  );
  return region ? region.districts : [];
}

/** Returns the administrative capital of a region (useful as a town hint). */
export function getRegionCapital(regionName: string): string {
  const region = GHANA_REGIONS.find(
    (r) => r.name.toLowerCase() === (regionName || "").trim().toLowerCase()
  );
  return region ? region.capital : "";
}

/** Total number of MMDAs configured across all regions. */
export const TOTAL_DISTRICTS: number = GHANA_REGIONS.reduce(
  (acc, r) => acc + r.districts.length,
  0
);

/**
 * Builds a single human-readable location string used in tables, receipts and
 * reports, e.g. "Nsawam, Nsawam Adoagyiri Municipal, Eastern".
 */
export function formatLocation(
  region?: string | null,
  district?: string | null,
  town?: string | null
): string {
  const parts = [town, district, region].filter(
    (p) => !!p && String(p).trim().length > 0
  );
  return parts.length > 0 ? parts.join(", ") : "—";
}

/** Short form for compact table cells, e.g. "Nsawam · Eastern". */
export function formatLocationShort(
  region?: string | null,
  town?: string | null
): string {
  if (town && region) return `${town} · ${region}`;
  if (region) return region;
  if (town) return town;
  return "—";
}
