/**
 * Standard inventory taxonomy for GoMina 360.
 *
 * ONE shared vocabulary for every business type. Similar products (a dress in
 * the Boutique, a shirt in another unit) must land under the same umbrella
 * category so the customer marketplace can group them together instead of
 * splitting them by whatever wording a branch happened to type.
 *
 * The umbrella `category` is ALWAYS one of STANDARD_INVENTORY_CATEGORIES.
 * The optional `subcategory` keeps the specific wording (Men's Shirts,
 * Cement & Mortar, Fresh Fish…), so nothing is lost by standardising.
 *
 * Used by:
 *   • src/components/InventoryCategoryFields.tsx (Add Stock Item / Edit modal)
 *   • src/app/api/enterprise/route.ts     (write-time guard)
 *   • src/lib/stock.ts                    (module stock-in guard)
 *   • src/app/api/menu/route.ts           (read-time guard for the marketplace)
 *   • src/lib/initSnapshot.ts             (read-time guard for the dashboard)
 *   • dev-tooling/migrate-production-schema.mjs (one-time data backfill)
 */

export type InventoryCategoryDef = {
  /** The standardized umbrella name — the only thing the marketplace groups by. */
  name: string;
  /** Suggested subcategories (the specifics the business actually means). */
  subcategories: string[];
};

export const INVENTORY_CATEGORIES: InventoryCategoryDef[] = [
  {
    name: "Computers & Electronics",
    subcategories: [
      "Laptops & Computers",
      "Phones & Tablets",
      "TVs, Audio & Video",
      "Solar & Power",
      "Networking & CCTV",
      "Computer Accessories",
      "Electronic Components",
    ],
  },
  {
    name: "Fashion & Clothing",
    subcategories: [
      "Men's Clothing",
      "Women's Clothing",
      "Kids' Clothing",
      "Footwear",
      "Bags & Accessories",
      "Fabrics & Textiles",
      "Jewellery & Watches",
    ],
  },
  {
    name: "Food & Beverages",
    subcategories: [
      "Restaurant Meals",
      "Packaged Foods",
      "Beverages & Drinks",
      "Fresh Produce",
      "Bakery & Confectionery",
      "Cooking Ingredients",
    ],
  },
  {
    name: "Poultry & Eggs",
    subcategories: ["Eggs", "Live Birds", "Dressed Poultry", "Day-Old Chicks", "Poultry Products"],
  },
  {
    name: "Fish & Seafood",
    subcategories: ["Fresh Fish", "Frozen Fish", "Smoked & Processed Fish", "Prawns & Shellfish"],
  },
  {
    name: "Livestock & Meat",
    subcategories: ["Cattle & Beef", "Goats & Sheep", "Pigs & Pork", "Dressed Meat & Offal", "Live Animals"],
  },
  {
    name: "Building Materials",
    subcategories: [
      "Cement & Mortar",
      "Concrete Blocks",
      "Steel & Reinforcement",
      "Roofing & Cladding",
      "Tiles & Flooring",
      "Sand, Stone & Aggregates",
      "Timber & Wood",
      "Doors, Windows & Glazing",
      "Paints & Finishing",
      "Plumbing & Drainage",
      "Electrical Fittings",
    ],
  },
  {
    name: "Hardware & Tools",
    subcategories: [
      "Hand Tools",
      "Power Tools",
      "Fasteners & Fixings",
      "Locks & Security",
      "Safety & Protective Gear",
      "Electrical Hardware",
    ],
  },
  {
    name: "Automotive & Vehicle Care",
    subcategories: [
      "Vehicle Parts & Spares",
      "Tyres, Wheels & Batteries",
      "Oils & Lubricants",
      "Car Care & Cleaning",
      "Car Wash Supplies",
    ],
  },
  {
    name: "Household & Home Appliances",
    subcategories: [
      "Kitchen Appliances",
      "Small Appliances",
      "Furniture & Furnishings",
      "Kitchenware & Cookware",
      "Cleaning Supplies",
      "Home Décor",
    ],
  },
  {
    name: "Beauty & Personal Care",
    subcategories: [
      "Skincare",
      "Hair Care",
      "Cosmetics & Makeup",
      "Wigs & Extensions",
      "Fragrances",
      "Personal Hygiene",
    ],
  },
  {
    name: "Agriculture & Farm Supplies",
    subcategories: [
      "Animal Feed",
      "Seeds & Seedlings",
      "Fertilizers & Soil",
      "Crop Protection",
      "Veterinary Supplies",
      "Farm Machinery & Spares",
      "Fingerlings & Fish Seed",
    ],
  },
  {
    name: "Health & Pharmacy",
    subcategories: ["Medicines", "First Aid & Medical Supplies", "Wellness & Supplements"],
  },
  {
    name: "Baby, Kids & Toys",
    subcategories: ["Baby Care", "Kids' Toys & Games", "School & Kids' Gear"],
  },
  {
    name: "Sports, Leisure & Outdoors",
    subcategories: ["Sports Equipment", "Fitness & Gym", "Outdoor & Camping", "Bicycles & Scooters"],
  },
  {
    name: "Stationery & Office Supplies",
    subcategories: ["Office Stationery", "Books & Learning", "Printers & Consumables"],
  },
  {
    name: "Industrial & Workshop Equipment",
    subcategories: ["Workshop Machinery", "Industrial Chemicals", "Welding & Fabrication", "Generators & Compressors"],
  },
  {
    name: "Pet Supplies",
    subcategories: ["Pet Food", "Pet Accessories & Care"],
  },
  {
    name: "Other / General Merchandise",
    subcategories: ["General Stock", "Miscellaneous"],
  },
];

export const STANDARD_INVENTORY_CATEGORIES: string[] = INVENTORY_CATEGORIES.map((c) => c.name);

/**
 * Flat suggestion list for the quick-add forms of the individual business
 * modules (Hardware, Electronics, Block Factory…): the umbrella categories
 * plus their specific subcategories. The API normalizes whatever is typed, so
 * a branch that types "Cement & Mortar" still lands under Building Materials.
 */
export const INVENTORY_CATEGORY_SUGGESTIONS: string[] = [
  ...STANDARD_INVENTORY_CATEGORIES,
  ...INVENTORY_CATEGORIES.flatMap((c) => c.subcategories),
].filter((v, i, arr) => arr.indexOf(v) === i);

/** Safe landing spot for anything that cannot be mapped more precisely. */
export const DEFAULT_INVENTORY_CATEGORY = "Other / General Merchandise";

const CATEGORY_BY_KEY = new Map(INVENTORY_CATEGORIES.map((c) => [c.name.toLowerCase(), c]));
const SUBCATEGORY_INDEX = new Map<string, { category: string; subcategory: string }>();
for (const c of INVENTORY_CATEGORIES) {
  for (const s of c.subcategories) SUBCATEGORY_INDEX.set(s.toLowerCase(), { category: c.name, subcategory: s });
}

/**
 * Legacy / free-text wording → where it belongs in the standard taxonomy.
 * Keys are matched case-insensitively: first as a whole value, then as a
 * contained phrase (longest key wins, so "poultry feed" beats "poultry").
 */
const CATEGORY_ALIASES: Record<string, { category: string; subcategory?: string }> = {
  // Poultry & eggs
  "poultry products": { category: "Poultry & Eggs", subcategory: "Poultry Products" },
  "poultry product": { category: "Poultry & Eggs", subcategory: "Poultry Products" },
  "poultry meat": { category: "Poultry & Eggs", subcategory: "Dressed Poultry" },
  "dressed poultry": { category: "Poultry & Eggs", subcategory: "Dressed Poultry" },
  "poultry": { category: "Poultry & Eggs", subcategory: "Poultry Products" },
  "eggs": { category: "Poultry & Eggs", subcategory: "Eggs" },
  "egg": { category: "Poultry & Eggs", subcategory: "Eggs" },
  "broiler": { category: "Poultry & Eggs", subcategory: "Dressed Poultry" },
  "broilers": { category: "Poultry & Eggs", subcategory: "Dressed Poultry" },
  "chicks": { category: "Poultry & Eggs", subcategory: "Day-Old Chicks" },
  "day old chicks": { category: "Poultry & Eggs", subcategory: "Day-Old Chicks" },
  // Fish & seafood
  "fresh aquaculture": { category: "Fish & Seafood", subcategory: "Fresh Fish" },
  "fresh fish": { category: "Fish & Seafood", subcategory: "Fresh Fish" },
  "aquaculture": { category: "Fish & Seafood", subcategory: "Fresh Fish" },
  "tilapia": { category: "Fish & Seafood", subcategory: "Fresh Fish" },
  "catfish": { category: "Fish & Seafood", subcategory: "Fresh Fish" },
  "frozen fish": { category: "Fish & Seafood", subcategory: "Frozen Fish" },
  "smoked fish": { category: "Fish & Seafood", subcategory: "Smoked & Processed Fish" },
  "dried fish": { category: "Fish & Seafood", subcategory: "Smoked & Processed Fish" },
  "prawns": { category: "Fish & Seafood", subcategory: "Prawns & Shellfish" },
  "shrimp": { category: "Fish & Seafood", subcategory: "Prawns & Shellfish" },
  "fingerlings": { category: "Agriculture & Farm Supplies", subcategory: "Fingerlings & Fish Seed" },
  "fish seed": { category: "Agriculture & Farm Supplies", subcategory: "Fingerlings & Fish Seed" },
  // Livestock & meat
  "livestock": { category: "Livestock & Meat", subcategory: "Live Animals" },
  "cattle": { category: "Livestock & Meat", subcategory: "Cattle & Beef" },
  "beef": { category: "Livestock & Meat", subcategory: "Cattle & Beef" },
  "goats": { category: "Livestock & Meat", subcategory: "Goats & Sheep" },
  "sheep": { category: "Livestock & Meat", subcategory: "Goats & Sheep" },
  "goat": { category: "Livestock & Meat", subcategory: "Goats & Sheep" },
  "pigs": { category: "Livestock & Meat", subcategory: "Pigs & Pork" },
  "pork": { category: "Livestock & Meat", subcategory: "Pigs & Pork" },
  "meat": { category: "Livestock & Meat", subcategory: "Dressed Meat & Offal" },
  // Feed & farm inputs
  "poultry feed": { category: "Agriculture & Farm Supplies", subcategory: "Animal Feed" },
  "fish feed": { category: "Agriculture & Farm Supplies", subcategory: "Animal Feed" },
  "animal feed": { category: "Agriculture & Farm Supplies", subcategory: "Animal Feed" },
  "feed concentrates": { category: "Agriculture & Farm Supplies", subcategory: "Animal Feed" },
  "feed": { category: "Agriculture & Farm Supplies", subcategory: "Animal Feed" },
  "fertilizer": { category: "Agriculture & Farm Supplies", subcategory: "Fertilizers & Soil" },
  "fertiliser": { category: "Agriculture & Farm Supplies", subcategory: "Fertilizers & Soil" },
  "seeds": { category: "Agriculture & Farm Supplies", subcategory: "Seeds & Seedlings" },
  "seedlings": { category: "Agriculture & Farm Supplies", subcategory: "Seeds & Seedlings" },
  "agrochemical": { category: "Agriculture & Farm Supplies", subcategory: "Crop Protection" },
  "veterinary": { category: "Agriculture & Farm Supplies", subcategory: "Veterinary Supplies" },
  "farm machinery": { category: "Agriculture & Farm Supplies", subcategory: "Farm Machinery & Spares" },
  // Building materials
  "cement": { category: "Building Materials", subcategory: "Cement & Mortar" },
  "mortar": { category: "Building Materials", subcategory: "Cement & Mortar" },
  "concrete blocks": { category: "Building Materials", subcategory: "Concrete Blocks" },
  "blocks": { category: "Building Materials", subcategory: "Concrete Blocks" },
  "block raw materials": { category: "Building Materials", subcategory: "Sand, Stone & Aggregates" },
  "steel": { category: "Building Materials", subcategory: "Steel & Reinforcement" },
  "reinforcement": { category: "Building Materials", subcategory: "Steel & Reinforcement" },
  "roofing": { category: "Building Materials", subcategory: "Roofing & Cladding" },
  "cladding": { category: "Building Materials", subcategory: "Roofing & Cladding" },
  "tiles": { category: "Building Materials", subcategory: "Tiles & Flooring" },
  "flooring": { category: "Building Materials", subcategory: "Tiles & Flooring" },
  "sand": { category: "Building Materials", subcategory: "Sand, Stone & Aggregates" },
  "aggregates": { category: "Building Materials", subcategory: "Sand, Stone & Aggregates" },
  "quarry": { category: "Building Materials", subcategory: "Sand, Stone & Aggregates" },
  "timber": { category: "Building Materials", subcategory: "Timber & Wood" },
  "wood": { category: "Building Materials", subcategory: "Timber & Wood" },
  "paints": { category: "Building Materials", subcategory: "Paints & Finishing" },
  "plumbing": { category: "Building Materials", subcategory: "Plumbing & Drainage" },
  "drainage": { category: "Building Materials", subcategory: "Plumbing & Drainage" },
  "building materials": { category: "Building Materials" },
  "construction": { category: "Building Materials" },
  // Hardware & tools
  "fasteners": { category: "Hardware & Tools", subcategory: "Fasteners & Fixings" },
  "fixings": { category: "Hardware & Tools", subcategory: "Fasteners & Fixings" },
  "nails": { category: "Hardware & Tools", subcategory: "Fasteners & Fixings" },
  "screws": { category: "Hardware & Tools", subcategory: "Fasteners & Fixings" },
  "hand tools": { category: "Hardware & Tools", subcategory: "Hand Tools" },
  "power tools": { category: "Hardware & Tools", subcategory: "Power Tools" },
  "tools": { category: "Hardware & Tools", subcategory: "Hand Tools" },
  "safety gear": { category: "Hardware & Tools", subcategory: "Safety & Protective Gear" },
  "protective gear": { category: "Hardware & Tools", subcategory: "Safety & Protective Gear" },
  "locks": { category: "Hardware & Tools", subcategory: "Locks & Security" },
  "electrical hardware": { category: "Hardware & Tools", subcategory: "Electrical Hardware" },
  "electrical fittings": { category: "Hardware & Tools", subcategory: "Electrical Hardware" },
  "cables": { category: "Hardware & Tools", subcategory: "Electrical Hardware" },
  "hardware": { category: "Hardware & Tools" },
  // Electronics
  "solar": { category: "Computers & Electronics", subcategory: "Solar & Power" },
  "solar & energy": { category: "Computers & Electronics", subcategory: "Solar & Power" },
  "inverter": { category: "Computers & Electronics", subcategory: "Solar & Power" },
  "battery": { category: "Computers & Electronics", subcategory: "Solar & Power" },
  "laptops": { category: "Computers & Electronics", subcategory: "Laptops & Computers" },
  "computers": { category: "Computers & Electronics", subcategory: "Laptops & Computers" },
  "phones": { category: "Computers & Electronics", subcategory: "Phones & Tablets" },
  "tablets": { category: "Computers & Electronics", subcategory: "Phones & Tablets" },
  "television": { category: "Computers & Electronics", subcategory: "TVs, Audio & Video" },
  "audio": { category: "Computers & Electronics", subcategory: "TVs, Audio & Video" },
  "speakers": { category: "Computers & Electronics", subcategory: "TVs, Audio & Video" },
  "cctv": { category: "Computers & Electronics", subcategory: "Networking & CCTV" },
  "networking": { category: "Computers & Electronics", subcategory: "Networking & CCTV" },
  "electronics": { category: "Computers & Electronics", subcategory: "Computer Accessories" },
  "electronic": { category: "Computers & Electronics", subcategory: "Computer Accessories" },
  // Fashion
  "men's shirts": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "mens shirts": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "men's clothing": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "shirts": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "denim & trousers": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "denim": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "trousers": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "jeans": { category: "Fashion & Clothing", subcategory: "Men's Clothing" },
  "ladies' dresses": { category: "Fashion & Clothing", subcategory: "Women's Clothing" },
  "ladies dresses": { category: "Fashion & Clothing", subcategory: "Women's Clothing" },
  "dresses": { category: "Fashion & Clothing", subcategory: "Women's Clothing" },
  "women's clothing": { category: "Fashion & Clothing", subcategory: "Women's Clothing" },
  "footwear": { category: "Fashion & Clothing", subcategory: "Footwear" },
  "shoes": { category: "Fashion & Clothing", subcategory: "Footwear" },
  "sneakers": { category: "Fashion & Clothing", subcategory: "Footwear" },
  "sandals": { category: "Fashion & Clothing", subcategory: "Footwear" },
  "fabrics": { category: "Fashion & Clothing", subcategory: "Fabrics & Textiles" },
  "textiles": { category: "Fashion & Clothing", subcategory: "Fabrics & Textiles" },
  "ankara": { category: "Fashion & Clothing", subcategory: "Fabrics & Textiles" },
  "kente": { category: "Fashion & Clothing", subcategory: "Fabrics & Textiles" },
  "bags": { category: "Fashion & Clothing", subcategory: "Bags & Accessories" },
  "jewellery": { category: "Fashion & Clothing", subcategory: "Jewellery & Watches" },
  "clothing": { category: "Fashion & Clothing" },
  // Food & beverages
  "restaurant": { category: "Food & Beverages", subcategory: "Restaurant Meals" },
  "meals": { category: "Food & Beverages", subcategory: "Restaurant Meals" },
  "beverages": { category: "Food & Beverages", subcategory: "Beverages & Drinks" },
  "drinks": { category: "Food & Beverages", subcategory: "Beverages & Drinks" },
  "juice": { category: "Food & Beverages", subcategory: "Beverages & Drinks" },
  "bakery": { category: "Food & Beverages", subcategory: "Bakery & Confectionery" },
  "bread": { category: "Food & Beverages", subcategory: "Bakery & Confectionery" },
  "vegetables": { category: "Food & Beverages", subcategory: "Fresh Produce" },
  "fruits": { category: "Food & Beverages", subcategory: "Fresh Produce" },
  "produce": { category: "Food & Beverages", subcategory: "Fresh Produce" },
  "rice": { category: "Food & Beverages", subcategory: "Cooking Ingredients" },
  "flour": { category: "Food & Beverages", subcategory: "Cooking Ingredients" },
  "food": { category: "Food & Beverages" },
  // Appliances & household
  "kitchen appliances": { category: "Household & Home Appliances", subcategory: "Kitchen Appliances" },
  "appliances": { category: "Household & Home Appliances", subcategory: "Small Appliances" },
  "furniture": { category: "Household & Home Appliances", subcategory: "Furniture & Furnishings" },
  "kitchenware": { category: "Household & Home Appliances", subcategory: "Kitchenware & Cookware" },
  "cookware": { category: "Household & Home Appliances", subcategory: "Kitchenware & Cookware" },
  "cleaning chemicals": { category: "Household & Home Appliances", subcategory: "Cleaning Supplies" },
  "detergent": { category: "Household & Home Appliances", subcategory: "Cleaning Supplies" },
  "cleaning supplies": { category: "Household & Home Appliances", subcategory: "Cleaning Supplies" },
  "home decor": { category: "Household & Home Appliances", subcategory: "Home Décor" },
  // Beauty & health
  "skincare": { category: "Beauty & Personal Care", subcategory: "Skincare" },
  "hair care": { category: "Beauty & Personal Care", subcategory: "Hair Care" },
  "cosmetics": { category: "Beauty & Personal Care", subcategory: "Cosmetics & Makeup" },
  "makeup": { category: "Beauty & Personal Care", subcategory: "Cosmetics & Makeup" },
  "wigs": { category: "Beauty & Personal Care", subcategory: "Wigs & Extensions" },
  "perfume": { category: "Beauty & Personal Care", subcategory: "Fragrances" },
  "beauty": { category: "Beauty & Personal Care" },
  "medicine": { category: "Health & Pharmacy", subcategory: "Medicines" },
  "medicines": { category: "Health & Pharmacy", subcategory: "Medicines" },
  "pharmacy": { category: "Health & Pharmacy", subcategory: "Medicines" },
  "first aid": { category: "Health & Pharmacy", subcategory: "First Aid & Medical Supplies" },
  // Automotive
  "vehicle parts": { category: "Automotive & Vehicle Care", subcategory: "Vehicle Parts & Spares" },
  "spare parts": { category: "Automotive & Vehicle Care", subcategory: "Vehicle Parts & Spares" },
  "tyres": { category: "Automotive & Vehicle Care", subcategory: "Tyres, Wheels & Batteries" },
  "oils": { category: "Automotive & Vehicle Care", subcategory: "Oils & Lubricants" },
  "lubricants": { category: "Automotive & Vehicle Care", subcategory: "Oils & Lubricants" },
  "car care": { category: "Automotive & Vehicle Care", subcategory: "Car Care & Cleaning" },
  "car wash": { category: "Automotive & Vehicle Care", subcategory: "Car Wash Supplies" },
  "automotive": { category: "Automotive & Vehicle Care" },
  // Baby, sports, stationery, industrial, pets
  "baby": { category: "Baby, Kids & Toys", subcategory: "Baby Care" },
  "toys": { category: "Baby, Kids & Toys", subcategory: "Kids' Toys & Games" },
  "sports": { category: "Sports, Leisure & Outdoors", subcategory: "Sports Equipment" },
  "fitness": { category: "Sports, Leisure & Outdoors", subcategory: "Fitness & Gym" },
  "outdoor": { category: "Sports, Leisure & Outdoors", subcategory: "Outdoor & Camping" },
  "stationery": { category: "Stationery & Office Supplies", subcategory: "Office Stationery" },
  "office supplies": { category: "Stationery & Office Supplies", subcategory: "Office Stationery" },
  "books": { category: "Stationery & Office Supplies", subcategory: "Books & Learning" },
  "industrial": { category: "Industrial & Workshop Equipment" },
  "workshop": { category: "Industrial & Workshop Equipment", subcategory: "Workshop Machinery" },
  "welding": { category: "Industrial & Workshop Equipment", subcategory: "Welding & Fabrication" },
  "generator": { category: "Industrial & Workshop Equipment", subcategory: "Generators & Compressors" },
  "pet food": { category: "Pet Supplies", subcategory: "Pet Food" },
  "pet supplies": { category: "Pet Supplies", subcategory: "Pet Accessories & Care" },
  // Catch-all
  "general": { category: "Other / General Merchandise", subcategory: "General Stock" },
  "general stock": { category: "Other / General Merchandise", subcategory: "General Stock" },
  "general merchandise": { category: "Other / General Merchandise", subcategory: "General Stock" },
  "miscellaneous": { category: "Other / General Merchandise", subcategory: "Miscellaneous" },
  "other": { category: "Other / General Merchandise", subcategory: "Miscellaneous" },
};

/** Alias keys ordered longest-first so the most specific phrase wins. */
const ALIAS_KEYS_LONGEST_FIRST = Object.keys(CATEGORY_ALIASES).sort((a, b) => b.length - a.length);

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

export function isStandardInventoryCategory(value?: string | null): boolean {
  return CATEGORY_BY_KEY.has(clean(value).toLowerCase());
}

/** Every category must resolve to one of these — nothing else is ever stored. */
export function normalizeInventoryCategory(raw?: string | null): string {
  const value = clean(raw);
  if (!value) return DEFAULT_INVENTORY_CATEGORY;
  const exactStandard = CATEGORY_BY_KEY.get(value.toLowerCase());
  if (exactStandard) return exactStandard.name;
  const exactSub = SUBCATEGORY_INDEX.get(value.toLowerCase());
  if (exactSub) return exactSub.category;
  const exactAlias = CATEGORY_ALIASES[value.toLowerCase()];
  if (exactAlias) return exactAlias.category;
  const lower = value.toLowerCase();
  for (const key of ALIAS_KEYS_LONGEST_FIRST) {
    if (lower.includes(key)) return CATEGORY_ALIASES[key].category;
  }
  return DEFAULT_INVENTORY_CATEGORY;
}

/**
 * Best subcategory for a row: keeps an explicit subcategory when it is present
 * (it is the specific wording the business chose), otherwise derives it from
 * the original (possibly legacy) category wording. Returns null when there is
 * nothing more specific than the umbrella.
 */
export function deriveInventorySubcategory(
  rawCategory?: string | null,
  rawSubcategory?: string | null,
): string | null {
  const sub = clean(rawSubcategory);
  if (sub) return sub;
  const category = clean(rawCategory);
  if (!category) return null;
  const alias = CATEGORY_ALIASES[category.toLowerCase()];
  if (alias?.subcategory) return alias.subcategory;
  const viaSub = SUBCATEGORY_INDEX.get(category.toLowerCase());
  if (viaSub) return viaSub.subcategory;
  // Free text: keep the original wording as the subcategory only when it adds
  // information beyond the umbrella (e.g. "Imported Print Dresses").
  if (category.toLowerCase() !== normalizeInventoryCategory(category).toLowerCase()) return category;
  return null;
}

/** Suggested subcategories for a category (empty for unknown/blank input). */
export function subcategoriesOf(category?: string | null): string[] {
  const found = CATEGORY_BY_KEY.get(normalizeInventoryCategory(category).toLowerCase());
  return found ? found.subcategories : [];
}

/** Row-level helper for read paths: standard umbrella + preserved subcategory. */
export function normalizeInventoryItem<T extends { category?: string | null; subcategory?: string | null }>(
  item: T,
): T {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    category: normalizeInventoryCategory(item.category),
    subcategory: deriveInventorySubcategory(item.category, item.subcategory),
  };
}

/** Fields the Add/Edit forms and the APIs share. */
export function inventoryCategoryFields(rawCategory?: string | null, rawSubcategory?: string | null) {
  return {
    category: normalizeInventoryCategory(rawCategory),
    subcategory: deriveInventorySubcategory(rawCategory, rawSubcategory),
  };
}
