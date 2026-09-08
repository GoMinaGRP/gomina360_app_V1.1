import { NextRequest, NextResponse } from "next/server";
import { getSessionInfo, UNAUTHENTICATED } from "@/lib/auth";

/**
 * Poultry AI Knowledge Base — Ghana-focused practical farming guidance.
 * Searches a curated corpus and returns the best-matching articles.
 */

interface KnowledgeArticle {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  content: string[];
}

const KNOWLEDGE_BASE: KnowledgeArticle[] = [
  {
    id: "feed-formulation",
    title: "Layer Feed Formulation & Cost Control in Ghana",
    category: "FEED",
    keywords: ["feed", "formulation", "maize", "cost", "layer", "mash", "protein", "ration", "soya"],
    summary: "Balanced layer mash targets 16–18% crude protein and 3.5–4% calcium for strong shells.",
    content: [
      "A standard Ghanaian layer mash is roughly 55–60% maize, 18–22% soya/groundnut cake, 8–10% wheat bran, 8% oyster shell/limestone, plus premix and salt.",
      "Target 16–18% crude protein for layers in production and 3.5–4.0% calcium for shell strength.",
      "Feed is typically 65–70% of total production cost. Buy maize in bulk during the Sept–Nov harvest when prices drop, and store in a dry, raised silo.",
      "Watch for aflatoxin in poorly dried maize — it suppresses laying and damages the liver. Test or buy from a reputable mill.",
      "Feed 110–125g per layer per day. Overfeeding wastes money; underfeeding drops lay percentage within 3–5 days.",
    ],
  },
  {
    id: "broiler-fcr",
    title: "Improving Broiler Feed Conversion Ratio (FCR)",
    category: "FEED",
    keywords: ["fcr", "broiler", "conversion", "weight", "growth", "finisher", "starter"],
    summary: "A good broiler FCR in Ghana is 1.6–1.8 by week 6 at ~2.2kg live weight.",
    content: [
      "FCR = total feed consumed (kg) ÷ total live weight gained (kg). Lower is better.",
      "Phase feeding: Starter (0–2 weeks, 22–23% protein), Grower (3–4 weeks, 20%), Finisher (5–slaughter, 18%).",
      "Keep feed fresh — stale or moldy feed cuts intake and raises FCR sharply.",
      "Maintain house temperature at 32°C in week 1, reducing ~3°C weekly to 21–24°C. Cold birds burn feed just to stay warm.",
      "Ensure 24-hour access to clean water; a 10% water shortage causes roughly a 6% drop in feed intake.",
    ],
  },
  {
    id: "newcastle",
    title: "Newcastle Disease — Prevention & Vaccination Schedule",
    category: "HEALTH",
    keywords: ["newcastle", "vaccine", "vaccination", "disease", "lasota", "schedule", "biosecurity"],
    summary: "Newcastle is the top killer in Ghanaian flocks. Vaccinate at day 7, 21, then every 8–10 weeks.",
    content: [
      "Typical Ghana schedule: Day 1 Marek's (hatchery), Day 7 Lasota (eye drop), Day 14 Gumboro, Day 21 Lasota booster, Day 28 Gumboro booster, Week 8 Fowl Pox, then Lasota every 8–10 weeks for layers.",
      "Signs: greenish diarrhoea, twisted neck (torticollis), gasping, sudden drop in egg production, and high mortality.",
      "Store vaccines at 2–8°C. A broken cold chain makes the vaccine useless — use a cool box with ice packs on the way from the vet shop.",
      "Give vaccine in the coolest part of the day (early morning). Withhold water 1–2 hours before drinking-water vaccination so birds drink it all within 2 hours.",
      "There is no treatment once infected — prevention through vaccination and biosecurity is the only reliable defence.",
    ],
  },
  {
    id: "biosecurity",
    title: "Farm Biosecurity Essentials",
    category: "HEALTH",
    keywords: ["biosecurity", "disease", "prevention", "footbath", "hygiene", "visitors", "quarantine"],
    summary: "Footbaths, restricted access, and all-in/all-out stocking prevent most disease outbreaks.",
    content: [
      "Keep a disinfectant footbath at every house entrance and change the solution daily — it stops working once it's dirty.",
      "Restrict visitors. Anyone entering should wear farm-provided boots and overalls.",
      "Practise all-in/all-out: fully depopulate, clean, disinfect, then rest the house 10–14 days before restocking.",
      "Keep new birds in quarantine at least 2 weeks away from the main flock.",
      "Control rodents and wild birds — they carry Newcastle and Salmonella. Seal feed stores.",
      "Remove and properly dispose of dead birds daily by burning or deep burial, never by dumping nearby.",
    ],
  },
  {
    id: "lay-percentage",
    title: "Understanding & Improving Lay Percentage",
    category: "PRODUCTION",
    keywords: ["lay", "percentage", "eggs", "production", "peak", "drop", "hen day"],
    summary: "Peak lay of 90–95% should be reached around week 28–32 and held for 8–10 weeks.",
    content: [
      "Lay % = (eggs collected ÷ live birds) × 100. This is the hen-day production rate.",
      "Layers start around week 18–20, peak at 90–95% by week 28–32, then decline about 0.5% weekly.",
      "Provide 16 hours of light per day in production. In Ghana, supplement with artificial light from 5am and after 6pm.",
      "A sudden drop of more than 5% usually means: disease, feed change, water shortage, heat stress, or a predator scare at night.",
      "Below 65% lay on an old flock, it's often more profitable to sell as spent layers and restock.",
    ],
  },
  {
    id: "heat-stress",
    title: "Managing Heat Stress in Ghana's Climate",
    category: "HOUSING",
    keywords: ["heat", "stress", "temperature", "ventilation", "cooling", "harmattan", "water"],
    summary: "Above 30°C birds cut feed intake sharply. Cooling and cold water protect production.",
    content: [
      "Birds are comfortable at 18–24°C. Above 30°C they pant, drink more, and eat much less.",
      "Signs: panting, wings held away from body, lethargy, pale combs, thin shells, and dropping lay percentage.",
      "Feed early morning (5–8am) and late evening (5–7pm) when it's cooler; avoid midday feeding.",
      "Supply cool, fresh water and increase drinker space. Add electrolytes and Vitamin C during hot spells.",
      "Improve ventilation: open sidewalls, add ridge vents, install fans, and paint roofs white or use insulation.",
      "Reduce stocking density in the hot season — give layers at least 0.15–0.2 m² each.",
    ],
  },
  {
    id: "housing-density",
    title: "Housing Design & Stocking Density",
    category: "HOUSING",
    keywords: ["housing", "density", "space", "deep litter", "cage", "pen", "design", "litter"],
    summary: "Deep litter: 3–4 layers/m². Broilers: 8–10 birds/m². Orient houses east–west.",
    content: [
      "Deep litter for layers: 3–4 birds per m². Battery cage: follow the manufacturer's spec, usually 450–550 cm² per bird.",
      "Broilers on deep litter: 8–10 birds per m² depending on target weight and ventilation.",
      "Orient the house east–west so the long sides avoid direct morning and evening sun.",
      "Use wire mesh sidewalls (open-sided housing) for natural ventilation — standard and cost-effective in Ghana.",
      "Litter (wood shavings or rice husk) should be 5–8cm deep, kept dry and turned regularly. Wet litter causes ammonia burn and coccidiosis.",
      "Provide 1 nest box per 4–5 layers and at least 10cm of feeder space per bird.",
    ],
  },
  {
    id: "profitability",
    title: "Poultry Farm Profitability & Record Keeping",
    category: "FINANCE",
    keywords: ["profit", "cost", "margin", "record", "finance", "roi", "breakeven", "price"],
    summary: "Track feed cost per egg/kg. Feed is 65–70% of cost — it decides profitability.",
    content: [
      "Key metrics: feed cost per tray, mortality %, lay %, FCR, and cost per bird placed.",
      "Layer economics: a bird eats roughly 45kg of feed over a 72-week cycle and lays about 300 eggs (10 trays).",
      "Broiler economics: about 4kg feed per bird to reach 2.2kg live weight in 6 weeks.",
      "Sell direct to hotels, restaurants, and neighbourhood shops rather than through middlemen — margins improve substantially.",
      "Cull non-layers early. A bird eating without laying is pure loss.",
      "Diversify income: sell manure to crop farmers, sell spent layers, and consider table-egg branding for a price premium.",
    ],
  },
  {
    id: "water-quality",
    title: "Water Quality & Daily Requirements",
    category: "WATER",
    keywords: ["water", "quality", "ph", "consumption", "drinker", "chlorine", "sanitation"],
    summary: "Birds drink ~2× their feed weight. Keep water pH 6.5–7.5 and sanitise regularly.",
    content: [
      "Water intake is roughly twice feed intake by weight, and much higher in hot weather.",
      "A layer drinks 200–250ml per day; a broiler at week 6 drinks about 250–300ml per day.",
      "Ideal pH is 6.5–7.5. Very alkaline water reduces intake and interferes with some medications.",
      "Sanitise with chlorine at 3–5 ppm at the drinker. Flush lines weekly to break down biofilm.",
      "Clean drinkers daily — biofilm harbours E. coli and Salmonella.",
      "Test borehole water annually for coliforms, nitrates, and heavy metals.",
    ],
  },
  {
    id: "coccidiosis",
    title: "Coccidiosis — Detection & Treatment",
    category: "HEALTH",
    keywords: ["coccidiosis", "bloody", "droppings", "amprolium", "litter", "parasite", "treatment"],
    summary: "Bloody droppings and ruffled feathers signal coccidiosis. Treat with Amprolium and dry the litter.",
    content: [
      "Caused by Eimeria parasites that thrive in warm, wet litter — very common in Ghana's rainy season.",
      "Signs: bloody or mucoid droppings, ruffled feathers, huddling, pale combs, poor growth, and rising mortality.",
      "Treat with Amprolium (typically 1g per 2L water for 5–7 days) or Sulphaquinoxaline. Follow the vet's dosage.",
      "Add Vitamin K and A during and after treatment to help gut recovery.",
      "Prevention: keep litter dry, avoid overcrowding, fix leaking drinkers immediately, and use a coccidiostat in feed for broilers.",
      "Observe the withdrawal period before selling treated birds for meat.",
    ],
  },
  {
    id: "brooding",
    title: "Chick Brooding Best Practices",
    category: "HOUSING",
    keywords: ["brooding", "chick", "day old", "temperature", "heat", "starter", "first week"],
    summary: "Week 1 at 32–35°C decides flock performance. Aim for 95%+ crop fill in 24 hours.",
    content: [
      "Pre-heat the brooder house 24 hours before chicks arrive; the floor must be warm, not just the air.",
      "Temperature: 32–35°C week 1, then reduce about 3°C weekly until 21–24°C.",
      "Read the chicks, not just the thermometer: huddling under the heat = too cold; spread to the walls panting = too hot; evenly spread = correct.",
      "Give glucose or electrolyte water on arrival to counter transport stress, then starter feed on paper or trays.",
      "Check crop fill at 24 hours — at least 95% of chicks should have full, soft crops.",
      "Provide 23 hours of light in the first week to encourage feeding and drinking.",
    ],
  },
  {
    id: "marketing-ghana",
    title: "Marketing Eggs & Poultry in Ghana",
    category: "FINANCE",
    keywords: ["market", "sell", "price", "customer", "egg", "crate", "distribution", "branding"],
    summary: "Direct supply to hotels, schools, and shops beats middlemen on price and consistency.",
    content: [
      "Eggs are sold by crate (30 eggs). Grade by size — larger eggs command a premium.",
      "Reliable buyers: hotels, restaurants, schools, hospitals, supermarkets (Shoprite, Melcom), and neighbourhood provision shops.",
      "Consistency wins contracts. Buyers pay more for a farm that never misses a delivery.",
      "Use clean, branded crates. Presentation raises perceived quality and repeat orders.",
      "Live broilers sell well before Christmas, Easter, and Eid — plan your batch timing so birds hit market weight in those weeks.",
      "Accept MTN MoMo and Telecel Cash — most customers prefer mobile money over cash.",
    ],
  },
];

export async function GET(request: NextRequest) {
  try {
    const __authSession = await getSessionInfo(request);
    if (!__authSession) return UNAUTHENTICATED();
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim().toLowerCase();
    const category = searchParams.get("category");

    let results = KNOWLEDGE_BASE;

    if (category && category !== "ALL") {
      results = results.filter((a) => a.category === category);
    }

    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      results = results
        .map((a) => {
          let score = 0;
          const haystack = [
            a.title.toLowerCase(),
            a.summary.toLowerCase(),
            a.keywords.join(" ").toLowerCase(),
            a.content.join(" ").toLowerCase(),
          ];
          for (const term of terms) {
            if (a.keywords.some((k) => k.includes(term))) score += 10;
            if (haystack[0].includes(term)) score += 6;
            if (haystack[1].includes(term)) score += 3;
            if (haystack[3].includes(term)) score += 1;
          }
          return { article: a, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.article);
    }

    const categories = Array.from(
      new Set(KNOWLEDGE_BASE.map((a) => a.category))
    ).sort();

    return NextResponse.json({
      success: true,
      articles: results,
      categories,
      totalArticles: KNOWLEDGE_BASE.length,
      query: q,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
