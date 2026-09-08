/**
 * GoMina AI Guide — content engine.
 *
 * Every business section carries its own step-by-step guide, written in
 * simple language and specific to the business TYPE (a poultry farm reads
 * about flocks and egg trays; a block factory reads about cement bags and
 * molded blocks). Guides are resolved by (moduleKey, section) with safe
 * fallbacks so no section ever shows an empty assistant.
 */

export interface GuideTask {
  name: string;
  steps: string[];
  tip?: string;
}

export interface GuideFaq {
  q: string; // chip label shown in the assistant
  match: string[]; // keywords that route a free-text question here
  answer: string;
}

export interface SectionGuide {
  title: string;
  intro: string;
  tasks: GuideTask[];
  faqs: GuideFaq[];
}

const CHECKLIST_TASKS: GuideTask[] = [
  {
    name: "Create today's checklist",
    steps: [
      "Open the Daily Checklist section.",
      "If today has no list yet, click “Create Checklist” — the standard tasks for this business type are generated for you.",
      "The list is dated, so you start fresh every day.",
    ],
    tip: "The list only needs to be created once per day — everyone on the branch then sees the same tasks.",
  },
  {
    name: "Complete and track tasks",
    steps: [
      "Read each task and click its round button when it is done.",
      "Watch the completion bar at the top move towards 100%.",
      "Head Office sees your completion on the Command Center, so finishing on time keeps the branch green.",
    ],
  },
  {
    name: "Manage the task list",
    steps: [
      "Click “Manage Items” to see the standing task list for this branch.",
      "Switch off tasks that do not apply, so tomorrow's list stays clean and relevant.",
    ],
  },
];

const CHECKLIST_FAQS: GuideFaq[] = [
  {
    q: "How do I get today's tasks?",
    match: ["create", "today", "tasks", "generate", "start"],
    answer:
      "Open Daily Checklist and click “Create Checklist”. Today's full task list for this business type appears instantly — then just tick items off as you work.",
  },
  {
    q: "Who sees my progress?",
    match: ["who", "progress", "command", "report", "owner"],
    answer:
      "Your completion percentage shows on the Command Center compliance rows, so the Owner and General Manager can see the branch is running its daily routine.",
  },
];

const COMMON: Record<string, SectionGuide> = {
  DASHBOARD: {
    title: "Dashboard",
    intro:
      "This is the live front page of {biz}. Every card updates by itself as sales, stock and expenses are recorded — you never type totals by hand.",
    tasks: [
      {
        name: "Read the health of the business",
        steps: [
          "Look at the top cards first: money in, money out, stock value and alerts.",
          "Cards with a red or amber colour need attention today; green cards are healthy.",
          "Scroll down for charts and lists — they all come from the same live records.",
        ],
      },
      {
        name: "Act on an alert",
        steps: [
          "Open the Alerts area and read the message — it says exactly what is wrong (for example low stock).",
          "Follow the suggested fix, usually restocking or recording the missing entry.",
        ],
      },
    ],
    faqs: [
      {
        q: "Do I need to update anything here?",
        match: ["update", "manual", "edit", "refresh"],
        answer:
          "No — the dashboard updates itself from sales, restocks, production and expenses. Just record activities in the other sections and this page follows instantly.",
      },
      {
        q: "Something looks wrong, what do I check?",
        match: ["wrong", "error", "check", "alert"],
        answer:
          "Open the Alerts card first. It lists items that are low, out of stock, or entries missing for today. Fixing the listed item clears the alert.",
      },
    ],
  },
  CHECKLIST: {
    title: "Daily Checklist",
    intro:
      "This is the branch's daily routine list. It proves every morning that {biz} opened properly, and Head Office tracks it automatically.",
    tasks: CHECKLIST_TASKS,
    faqs: CHECKLIST_FAQS,
  },
  FINANCE_REPORT: {
    title: "Financial Report",
    intro:
      "This is the complete written financial report of {biz}: revenue, sales, expenses, profit, payments, outstanding balances and trends — all pulled live from the same records as every other section, so it updates itself the moment a sale, purchase, production batch, order or expense is recorded.",
    tasks: [
      {
        name: "Report on a period (days, months, years)",
        steps: [
          "Tap a period chip — Today, Last 7 Days, This Month, Last Month, Last 6 Months, Year to Date, Last Year or All Time.",
          "Every card, chart and table below instantly recalculates for that range only.",
          "Use the Trend-by buttons to view the chart by Days, Months or Years.",
        ],
        tip: "The Q1-2026 baseline strip shows the records the branch opened with; it folds into the All Time view automatically.",
      },
      {
        name: "Compare businesses and branches",
        steps: [
          "On the Command Center report, use the Business / Branch picker to isolate one unit or view the consolidated group.",
          "Inside a unit's own report, the Branch/Register picker filters by register code.",
          "The per-business table ranks every branch by revenue, expenses, profit and margin for the chosen period.",
        ],
      },
      {
        name: "Chase outstanding money",
        steps: [
          "Check the Outstanding card: open invoices and payments still awaiting MoMo verification are listed with amounts.",
          "Open the Sales & Payments center to mark an invoice paid — the report updates immediately.",
        ],
      },
    ],
    faqs: [
      {
        q: "Are these numbers live?",
        match: ["live", "real", "update", "automatic", "refresh"],
        answer:
          "Yes. Sales, purchases, production, orders, expenses and payments all post straight into the financial ledger, and this report reads from it directly — numbers change the instant a record is saved anywhere in the app.",
      },
      {
        q: "How do I see a specific month or year?",
        match: ["month", "year", "days", "period", "filter", "date"],
        answer:
          "Use the period chips (This Month, Last Month, Year to Date, Last Year…) and set the trend to Months or Years. The cards and the chart recalculate together for the exact range.",
      },
      {
        q: "What is counted as profit?",
        match: ["profit", "margin", "net"],
        answer:
          "Net Profit = Revenue − Expenses inside the selected period. The margin percentage is profit as a share of revenue. On All Time, the Q1-2026 opening baseline is included; dated ranges report the live ledger only.",
      },
      {
        q: "Where does outstanding money show?",
        match: ["outstanding", "owed", "debt", "unpaid", "receivable"],
        answer:
          "The Outstanding & Receivables card lists unpaid or partially-paid invoices plus any mobile-money collections still awaiting verification, with the total at the top-right of the card.",
      },
    ],
  },
  DEFAULT: {
    title: "This section",
    intro: "Here is how to use this part of {biz}.",
    tasks: [
      {
        name: "Find the main actions",
        steps: [
          "Look for the coloured buttons at the top of the section — they start every task.",
          "Fill the form that opens and confirm with the coloured button at the bottom.",
          "The record saves instantly and every connected card or table updates by itself.",
        ],
      },
    ],
    faqs: [
      {
        q: "Where is the save button?",
        match: ["save", "submit", "button"],
        answer:
          "Forms save with the coloured button at the bottom of the form. The section refreshes itself right after — no extra save is needed.",
      },
    ],
  },
};

/** Guide content for the SHARED “Finance & Reports” central module + the report inside it. */
const CENTRAL_FINANCE_GUIDE: SectionGuide = {
  title: "Central Financial Report",
  intro:
    "Head Office's money desk — every cedi earned, spent, collected and still owed across all businesses and registers, updating live as sales, purchases, expenses and payments are posted anywhere in GoMina 360.",
  tasks: [
    {
      name: "Read the group's month at a glance",
      steps: [
        "Open “Finance & Reports” under Shared Enterprise Modules.",
        "The Group Pulse cards at the top show this month's revenue, cash collected, group net profit with margin, and the best-performing unit.",
        "Watch the % badge — it compares this month to last month automatically.",
      ],
    },
    {
      name: "Report for any period — days, months, years",
      steps: [
        "Use the Period pills (Today, Yesterday, Last 7 Days, This Month … All Time).",
        "Switch “Trend By” between Days, Months and Years to reshape the chart.",
        "Every figure — revenue, expenses, profit, payments, outstanding — recalculates instantly for the chosen window.",
      ],
    },
    {
      name: "Compare or isolate businesses and branches",
      steps: [
        "Pick a business (or a branch/register) from the scope selector.",
        "The per-business table ranks every unit by revenue, expenses and profit; a branch split appears whenever more than one register is active.",
        "Q1-2026 baseline figures are folded into All-Time so earlier history is never lost.",
      ],
    },
    {
      name: "Chase outstanding money & audit the ledger",
      steps: [
        "The Outstanding panel lists open invoices and pending MoMo/offline collections per business.",
        "Scroll to the ledger for the newest postings with type, payment method and recorder.",
        "Use the quick links to jump into Sales, Purchases, Inventory, Transactions or any module for action.",
      ],
    },
  ],
  faqs: [
    {
      q: "Do the numbers update automatically when someone posts a sale or expense elsewhere?",
      match: ["real time", "real-time", "update", "automatic", "live", "refresh"],
      answer:
        "Yes. This report reads the same live ledger as every dashboard — the moment a sale, purchase, production posting, order, expense or payment is saved anywhere in GoMina 360, every card, trend and table here reflects it (the LIVE badge). You can also tap Refresh to force a reload.",
    },
    {
      q: "What counts as outstanding?",
      match: ["outstanding", "owed", "invoice", "pending", "collection"],
      answer:
        "Sent/unpaid invoices plus mobile-money or offline sales still pending verification. Once a payment is confirmed, the amount moves from Outstanding to Payments Collected automatically.",
    },
    {
      q: "Why does All-Time differ from This Month?",
      match: ["all time", "baseline", "q1", "history", "differ"],
      answer:
        "All-Time folds in each unit's Q1-2026 system baseline (clearly labelled in the baseline strip) plus every live posting since. Shorter windows count only the live ledger, so history stays intact without distorting the current period.",
    },
    {
      q: "Who can open this module?",
      match: ["who", "access", "permission", "worker", "manager"],
      answer:
        "Owners and General Managers. Branch managers see the same engine scoped to their own branch inside the Branch Sales Center, and workers see only their own sales activity.",
    },
  ],
};

export const GUIDES: Record<string, Record<string, SectionGuide>> = {
  /* ════════════════════════ POULTRY FARM ════════════════════════ */
  POULTRY: {
    DASHBOARD: {
      title: "Poultry Dashboard",
      intro:
        "This is the live picture of {biz}: birds alive, eggs collected, lay rate, feed stock, profit and health alerts — all in one glance.",
      tasks: [
        {
          name: "Read the farm's vital signs",
          steps: [
            "The small cards at the very top show Live Birds, Eggs (latest), Lay % and Checklist % for today.",
            "The bigger cards below show Active Flocks, Mortality Rate, Feed Stock, Water, Health Cost and Net Profit.",
            "Any card moving in a bad direction is your early warning — check the alerts strip below the cards.",
          ],
        },
        {
          name: "Use Smart Alerts & Warnings",
          steps: [
            "Each alert card says what is NORMAL, WARNING or CRITICAL for {biz} — mortality, feed intake, water, egg production and more.",
            "Read the “Recommendation” line in any WARNING or CRITICAL card: it tells you the exact action to take.",
            "After you fix the issue (for example log feed or water), the alert clears by itself.",
          ],
        },
        {
          name: "Filter what you see",
          steps: [
            "Use “Date Range” in Dashboard Filters to look at today, this week or all time.",
            "Use “Product Type” to focus on layers (eggs) or broilers (meat) only.",
          ],
          tip: "Filters only change the view — your records are never touched.",
        },
      ],
      faqs: [
        {
          q: "Why are my numbers zero?",
          match: ["zero", "empty", "nothing", "0 birds", "no data"],
          answer:
            "A new farm starts at zero on purpose. Register your first flock (Flock & Batch → New Flock), then log today's eggs (Production → Log Production). The cards fill in immediately.",
        },
        {
          q: "What does the health score mean?",
          match: ["score", "90", "performance"],
          answer:
            "The Poultry Health & Performance Score (out of 100) grades today's routine: mortality, feeding, water and production entries. Finishing the Daily Checklist and keeping alerts green keeps the score high.",
        },
      ],
    },
    FLOCKS: {
      title: "Flock & Batch",
      intro:
        "Every group of birds at {biz} is a flock (batch). Register it once and the farm tracks its birds, mortality and age from that day on.",
      tasks: [
        {
          name: "Register a new flock",
          steps: [
            "Click the green “New Flock” button on this tab.",
            "Give it a Batch Number (or leave it blank to auto-generate one) and a Flock Name.",
            "Choose the Bird Type (LAYERS for eggs, BROILERS for meat), the Breed, and the Initial Count of birds.",
            "Add Age in weeks, Arrival Date and Cost per Bird if you know them.",
            "Press the submit button — the flock appears in the table and Live Birds on the dashboard updates at once.",
          ],
          tip: "One batch per house/pen keeps mortality and lay-rate tracking accurate.",
        },
        {
          name: "Read the flock table",
          steps: [
            "PLACED is how many birds arrived; LIVE is how many are alive now.",
            "MORTALITY shows deaths so far with its percentage — a rising number needs a health check (Health & Vaccination tab).",
            "STATUS ACTIVE means the flock is still producing; sold-out broiler batches close automatically.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I remove dead birds?",
          match: ["dead", "death", "mortality", "die"],
          answer:
            "Go to Health & Vaccination → Add Record, choose Record Type “MORTALITY”, pick the batch and enter the count. Live Birds drops automatically.",
        },
        {
          q: "Layers or broilers — which do I pick?",
          match: ["layers", "broilers", "type", "which"],
          answer:
            "Choose LAYERS if the birds stay long-term to lay eggs, BROILERS if they are raised for meat and sold off. The dashboard filters and production forms follow this choice.",
        },
      ],
    },
    FEED: {
      title: "Feed Management",
      intro:
        "Track every kilogram of feed at {biz}: what you buy, what the birds eat, and what it costs — so feed never runs out silently.",
      tasks: [
        {
          name: "Log feed the birds ate",
          steps: [
            "Click “Log Feed”.",
            "Entry Type: choose “Consumption (used)”.",
            "Pick the Feed Type (STARTER, GROWER, LAYER MASH…) and the flock batch.",
            "Enter Quantity in kg and the date, then submit — feed stock drops and the Feed Stock card updates.",
          ],
        },
        {
          name: "Record a feed purchase",
          steps: [
            "Click “Log Feed” and choose Entry Type “Purchase (stock in)”.",
            "Enter the Feed Type, kg bought and Cost per kg.",
            "Submit — purchased kg add to the feed stock figure shown on the dashboard.",
          ],
          tip: "Logging purchases with their cost keeps your real feed cost per bird accurate.",
        },
      ],
      faqs: [
        {
          q: "What is a good feed quantity per day?",
          match: ["how much", "quantity", "normal", "per bird"],
          answer:
            "Layers eat roughly 110–120 g per bird per day (about 110 kg per 1,000 birds). The dashboard's Feed Intake alert compares your entries against this and warns when birds are under- or over-fed.",
        },
      ],
    },
    WATER: {
      title: "Water Management",
      intro:
        "Birds drink about twice what they eat — this tab logs daily water so shortages never go unnoticed at {biz}.",
      tasks: [
        {
          name: "Log today's water",
          steps: [
            "Click “Log Water”.",
            "Choose the batch, enter Volume in Liters and pick the Source (BOREHOLE, PIPED…).",
            "Enter the pH if you test it (safe band: 6.5–7.5).",
            "Tick “Water was treated” if you added chlorine or vitamins, and name the treatment.",
            "Submit — the Water card on the dashboard refreshes.",
          ],
        },
      ],
      faqs: [
        {
          q: "How much water is normal?",
          match: ["how much", "normal", "litre", "liters"],
          answer:
            "Roughly 200 ml per laying bird per day in Ghana's heat, more in the dry season. If your logged liters per bird fall far below that, the dashboard water alert turns amber.",
        },
      ],
    },
    HEALTH: {
      title: "Health & Vaccination",
      intro:
        "All vaccinations, treatments, inspections and mortality for {biz} live here — your biosecurity diary with due-date reminders.",
      tasks: [
        {
          name: "Add a vaccination record",
          steps: [
            "Click “Add Record”.",
            "Record Type: choose VACCINATION.",
            "Pick the flock batch, write the Vaccine name (e.g. Lasota) and the dosage.",
            "Enter the cost and, importantly, the Next Due Date so the farm reminds you.",
            "Submit — the record lands in the table with its outcome status.",
          ],
        },
        {
          name: "Log mortality",
          steps: [
            "Click “Add Record”, choose Record Type MORTALITY and the batch.",
            "Enter the number of dead birds and any suspected cause under Disease / Condition.",
            "Submit — Live Birds and the mortality rate update everywhere instantly.",
          ],
          tip: "More than ~0.5% deaths in a day is a red flag: the dashboard alert will turn critical until it normalises.",
        },
      ],
      faqs: [
        {
          q: "How do reminders work?",
          match: ["remind", "due", "next", "vaccination"],
          answer:
            "Every record with a Next Due Date counts towards your health alerts, so a vaccine that is due shows up as a warning before it is overdue.",
        },
      ],
    },
    PRODUCTION: {
      title: "Egg & Bird Production",
      intro:
        "Log eggs collected or birds harvested — every entry stocks the sellable product into Inventory automatically and updates the farm's lay rate.",
      tasks: [
        {
          name: "Log today's eggs",
          steps: [
            "Click “Log Production” (or “Record Sale” area) — the Production tab's form is called Log Production.",
            "Production Type: Eggs. Pick the flock batch.",
            "Enter Eggs Collected — trays calculate automatically (30 eggs = 1 tray).",
            "Fill Grade A / B / Cracked counts if you grade, and Lay %. ",
            "Submit — the good trays are added to your egg stock in the Inventory tab at once.",
          ],
          tip: "Enter cracked eggs honestly: they are excluded from sellable stock but keep your lay % true.",
        },
        {
          name: "Harvest broilers",
          steps: [
            "In “Log Production”, switch Production Type to Broiler Harvest.",
            "Enter Birds Harvested and their total/average weight.",
            "Submit — dressed birds become sellable stock in Inventory.",
          ],
        },
        {
          name: "Add a brand-new product type",
          steps: [
            "Open “Log Production” and pick “＋ Add New Product Type…” in the Production Type list.",
            "Name the product (e.g. Duck Egg Crates), choose its Unit (Trays, Birds, Kg, Crates…) and set cost / selling prices.",
            "Enter the Quantity Produced and submit.",
            "The product is saved to the Master Product List (shown right on this tab) and its stock appears in Inventory at once.",
            "From now on the type appears in the Production Type list, the Record Sale stock picker, and all reports — just like Eggs and Broilers.",
          ],
          tip: "Custom products use their own unit — after production tops the stock up, “Record Sale” sells them exactly like egg trays.",
        },
        {
          name: "Sell eggs or birds",
          steps: [
            "Click “Record Sale” on this tab.",
            "Pick the product from live stock (it shows quantity available and price).",
            "Enter the Quantity — the total price and the stock-left figure show before you commit.",
            "Add the customer name/phone and payment method (Cash, MTN MoMo…).",
            "Submit — stock drops, revenue rises, and a receipt is issued automatically.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I add a new product type?",
          match: ["new product", "add product", "product type", "master", "custom"],
          answer:
            "Log Production → Production Type → “＋ Add New Product Type…”. Name it, set unit and prices, enter the quantity and submit — it is saved to the Master Product List and becomes sellable stock linked across Production, Inventory, Sales and Reports.",
        },
        {
          q: "Where do my eggs go after I log them?",
          match: ["where", "eggs go", "stock", "inventory"],
          answer:
            "Production → stock is automatic: every 30 good eggs become 1 sellable tray in the Inventory tab. Sales then deduct from that stock, so you can never sell eggs you do not have.",
        },
        {
          q: "Can I sell straight from the farm gate?",
          match: ["farm gate", "direct", "immediately"],
          answer:
            "Yes — the fastest way is “Record Sale” on the Production tab. It deducts the trays or birds from live stock and books the income in one step.",
        },
      ],
    },
    INVENTORY: {
      title: "Farm Inventory",
      intro:
        "Everything sellable or consumable at {biz}: egg trays, dressed birds and feed materials, with live quantities and values.",
      tasks: [
        {
          name: "Understand the stock table",
          steps: [
            "QTY is what is physically on hand right now — sales and production change it automatically.",
            "STATUS colours: green IN_STOCK, amber LOW_STOCK (below its threshold), red OUT_OF_STOCK.",
            "STOCK VALUE shows what this row is worth at selling price.",
          ],
        },
        {
          name: "Top up stock",
          steps: [
            "Egg and bird stock grows from the Production tab — log collections or harvests there.",
            "Feed and material quantities grow when you log purchases (Feed tab, Entry Type “Purchase”).",
          ],
        },
      ],
      faqs: [
        {
          q: "Why did a number change by itself?",
          match: ["changed", "itself", "automatic", "drop"],
          answer:
            "Stock only moves when you record something: a sale (-), an egg collection (+trays), a harvest (+birds) or a feed purchase (+kg). Nothing changes without a matching record you can open in Finance.",
        },
      ],
    },
    FINANCE: {
      title: "Farm Finance",
      intro:
        "The money story of {biz}: every sale, every expense, profit or loss — shared live with the enterprise Transactions module.",
      tasks: [
        {
          name: "Record a daily expense",
          steps: [
            "Click “Record Daily Expense”.",
            "Choose the Expense Category (feed, labour, medication…) — or click “+ Add New” to create one.",
            "Enter the Amount (GH₵), payment method and a short description.",
            "You can attach receipt photos as proof, then press “Record Expense”.",
            "The expense appears in the records table and in the enterprise finance view immediately.",
          ],
        },
        {
          name: "Read the finance view",
          steps: [
            "Income rows come from your sales; expense rows from what you logged — newest on top.",
            "Net profit = income minus expenses, shown on the dashboard card and the Finance summary.",
          ],
        },
      ],
      faqs: [
        {
          q: "Do expenses I enter reach Head Office?",
          match: ["head office", "shared", "enterprise", "report"],
          answer:
            "Yes — every expense recorded here is written to the shared Transactions & MoMo module with your branch tagged, so enterprise reports include it automatically.",
        },
      ],
    },
    CHECKLIST: {
      title: "Daily Farm Checklist",
      intro:
        "The poultry morning routine for {biz}: water and feed checks, egg collection, house hygiene, health observation and closing counts.",
      tasks: CHECKLIST_TASKS,
      faqs: CHECKLIST_FAQS,
    },
    AI_KNOWLEDGE: {
      title: "Poultry AI Knowledge",
      intro:
        "A built-in poultry expert for {biz}: ask anything about layers, broilers, feed, diseases or housing and get a practical answer from the knowledge library.",
      tasks: [
        {
          name: "Ask a question",
          steps: [
            "Type your question in plain words — for example “why are my hens eating but laying less?”.",
            "Or choose a category first (feed, health, housing…) to narrow the search.",
            "Read the answer card: it gives the likely causes and the fix in simple steps.",
          ],
        },
      ],
      faqs: [
        {
          q: "What can I ask?",
          match: ["what", "ask", "examples"],
          answer:
            "Anything practical: vaccination schedules for Ghana, feed formulas, heat-stress signs, egg-drop causes, broiler weights by week, biosecurity basics. The library answers in plain language.",
        },
      ],
    },
  },

  /* ════════════════════════ BLOCK FACTORY ════════════════════════ */
  BLOCK: {
    DASHBOARD: {
      title: "Block Factory Dashboard",
      intro:
        "The control room of {biz}: block production, moulded vs broken, raw materials (cement, sand, water), sales, orders and cashflow — live.",
      tasks: [
        {
          name: "Record a production batch",
          steps: [
            "Click the blue “Production” button at the top.",
            "Choose the Block Type (e.g. 6-INCH-SOLID) — or add a new type from the same list.",
            "Enter Bags of Cement Used and Blocks Molded (plus Blocks Broken, if any).",
            "The preview line shows exactly how many good blocks will enter stock — confirm to save.",
            "Stock rises instantly and the batch appears under Recent Production Batches.",
          ],
          tip: "Only good blocks (molded minus broken) enter stock — record breakage honestly to keep quality grades truthful.",
        },
        {
          name: "Sell blocks",
          steps: [
            "Click “Sale” and pick the product — finished block types come first in the list.",
            "Enter the quantity; the total and the stock-left preview show before you save.",
            "Choose the payment method (Cash, MTN MoMo…) and submit — stock and revenue update together.",
          ],
        },
        {
          name: "Track orders & deliveries",
          steps: [
            "“Order” books a customer's request (type, quantity, price, due date) without touching stock yet.",
            "“Delivery” records the truck-out against stock so quantities fall only when blocks actually leave the yard.",
          ],
        },
      ],
      faqs: [
        {
          q: "How does production fill my stock?",
          match: ["production", "stock", "blocks", "molded", "moulded"],
          answer:
            "Every block type is linked to exactly one stock item. When you record production, good blocks (molded − broken) are added to that item — the preview in the form shows the before/after quantities.",
        },
        {
          q: "Where do I add a new block type?",
          match: ["new type", "add type", "4 inch", "interlocking"],
          answer:
            "Open Production or Restock and choose “➕ Add New Block Type…” in the Block Type list. Name it (e.g. 4-Inch Solid), set dimensions and price — it joins the Block Production Master List and gets its own stock row.",
        },
      ],
    },
    INVENTORY: {
      title: "Factory Inventory",
      intro:
        "All stock at {biz}: finished blocks by type and raw materials (cement, sand, water), with live values and low-stock warnings.",
      tasks: [
        {
          name: "Receive stock (Restock)",
          steps: [
            "Click “Restock” (top) or the “Restock” button on a product's row.",
            "The “Stock To Receive” list is the Block Production Master List: pick a block type or any raw material.",
            "Enter the Quantity and Unit Cost — the total shows immediately.",
            "Confirm; the purchase is added to stock, and can be booked as an expense in the same step.",
          ],
          tip: "Restocking a block type treats it as blocks bought from outside; prefer the Production button for blocks you moulded yourself.",
        },
        {
          name: "Add a brand-new item",
          steps: [
            "Click “New Item”, fill the name, category, quantity, cost and selling price.",
            "Save — it joins the stock table and becomes sellable in the Sale form.",
          ],
        },
        {
          name: "Read stock health",
          steps: [
            "The four cards up top count stock items, total units, cost value and low/out-of-stock rows.",
            "“Low / Out of Stock” above zero means restock before the yard runs dry — those rows glow amber or red in the table.",
          ],
        },
      ],
      faqs: [
        {
          q: "Cement keeps running out — what do I do?",
          match: ["cement", "sand", "raw", "material", "run out"],
          answer:
            "Use Restock → Portland Cement 50kg Bag each time bags arrive, and set its low-stock threshold realistically. The amber LOW_STOCK status and the Command Center alert then warn you days before a stock-out.",
        },
      ],
    },
    FINANCE: {
      title: "Factory Finance",
      intro:
        "Sales income versus expenses for {biz} — every cedi in or out, linked to the enterprise ledger.",
      tasks: [
        {
          name: "Record a sale or payment",
          steps: [
            "Click “Record Sale / Payment”.",
            "Pick the product from live stock, enter quantity and price.",
            "Choose payment method and submit — stock, revenue and the receipt are handled together.",
          ],
        },
        {
          name: "Record an expense",
          steps: [
            "Click “Record Expense”.",
            "Type the Category (Fuel & Diesel, Cement Purchase, Payroll… — suggestions appear as you type).",
            "Enter Amount (GH₵), payment method and date, then save — it lands in the expense table and the shared ledger.",
          ],
        },
      ],
      faqs: [
        {
          q: "Does restocking count as an expense?",
          match: ["restock", "purchase", "expense"],
          answer:
            "Only if you let it: the Restock form can book the purchase as an expense in one click. Otherwise use “Purchase Stock” / “Record Expense” here so finance stays exact.",
        },
      ],
    },
    CHECKLIST: {
      title: "Daily Factory Checklist",
      intro:
        "The daily yard routine for {biz}: machine checks, material stock verification, curing-yard watering, safety and production targets.",
      tasks: CHECKLIST_TASKS,
      faqs: CHECKLIST_FAQS,
    },
    QC: {
      title: "Quality Control (QC)",
      intro:
        "Proof that blocks from {biz} meet the Ghana standard before a single one is sold: checks at raw materials, mixing, production and curing, then full finished-block testing — weight, dimensions, density, cracks, surface, defects and compressive strength — with Pass/Fail, photos and batch links.",
      tasks: [
        {
          name: "Check raw materials (cement, sand, water)",
          steps: [
            "Open Quality Control → “+ Record QC Check” and tap the RAW MATERIALS stage chip.",
            "Pick the test (e.g. “Cement freshness”, “Sand silt content”, “Water purity”).",
            "Read the suggested standard chip (e.g. “Sand silt content ≤ 6%”) — tap it to fill the Required Standard box.",
            "Do the check on site: squeeze a cement handful (fresh = powdery, no lumps), or put sand in a bottle with water, shake and let it settle — the silt layer on top must be ≤ 6% of the sand height.",
            "Enter the Test Result, mark PASS or FAIL, add notes/photo and save.",
          ],
          tip: "Failing cement or silty sand is the #1 cause of weak blocks — reject the material before it reaches the mixer, never QC it after moulding.",
        },
        {
          name: "Check the mix",
          steps: [
            "Choose the MIXING stage and the test “Mix ratio”.",
            "The standard for most blocks is 1:6 (one bag cement to six wheelbarrows sand) — richer for solid/load-bearing.",
            "Watch the mix: uniform colour, no dry pockets; a squeezed ball should hold together without crumbling or dripping.",
            "Record result + verdict; a FAIL here means remix before moulding.",
          ],
        },
        {
          name: "Record a curing check",
          steps: [
            "Choose CURING, enter the Curing Day number (blocks need at least 7 moist days).",
            "Standard: blocks kept damp (sprinkle morning + evening) and shaded from harsh sun/rain.",
            "PASS only if the stack is actually moist — curing decides up to half the final strength.",
          ],
        },
        {
          name: "Test a finished block (weight, size, strength)",
          steps: [
            "Choose FINISHED BLOCK and pick the production batch — the block type fills in automatically.",
            "Weigh 3–5 blocks on the scale, enter the Average Weight (kg).",
            "Measure Length × Width × Height in mm — the app computes Density for you.",
            "Count visible Cracks and other Defects, grade the Surface (Good/Fair/Poor).",
            "Enter Compressive Strength (MPa) from the crush-test machine if you have one — the standard is ≥ 3.5 MPa for load-bearing blocks (GS 1193).",
            "The app suggests PASS/FAIL from your numbers; confirm or override, add a photo of the sample as evidence, then save.",
          ],
          tip: "Sample at least one check per batch per day of moulding — 3 to 5 blocks is a good sample for a yard batch.",
        },
        {
          name: "Read the QC dashboard",
          steps: [
            "The chips on top summarise the selected scope: checks done, pass rate, passed/failed batches, defect rate, rejected blocks, average strength and weight variation.",
            "Every production batch shows its pipeline: Production → Curing → QC → Inventory → Sales — a FAILED batch is flagged HOLD so it is not sold.",
            "Filter by Branch, Batch, Block Type, Date or Tester to answer “what happened on this batch?”.",
            "The red/amber Alerts strip calls out failed checks, batches with no QC, and strength below standard — handle those first.",
          ],
        },
        {
          name: "Handle a failed batch",
          steps: [
            "A FAIL marks the batch FAILED in the pipeline panel — keep it in the yard, do not deliver it.",
            "Use “Rejected Blocks” on the check to count how many pieces are condemned.",
            "Recheck after re-curing or remoulding: record a new FINISHED BLOCK check; if it now passes, the batch returns to PASSED.",
          ],
        },
      ],
      faqs: [
        {
          q: "What strength must blocks have?",
          match: ["strength", "mpa", "compressive", "crush", "standard", "gs 1193", "gs1193"],
          answer:
            "For load-bearing concrete blocks the Ghana standard (GS 1193, aligned to BS 6073) expects at least 3.5 MPa average compressive strength after 28 days of curing. Non-load-bearing blocks may target 2.8 MPa. Enter the machine reading in the Compressive Strength field and the app compares it automatically.",
        },
        {
          q: "How many blocks should I test per batch?",
          match: ["sample", "how many", "number", "test per"],
          answer:
            "Sample 3–5 blocks per batch per day of moulding, taken from different parts of the stack. Record their average on one check — the Sample box is where you note “3 blocks from east stack”.",
        },
        {
          q: "How do I calculate density?",
          match: ["density", "kg/m3", "kgm3"],
          answer:
            "You don't — enter weight (kg) and the three dimensions (mm) and the app computes kg/m³ for you. Solid blocks typically run 1,800–2,100 kg/m³; hollow blocks less. Very low density points to poor compaction or a weak mix.",
        },
        {
          q: "What if a batch fails QC?",
          match: ["fail", "failed", "reject", "rejected", "hold"],
          answer:
            "The batch flips to FAILED on the pipeline panel and a HOLD alert appears so staff don't sell or deliver it. Count condemned pieces in Rejected Blocks, fix the cause (mix, compaction, curing), and test again — a fresh PASS returns the batch to saleable.",
        },
        {
          q: "How long must blocks cure?",
          match: ["cure", "curing", "days", "watering"],
          answer:
            "At least 7 days kept moist (sprinkle twice daily) and shaded; try not to sell before 14 days, and full design strength arrives around 28 days. Log a CURING check each day you water so the batch pipeline shows CURING ✓.",
        },
        {
          q: "Can I attach a photo?",
          match: ["photo", "picture", "image", "evidence", "camera"],
          answer:
            "Yes — in the Record QC Check form tap “Add Photo Evidence” and pick or take a photo. It is compressed and stored inside GoMina 360 with the check, and appears in the Recent QC Checks table.",
        },
      ],
    },
  },

  /* ════════════════════════ ELECTRONICS SHOP ════════════════════════ */
  TECH: {
    DASHBOARD: {
      title: "Shop Dashboard",
      intro:
        "The trading picture of {biz}: today's sales, open orders, warranty exposure and stock value for phones, inverters and accessories.",
      tasks: [
        {
          name: "Sell a device",
          steps: [
            "Click “Record Sale”.",
            "Pick the product from live stock — quantity available and price are shown in the list.",
            "Enter the quantity, confirm the total, add the customer and payment method.",
            "Submit — stock drops and the sale posts to finance with a receipt.",
          ],
        },
        {
          name: "Read the cards",
          steps: [
            "Revenue and profit cards summarise the period; low-stock and warranty cards flag what needs attention.",
            "Click any tab above (Products, Orders, Warranty & Serials) to act on what you see.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I sell something not in stock?",
          match: ["not in stock", "no stock", "unavailable"],
          answer:
            "You cannot sell what is not in stock — the sale picker only lists available items. Take a deposit instead with “Create Customer Order” on the Orders tab, then restock.",
        },
      ],
    },
    PRODUCTS: {
      title: "Products & Stock",
      intro:
        "The shop's catalogue and shelf: every phone, inverter and accessory at {biz} with quantities, prices and status.",
      tasks: [
        {
          name: "Add a new product",
          steps: [
            "Click “Add Inventory Product”.",
            "Fill the name (brand + model), category, quantity, cost and selling price.",
            "Save — the product becomes sellable in the Record Sale form immediately.",
          ],
        },
        {
          name: "Keep shelves honest",
          steps: [
            "Quantities fall automatically with each sale; nothing should be edited by hand.",
            "Amber LOW_STOCK rows mean reorder via the Orders tab before you stock out.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I restock a phone model?",
          match: ["restock", "reorder", "more stock"],
          answer:
            "Go to Orders & Purchases and record a supplier purchase — when the items are received, quantities rise here automatically and the purchase posts to finance.",
        },
      ],
    },
    ORDERS: {
      title: "Orders & Purchases",
      intro:
        "Customer orders and supplier purchases for {biz}: deposits taken, deliveries fulfilled, stock received.",
      tasks: [
        {
          name: "Take a customer order",
          steps: [
            "Click “Create Customer Order”.",
            "Enter the customer, the product, quantity and agreed price, plus a due date.",
            "Save — it shows as Open until you deliver.",
            "When you fulfil/deliver the order, stock is deducted automatically and the sale is finalised.",
          ],
        },
        {
          name: "Receive supplier stock",
          steps: [
            "Record the purchase on this tab with the items and their total cost.",
            "Receiving it tops up your Products & Stock quantities and books the expense to finance in one flow.",
          ],
        },
      ],
      faqs: [
        {
          q: "When does stock actually move?",
          match: ["when", "stock move", "deliver", "fulfil"],
          answer:
            "Stock moves at fulfilment time: taking the order only reserves the customer promise; delivering it deducts the items and books revenue. Supplier purchases top stock up when received.",
        },
      ],
    },
    SERVICE: {
      title: "Warranty & Serials",
      intro:
        "The anti-counterfeit and after-sales register of {biz}: serial numbers sold, warranty periods and returns.",
      tasks: [
        {
          name: "Register a serial",
          steps: [
            "Use the serial registration form on this tab.",
            "Enter the Serial Number, product name, brand, warranty months and retail price.",
            "Save — the unit joins the registry with its coverage period.",
          ],
        },
        {
          name: "Handle a warranty claim or return",
          steps: [
            "Find the unit by its serial in the registry.",
            "Log the claim against it so the service history stays attached to that exact device.",
          ],
        },
      ],
      faqs: [
        {
          q: "Why register serials?",
          match: ["why", "serial", "counterfeit"],
          answer:
            "Serials prove a device is genuine and track its warranty window. When a customer returns, you instantly see what they bought, for how much, and whether coverage is still valid.",
        },
      ],
    },
    STAFF: {
      title: "Staff & Operations",
      intro: "Who works at {biz} and the shop's operating notes in one place.",
      tasks: [
        {
          name: "Review staffing",
          steps: [
            "The staff list shows everyone assigned to this branch with their role.",
            "Staff changes themselves are made centrally in Employees & Payroll (shared enterprise module).",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I add a worker?",
          match: ["add", "worker", "staff"],
          answer:
            "Workers are created under Employees & Payroll (enterprise module). Once assigned to this branch and given a login, they see the worker workspace for this shop.",
        },
      ],
    },
    CHECKLIST: {
      title: "Daily Shop Checklist",
      intro:
        "Opening and closing routine for {biz}: display stock counts, MoMo float, generator/inverter check, security and cleanliness.",
      tasks: CHECKLIST_TASKS,
      faqs: CHECKLIST_FAQS,
    },
  },

  /* ════════════════════════ RESTAURANT & KITCHEN ════════════════════════ */
  FOOD: {
    DASHBOARD: {
      title: "Kitchen Dashboard",
      intro:
        "Today's service at {biz}: sales, top dishes, kitchen order rail, food-cost % and waste — the restaurant at a glance.",
      tasks: [
        {
          name: "Run the day from here",
          steps: [
            "Glance at revenue, orders and top dishes to plan prep quantities.",
            "Watch the Kitchen Order Status rail: move tickets along as orders cook and serve.",
            "At close, the Log Daily Shift entry (Staff tab) seals the day.",
          ],
        },
      ],
      faqs: [
        {
          q: "What is food cost %?",
          match: ["food cost", "percent", "cost %"],
          answer:
            "Food cost % = ingredient cost ÷ sales. Logged purchases and waste feed it; keeping it near ~30% means the kitchen is pricing and portioning well.",
        },
      ],
    },
    MENU: {
      title: "Menu Performance",
      intro:
        "Every dish sold at {biz}: price, popularity and performance — your guide on what to cook more of.",
      tasks: [
        {
          name: "Add a dish",
          steps: [
            "Click “Add Menu Dish”.",
            "Enter the dish name, category and price, then save.",
            "The dish appears in the sale/order picker instantly.",
          ],
        },
        {
          name: "Use performance data",
          steps: [
            "Sort by orders to see stars and slow movers.",
            "Push stars with staff, re-price or retire dishes that never sell.",
          ],
        },
      ],
      faqs: [
        {
          q: "Is the menu the same as stock?",
          match: ["stock", "inventory", "same"],
          answer:
            "No — the Menu is what you sell; Stock, Cost & Waste is what you cook with. Selling plates deducts the plate/product stock rows; ingredient top-ups happen through Purchases.",
        },
      ],
    },
    STOCK: {
      title: "Stock, Cost & Waste",
      intro:
        "Ingredients and sellable plates at {biz}: quantities, unit costs and the waste diary that protects your margins.",
      tasks: [
        {
          name: "Log food waste",
          steps: [
            "Click “Log Food Waste”.",
            "Choose the item, enter the quantity wasted and the reason (spoiled, over-production…).",
            "Save — the quantity is written off stock and the cedi value is tracked against food cost.",
          ],
        },
        {
          name: "Top up ingredients",
          steps: [
            "Ingredients arrive through the Purchases tab — receiving a purchase adds quantities here automatically.",
          ],
        },
      ],
      faqs: [
        {
          q: "Why log waste instead of just selling?",
          match: ["waste", "spoil", "why"],
          answer:
            "Waste is where restaurant profit leaks. Logging it keeps stock honest AND shows you the weekly cedi value of spoilage, so menus and prep quantities can be fixed.",
        },
      ],
    },
    ORDERS: {
      title: "Sales & Orders",
      intro:
        "The live ticket rail of {biz}: dine-in, takeaway and delivery orders from booking to serving, plus counter sales.",
      tasks: [
        {
          name: "Take an order / make a sale",
          steps: [
            "Start a new order or sale on this tab (dish/product, quantity, customer if known).",
            "The ticket joins the Kitchen Order Status rail as ORDERED.",
            "Advance it as it cooks and serves; completing it deducts stock and books the payment (Cash / MTN MoMo).",
          ],
        },
      ],
      faqs: [
        {
          q: "The rail is full of old tickets — what now?",
          match: ["old", "ticket", "rail", "clear"],
          answer:
            "Tickets waiting mean orders never closed. Open each and advance or complete it so stock and sales stay truthful.",
        },
      ],
    },
    PURCHASES: {
      title: "Purchases & Suppliers",
      intro:
        "Every ingredient purchase for {biz}: what was bought, from whom, at what cost — stock and expense booked in one step.",
      tasks: [
        {
          name: "Book a supplier purchase",
          steps: [
            "Start a new purchase on this tab.",
            "Enter the item bought, quantity and total cost (e.g. 25kg Jasmine rice — GH₵380).",
            "Save & receive — ingredient stock rises and the expense posts to finance linked to this purchase.",
          ],
        },
      ],
      faqs: [
        {
          q: "Does a purchase change my stock?",
          match: ["stock", "change", "receive"],
          answer:
            "Yes — receiving a purchase tops up the matching ingredient in Stock, Cost & Waste and books its cost as an expense at the same time, keeping kitchen and ledger in sync.",
        },
      ],
    },
    STAFF: {
      title: "Staff & Daily Shift",
      intro:
        "The shift diary of {biz}: orders served, best dish, food cost, waste and MoMo-vs-cash split — plus the daily checklist.",
      tasks: [
        {
          name: "Log the daily shift",
          steps: [
            "Click “Log Daily Shift”.",
            "Enter Total Orders served and the Most Popular Dish.",
            "Add Food Cost % and Waste % for the day.",
            "Enter MoMo receipts and Cash receipts (GH₵), then save — the shift joins the restaurant logbook and finance updates.",
          ],
        },
        {
          name: "Use the checklist",
          steps: CHECKLIST_TASKS[0].steps,
        },
      ],
      faqs: [
        {
          q: "Who fills the shift log?",
          match: ["who", "shift", "when"],
          answer:
            "The shift leader at closing time — it takes under a minute and gives the Owner a daily restaurants report without phone calls.",
        },
      ],
    },
  },

  /* ════════════════════════ AQUACULTURE ════════════════════════ */
  AQUA: {
    DASHBOARD: {
      title: "Fish Farm Dashboard",
      intro:
        "The farm overview of {biz}: ponds, fish batches, feed and FCR, water quality and harvest readiness in one screen.",
      tasks: [
        {
          name: "Start the farm in three moves",
          steps: [
            "Create your pond/cage/tank (Ponds tab → Add New Pond).",
            "Stock a batch (Fish Stock & Batches) with species, quantity and average weight.",
            "Feed daily (Feed tab → Log Feed) — the dashboard fills with growth and FCR from then on.",
          ],
        },
      ],
      faqs: [
        {
          q: "What is FCR?",
          match: ["fcr", "conversion"],
          answer:
            "Feed Conversion Ratio = kg of feed ÷ kg of fish growth. Around 1.3–1.6 is good for tilapia. The dashboard trends it from your feed and harvest entries — no maths needed.",
        },
      ],
    },
    STOCK: {
      title: "Fish Stock & Batches",
      intro:
        "Every group of fish at {biz}: species, fingerling count, average weight and which pond they live in.",
      tasks: [
        {
          name: "Stock a new batch",
          steps: [
            "Open the new-batch form on this tab.",
            "Enter the species (e.g. VOLTA_TILAPIA), quantity stocked, average weight and the pond.",
            "Save — the batch begins tracking growth and feeding.",
          ],
        },
      ],
      faqs: [
        {
          q: "When is a batch ready?",
          match: ["ready", "harvest", "weight"],
          answer:
            "Tilapia table size is ~600–800 g. Watch average weight on this tab; when a batch crosses your target, record it on the Harvest tab.",
        },
      ],
    },
    PONDS: {
      title: "Ponds / Tanks / Cages",
      intro: "The physical units of {biz}: each pond, tank or river cage with its capacity and status.",
      tasks: [
        {
          name: "Add a pond",
          steps: [
            "Click “Add New Pond”.",
            "Give it an ID/name (e.g. CAGE-01), type and capacity.",
            "Save — it becomes available when stocking batches and logging water quality.",
          ],
        },
      ],
      faqs: [
        { q: "Pond or cage?", match: ["pond", "cage", "tank", "which"], answer: "Use whatever physically holds the water: earthen pond, concrete/plastic tank, or river/lake cage. The type label just keeps your records clear — all features work the same." },
      ],
    },
    FEED: {
      title: "Feed Management",
      intro: "Daily feeding for {biz}: what each pond ate, at what cost — the raw material of your FCR.",
      tasks: [
        {
          name: "Log a feeding",
          steps: [
            "Click “Log Feed”.",
            "Pick the pond/batch and feed type, enter kg fed and cost.",
            "Submit — feed totals, cost and FCR update on the dashboard.",
          ],
        },
      ],
      faqs: [
        {
          q: "How much should I feed?",
          match: ["how much", "quantity", "rate"],
          answer: "Grow-out tilapia eat roughly 2–3% of their body weight daily, split morning/afternoon. As average weight rises (Stock tab), raise the ration — the FCR trend tells you if you are wasting feed.",
        },
      ],
    },
    WATER: {
      title: "Water Quality",
      intro: "pH and dissolved-oxygen readings per pond — the invisible lifeline of {biz}.",
      tasks: [
        {
          name: "Log today's readings",
          steps: [
            "Open the water form on this tab.",
            "Choose the pond, enter pH (safe: 6.5–8.5) and dissolved oxygen in mg/L (safe above 5).",
            "Save — readings outside the safe band raise alerts on the dashboard.",
          ],
        },
      ],
      faqs: [
        {
          q: "Oxygen is low — what do I do?",
          match: ["oxygen", "low", "do", "aerator"],
          answer: "Run aerators immediately and stop feeding for the day. Log the reading and the corrective action so tomorrow's comparison is honest.",
        },
      ],
    },
    HEALTH: {
      title: "Tasks & Activities",
      intro: "The work log of {biz}: pond cleaning, net repairs, treatments and any daily activity with its cost.",
      tasks: [
        {
          name: "Log an activity",
          steps: [
            "Start a new task/activity entry on this tab.",
            "Choose the type, the pond if relevant, and note the work done and any cost.",
            "Save — costs flow into finance, and the activity trail builds the farm's maintenance history.",
          ],
        },
      ],
      faqs: CHECKLIST_FAQS,
    },
    HARVEST: {
      title: "Harvest Status & Sales",
      intro: "From pond to cash at {biz}: record harvests, watch the harvest & revenue trend, and sell fish from stock.",
      tasks: [
        {
          name: "Record a harvest",
          steps: [
            "Open the harvest form on this tab.",
            "Pick the pond/batch, enter total weight harvested (kg) and date.",
            "Save — fresh fish (per Kg) is stocked into Inventory, ready for sale.",
          ],
        },
        {
          name: "Sell fish",
          steps: [
            "Use the sale action, pick the fish item from live stock, enter kg and price.",
            "Submit — stock drops and revenue posts with a receipt.",
          ],
        },
      ],
      faqs: [
        {
          q: "Partial harvests allowed?",
          match: ["partial", "some", "half"],
          answer: "Yes — harvest what you sell today. Each entry adds its kg to stock and the batch keeps tracking the remainder.",
        },
      ],
    },
    FINANCE: {
      title: "Farm Finance",
      intro: "Money in and out for {biz}: fish sales, feed purchases and farm expenses, shared with the enterprise ledger.",
      tasks: [
        {
          name: "Record an expense",
          steps: [
            "Use the expense action on this tab.",
            "Category (feed, fingerlings, labour…), amount, payment method, description.",
            "Save — it posts to finance instantly.",
          ],
        },
      ],
      faqs: [
        { q: "Where do I see profit?", match: ["profit", "loss"], answer: "Income minus expenses is shown on this tab and on the dashboard's profit card — it updates live with every sale or expense." },
      ],
    },
  },

  /* ═════════════════ SPECIALIZED OPS (CAR WASH / LIVESTOCK) ═════════════════ */
  WASH: {
    DASHBOARD: {
      title: "Auto Car Wash Dashboard",
      intro:
        "The trading picture of {biz}: today's sales, vehicles served, active washes, bookings, payments, expenses and profit — everything updates itself as jobs complete.",
      tasks: [
        {
          name: "Start a wash (drive-in)",
          steps: [
            "Click the cyan “New Wash” button (top right).",
            "Enter the customer and vehicle, pick the service from the menu — its price fills in automatically — and optionally assign a staff member.",
            "Save — the job lands in the Active Washes queue as IN_PROGRESS.",
            "When the job is done, pick the payment method and press “✓ Complete & Charge”.",
          ],
          tip: "Completing a wash is the magic moment: the payment posts to Finance, the service's chemicals are drawn from stock, the customer's record is updated and the booking (if any) closes — all at once.",
        },
        {
          name: "Read the cards",
          steps: [
            "Daily Sales, Vehicles Today, Active Washes and Bookings summarise right now; Profit Today nets today's expenses.",
            "The payments card splits Cash / MoMo / Card; the trend chart shows the last 7 days of sales vs expenses.",
            "Amber alerts appear for low supplies, overdue bookings and stalled washes.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I charge for a wash?",
          match: ["charge", "take payment", "complete", "finish"],
          answer:
            "Open Active Washes, choose the payment method on the job's row and press “✓ Complete & Charge” — the sale posts to Finance instantly, chemicals come out of stock, and the customer accrues spend and loyalty points.",
        },
        {
          q: "Where does the money go?",
          match: ["revenue", "money", "finance"],
          answer:
            "Every completed job posts into Transactions tagged to this branch — it counts in branch profit, the Command Center and every export.",
        },
      ],
    },
    SERVICES: {
      title: "Services & Pricing",
      intro:
        "The service menu of {biz}: wash packages, detailing, waxing, polishing, interior & exterior cleaning plus any custom offer — each with its own price, duration, included items and chemical usage.",
      tasks: [
        {
          name: "Add a service",
          steps: [
            "Click “New Service” (or the emerald Service button up top).",
            "Give it a name, category, price and duration, and list the items the offer includes (e.g. shampoo, wax, tyre shine).",
            "Optionally link a chemical from stock and the liters used per job — it then deducts itself automatically at completion.",
            "Save — the offer becomes bookable immediately.",
          ],
        },
        {
          name: "Edit or pause a service",
          steps: [
            "Click “Edit” on any row to change price, contents or chemical usage.",
            "Use “Deactivate” to hide an offer without losing its history; “Activate” brings it back.",
          ],
        },
      ],
      faqs: [
        {
          q: "What items should a service list?",
          match: ["includes", "items", "detergent", "shampoo", "offer"],
          answer:
            "Put what the customer receives in “Includes items” (e.g. foam shampoo, wax coat, dashboard polish) — it shows on the menu card. Separately, link the chemical drum and liters per job so stock falls automatically when the service is performed.",
        },
        {
          q: "How are prices used?",
          match: ["price", "pricing", "cost"],
          answer:
            "The service price pre-fills every new wash and booking — you can still override it per job for discounts; the job's own price is what posts to Finance.",
        },
      ],
    },
    BOOKINGS: {
      title: "Bookings",
      intro:
        "Appointments for {biz}: who is coming, when, for which service and with which staff member — one click checks them into the wash queue.",
      tasks: [
        {
          name: "Take a booking",
          steps: [
            "Click “New Booking”.",
            "Enter the customer, vehicle, service, date and time slot; optionally reserve a staff member.",
            "Save — the booking shows as BOOKED until the customer arrives.",
          ],
        },
        {
          name: "Check in an arrival",
          steps: [
            "Press “Check In → Wash” on the booking row.",
            "The job opens in Active Washes with every detail pre-filled from the booking.",
          ],
          tip: "When the wash completes, the booking closes itself to COMPLETED — you never update it twice.",
        },
      ],
      faqs: [
        {
          q: "A customer didn't show up?",
          match: ["no-show", "cancel", "didn't come"],
          answer:
            "Press “Cancel” on the booking — it stays in history as CANCELLED, never charges anything, and alerts clear automatically.",
        },
      ],
    },
    WASHES: {
      title: "Active Washes",
      intro:
        "The live work queue of {biz}: every job in the bays right now, plus the full wash history — completed jobs with their charges.",
      tasks: [
        {
          name: "Complete and charge a job",
          steps: [
            "Find the job in the Active Washes table.",
            "Pick the payment method (Cash, MTN MoMo, Telecel Cash, POS Card or Bank Transfer).",
            "Press “✓ Complete & Charge” — payment posts to Finance, chemicals draw from stock, the customer is credited, and the job moves to history.",
          ],
        },
        {
          name: "Void a job",
          steps: [
            "Press “Void” only for jobs that never happened (wrong entry).",
            "Nothing is charged and no stock moves — the row is kept as CANCELLED for audit.",
          ],
        },
      ],
      faqs: [
        {
          q: "When does stock actually move?",
          match: ["when", "stock move", "chemical"],
          answer:
            "Stock moves at completion: starting a wash only opens the job; completing it draws the service's configured liters from the chemical drum and books the payment in the same step.",
        },
        {
          q: "Reverse a completed job?",
          match: ["reverse", "refund", "undo"],
          answer:
            "Completed jobs are final (they have posted revenue). Record a correcting expense instead, and the reports stay truthful.",
        },
      ],
    },
    STOCK: {
      title: "Stock & Supplies",
      intro:
        "Every consumable of {biz}: the chemical drums, their remaining liters, reorder levels — and exactly which services consume them.",
      tasks: [
        {
          name: "Read the board",
          steps: [
            "“≈ Usable Volume” converts drums into liters so you can see real capacity.",
            "The “Used By Services” column lists each service that draws from the item, with liters per job.",
          ],
        },
        {
          name: "Restock",
          steps: [
            "Supplies are managed from the shared Inventory & Stock module — add a new drum there and it appears here.",
            "Low-stock and out-of-stock alarms also surface on the Dashboard alerts strip.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do services use stock?",
          match: ["usage", "liters", "draw", "consume"],
          answer:
            "Each service can link a chemical item and a liters-per-figure — completing a job draws exactly that amount (liters ÷ drum size) and the status flips to LOW/OUT automatically when thresholds hit.",
        },
      ],
    },
    STAFF: {
      title: "Staff",
      intro:
        "The team at {biz}: who works here, what each person has washed, and the revenue they have handled. Access is managed by the Owner.",
      tasks: [
        {
          name: "Build the performance board",
          steps: [
            "Assign staff on bookings or washes — every completed job credits the assigned person.",
            "The table ranks jobs done and revenue handled per staff member automatically.",
          ],
        },
      ],
      faqs: [
        {
          q: "Who can add staff?",
          match: ["add staff", "access", "manage"],
          answer:
            "Employee records come from the shared Employees module, and user accounts/roles for this branch are managed exclusively by the OWNER from the user directory — this module only consumes them.",
        },
      ],
    },
    REPORTS: {
      title: "Finance & Reports",
      intro:
        "The numbers of {biz}: revenue, expenses, profit and margin, payment mix, per-service performance, customer value and the complete audit-grade activity log.",
      tasks: [
        {
          name: "Read the financials",
          steps: [
            "Revenue, Expenses and Net Profit summarise the whole period; the bar chart compares the last 7 days.",
            "Income and expense tables list every posting with method and category; everything is exportable from the shared Export Center.",
          ],
        },
      ],
      faqs: [
        {
          q: "Where do expenses come from?",
          match: ["expense", "spend", "cost"],
          answer:
            "Use the rose “Expense” button (or “+ Log expense” here) for water bills, detergents, wages and so on — each entry posts an EXPENSE transaction immediately and flows into profit and reports.",
        },
      ],
    },
    CHECKLIST: COMMON.CHECKLIST,
    FINANCE_REPORT: COMMON.FINANCE_REPORT,
    DEFAULT: {
      title: "Auto Car Wash",
      intro:
        "The full wash operating system of {biz}: customers, vehicles, services, bookings, the wash queue, staff, payments, stock, expenses, profit and reports — one linked machine.",
      tasks: COMMON.DEFAULT.tasks,
      faqs: COMMON.DEFAULT.faqs,
    },
  },

  TELECOM: {
    DASHBOARD: {
      title: "Telecom & Digital Services Dashboard",
      intro:
        "The trading picture of {biz}: today's MoMo turnover, commissions & margins, float and cash per till, failed transactions to chase, Wi-Fi vouchers in stock and users online — everything updates itself as the desk sells.",
      tasks: [
        {
          name: "Take a MoMo deposit or withdrawal",
          steps: [
            "Click the yellow “MoMo Txn” button (top right).",
            "Choose Deposit (cash in) or Withdrawal (cash out), pick the agent till, enter the customer, amount and the commission you earn.",
            "Save — float and cash move on the till automatically and the commission posts to Finance as income.",
            "If the network fails, record it again with outcome “Failed” and the reason — failed txns move no money and are listed for follow-up.",
          ],
          tip: "Deposits need enough float; withdrawals need enough cash in the till. The desk blocks the txn before it can fail at the network.",
        },
        {
          name: "Sell a Wi-Fi voucher",
          steps: [
            "Open Wi-Fi & Vouchers, find an AVAILABLE voucher card and press “Sell & Activate”.",
            "Enter the user's name and payment method — the voucher activates immediately and its expiry starts counting.",
            "Hand the customer the code, the 6-digit access PIN, or let them scan the QR card to connect.",
          ],
          tip: "Run low on stock? Press “+ Vouchers” on any package to print a fresh batch with codes, PINs and QR cards in one go.",
        },
        {
          name: "Top up float or cash on a till",
          steps: [
            "On the Dashboard (or MoMo tab) find the line card and press “Top-up”.",
            "Pick Float or Cash, choose Top up / Draw down, enter the amount and save.",
            "Balances update instantly and the movement is logged in the activity feed — never double-counted as profit.",
          ],
        },
      ],
      faqs: [
        {
          q: "How is profit calculated?",
          match: ["profit", "earn", "margin"],
          answer:
            "Profit = income − expenses from the shared Finance ledger. Income is MoMo commissions, airtime/data margins (retail minus wholesale cost from float), service fees and Wi-Fi voucher sales; expenses are wholesale top-up costs and logged branch expenses.",
        },
        {
          q: "What happens with failed transactions?",
          match: ["failed", "fail", "declined", "network issue"],
          answer:
            "Record them with outcome “Failed” and the reason. They never move float, cash or Finance — they appear in the red failed counts and tables so you can re-attempt and reconcile with the network.",
        },
        {
          q: "How do vouchers and expiry work?",
          match: ["voucher", "expiry", "expire", "wifi code", "access code"],
          answer:
            "Generate batches per package (code + 6-digit PIN + QR card each). A voucher is AVAILABLE until sold; selling activates it and starts the package duration; when time runs out it is marked EXPIRED automatically. Staff can mark USED when the user connects, or REVOKE a voucher.",
        },
        {
          q: "Where do customer records come from?",
          match: ["customer"],
          answer:
            "The first time someone buys — MoMo, airtime, data or Wi-Fi — their record is created (or matched by phone) in the shared Customers directory and their spend and loyalty points grow with every successful transaction.",
        },
      ],
    },
    DEFAULT: {
      title: "Telecom & Digital Services",
      intro:
        "The complete MoMo / airtime / data / Wi-Fi desk for {biz}: agent lines with float & cash, transactions with commissions and failed-txn tracking, Wi-Fi packages, vouchers, QR codes, access PINs, users, expiry, sales, finance, customers and reports — all linked automatically.",
      tasks: COMMON.DEFAULT.tasks,
      faqs: COMMON.DEFAULT.faqs,
    },
  },

  HARDWARE: {
    DASHBOARD: {
      title: "Hardware Store Dashboard",
      intro:
        "The trading picture of {biz}: material sales, open contractor orders, supplier purchases, site deliveries and stock value for the whole yard.",
      tasks: [
        {
          name: "Sell materials at the counter",
          steps: [
            "Click the amber “Sale” button (top right).",
            "Pick the material from live stock — available quantity and price are shown in the list.",
            "Enter the quantity, confirm the total, add the customer and payment method.",
            "Submit — stock drops immediately and the sale posts to Finance with a receipt.",
          ],
          tip: "Counter sales, delivered orders and goods receipts all update this dashboard the moment you save.",
        },
        {
          name: "Read the cards",
          steps: [
            "Revenue and Net Profit summarise the period; Orders, Deliveries Out and SKU Stock flag today's workload.",
            "Low or out-of-stock materials raise amber alerts above the cards.",
            "Click any tab (Stock, Orders, Deliveries, Staff & Yard Ops) to act on what you see.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I sell something not in stock?",
          match: ["not in stock", "no stock", "unavailable", "out of stock"],
          answer:
            "You cannot sell what is not in stock — the sale picker only lists available items. Take the customer's order on the Orders tab instead, then restock and deliver it.",
        },
        {
          q: "Where does the money go?",
          match: ["revenue", "money", "finance"],
          answer:
            "Every sale posts straight into Transactions tagged to this branch — it counts in the branch profit, the Command Center and every export.",
        },
        {
          q: "How do I restock materials?",
          match: ["restock", "reorder", "more stock"],
          answer:
            "Open the Orders & Purchases tab and record a supplier purchase (or log a Goods-Received Note on Staff & Yard Ops) — when the goods are received, stock quantities rise automatically and the cost posts to Finance in one flow.",
        },
      ],
    },
    STOCK: {
      title: "Stock & Materials",
      intro:
        "The full materials catalogue of {biz}: cement, steel, roofing, paint, plumbing and more — with quantities, prices, margins and live status.",
      tasks: [
        {
          name: "Add a new material",
          steps: [
            "Click “New Material”.",
            "Fill the name, category (cement, steel, roofing…), quantity, unit, cost and selling price.",
            "Save — it becomes sellable in the Sale form immediately.",
          ],
        },
        {
          name: "Keep stock honest",
          steps: [
            "Quantities fall automatically with each sale or outgoing site delivery; receipts add them back.",
            "Amber LOW_STOCK rows mean reorder via a supplier purchase before you stock out.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I restock cement?",
          match: ["restock", "reorder", "more stock"],
          answer:
            "Open Orders & Purchases and record a supplier purchase (or log a GRN on Staff & Yard Ops) — when the goods are received, quantities rise here automatically and the cost posts to Finance in one flow.",
        },
      ],
    },
    ORDERS: {
      title: "Orders & Purchases",
      intro:
        "Contractor and customer material orders on one side, supplier restock purchases on the other — the heartbeat of {biz}.",
      tasks: [
        {
          name: "Take a customer order",
          steps: [
            "Click “New Order”.",
            "Enter the customer, the material, quantity, agreed price, due date and delivery site.",
            "Save — it shows as PENDING until you fulfil it.",
            "Advance it to READY, then DELIVERED: delivering deducts the stock and books the revenue automatically.",
            "Click “Track” on any order row to open its live timeline — placed, ready, delivered — with customer, site and date stamps.",
          ],
        },
        {
          name: "Restock from a supplier",
          steps: [
            "Click “Record Purchase” and pick the supplier, material, quantity and unit cost.",
            "Leave it ORDERED while the truck is on the way.",
            "Switch it to RECEIVED when goods land — stock rises and the expense posts to Finance in one step.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I track a customer order?",
          match: ["track order", "track an order", "order status", "where is my order", "order progress"],
          answer:
            "Click the “Track” button on any order row — the timeline shows exactly when it was placed, when it became ready for pickup or dispatch, and when it was delivered, with the customer details and due date alongside. Delivering is the moment stock drops and revenue books.",
        },
        {
          q: "When does stock actually move?",
          match: ["when", "stock move", "deliver", "fulfil"],
          answer:
            "Stock moves at fulfilment time: taking the order only records the customer promise; delivering it deducts the materials and books revenue. Purchases top stock up the moment they are received.",
        },
      ],
    },
    DELIVERIES: {
      title: "Site Deliveries",
      intro:
        "The dispatch board of {biz}: every truck leaving the yard for a construction site, from scheduled to delivered.",
      tasks: [
        {
          name: "Dispatch a delivery",
          steps: [
            "Click “Schedule Delivery”.",
            "Enter the customer and site address, pick the material and quantity, add the driver and vehicle number.",
            "Save as SCHEDULED, then advance EN_ROUTE and DELIVERED as the truck moves.",
            "Click “Track” on any dispatch row to follow its timeline — scheduled, en route, delivered — with driver, vehicle and site details.",
          ],
          tip: "A standalone delivery deducts stock when it completes. If the delivery is linked to a customer order, the order's own fulfilment handles stock — never both.",
        },
      ],
      faqs: [
        {
          q: "How do I track a delivery?",
          match: ["track delivery", "track a delivery", "delivery status", "where is the truck", "delivery progress"],
          answer:
            "Click the “Track” button on the dispatch row — the timeline shows when it was scheduled, when the truck left the yard (en route) and when the materials landed on site, including driver, vehicle and the linked customer order if there is one. Trucks en route over 2 days also flag amber on this tab and the dashboard.",
        },
        {
          q: "A truck is overdue?",
          match: ["late", "overdue", "en route"],
          answer:
            "Deliveries en route for more than 2 days raise an amber warning on this tab and on the dashboard — call the driver and update the customer before site work stalls.",
        },
      ],
    },
    YARD_OPS: {
      title: "Staff & Yard Ops",
      intro:
        "People and goods-in for {biz}: staff sales performance, branch assets, and the Goods-Received ledger that proves what physically entered the yard.",
      tasks: [
        {
          name: "Log a goods receipt (GRN)",
          steps: [
            "Click “Log Goods Receipt” (or the cyan GRN button in the header).",
            "Enter the supplier, material, quantity received, unit cost and condition.",
            "Save — the matching stock item is topped up (or created) and the landed cost books to Finance as an expense.",
          ],
        },
        {
          name: "Track staff performance",
          steps: [
            "The Staff Performance table ranks each person by sales value, receipts handled and expenses logged.",
            "Figures come from the recorded-by stamp on every transaction — no manual reporting needed.",
          ],
        },
      ],
      faqs: [
        {
          q: "Goods arrived damaged?",
          match: ["damaged", "broken", "partial"],
          answer:
            "Log the GRN with condition DAMAGED or PARTIAL and the true usable quantity, then raise it with the supplier. Repeated damage in 30 days triggers a warning in the AI Insights card.",
        },
      ],
    },
    FINANCE_REPORT: COMMON.FINANCE_REPORT,
    DEFAULT: {
      title: "Hardware & Building Materials",
      intro:
        "The complete operating workspace of {biz}: counter sales, contractor orders, supplier restocking, site deliveries and the goods-received ledger — all wired into stock and finance.",
      tasks: CHECKLIST_TASKS,
      faqs: [],
    },
  },
  LIVESTOCK: {
    OPERATIONS: {
      title: "Livestock Operations",
      intro:
        "The herd diary of {biz}: every animal record — weight, vaccination, pregnancy — logged once and tracked forever.",
      tasks: [
        {
          name: "Log an animal record",
          steps: [
            "Click “Log Daily Operations”.",
            "Enter the Tag Number, Animal Type (CATTLE, GOAT…), Breed and Weight (kg).",
            "Set Vaccination Status; tick Pregnant if applicable.",
            "Save — the record joins this unit's own logbook and today counters.",
          ],
        },
        {
          name: "Track the herd",
          steps: [
            "Read the logbook newest-first; rising weights mean healthy growth.",
            "Vaccination gaps are the first thing to fix — log them the day the vet visits.",
          ],
        },
        {
          name: "Run the daily checklist",
          steps: CHECKLIST_TASKS[0].steps,
        },
      ],
      faqs: [
        {
          q: "How do I sell an animal or meat?",
          match: ["sell", "sale", "meat", "beef"],
          answer:
            "Sell from your stock items (e.g. Fresh Beef per Kg) through the sale form — stock drops and revenue posts to finance with a receipt, just like any product.",
        },
      ],
    },
  },

  /* ════════════ GENERIC AUTO-PROVISIONED UNIT (OTHER TYPES) ════════════ */
  GENERIC: {
    DASHBOARD: {
      title: "Business Dashboard",
      intro:
        "Your command page for {biz}: revenue, expenses, profit, stock value, alerts and quick links — all fed by the Activity Log and sales you record here.",
      tasks: [
        {
          name: "Understand what is already set up",
          steps: [
            "Your business was auto-provisioned: a starter stock kit was funded from your initial capital (see the banner and the Inventory tab).",
            "The KPI cards show revenue, expenses, profit and stock value — they rise with every sale and restock you record.",
            "The Alerts card watches low stock and missing routines for you.",
          ],
        },
        {
          name: "Make your first sale",
          steps: [
            "Click “Sale”.",
            "Pick a product from live stock, enter quantity, customer and payment method.",
            "Submit — stock drops, revenue rises and a receipt is issued.",
          ],
        },
      ],
      faqs: [
        {
          q: "What is the starter kit?",
          match: ["starter", "kit", "already", "setup"],
          answer:
            "When this unit was created, GoMina stocked it with sensible opening products for its type and booked their cost against initial capital. Restock or add your own items any time in Inventory.",
        },
      ],
    },
    INVENTORY: {
      title: "Business Inventory",
      intro: "Live stock for {biz}: starter kit plus anything you add — quantities, prices, values and low-stock status.",
      tasks: [
        {
          name: "Restock a product",
          steps: [
            "Click “Restock” (or the button on the product's row).",
            "Enter the quantity received and unit cost — totals preview before saving.",
            "Confirm; stock rises and the purchase can book to expenses in the same step.",
          ],
        },
        {
          name: "Sell from stock",
          steps: [
            "Use the Sale action, pick the product — only in-stock items appear.",
            "Quantity, total and stock-left preview show before you commit.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do I add a completely new product?",
          match: ["new", "add", "product"],
          answer: "Use the unit's Operations panel or Inventory actions to add an item with its price and quantity — it becomes sellable immediately across the unit.",
        },
      ],
    },
    FINANCE: {
      title: "Business Finance",
      intro: "Income, expenses and profit for {biz} — recorded here, visible everywhere.",
      tasks: [
        {
          name: "Record an expense",
          steps: [
            "Click the expense action.",
            "Enter category, amount, payment method and a short description.",
            "Save — it posts to the finance table and the enterprise ledger at once.",
          ],
        },
      ],
      faqs: [
        { q: "Where do sales show?", match: ["sale", "income", "show"], answer: "The income table lists every sale with its receipt reference; the profit card nets income against expenses live." },
      ],
    },
    CHECKLIST: {
      title: "Daily Checklist",
      intro: "The daily routine for {biz} — created from your business type and tracked by Head Office.",
      tasks: CHECKLIST_TASKS,
      faqs: CHECKLIST_FAQS,
    },
  },

  /* ═══════════════ SHARED ENTERPRISE MODULES ═══════════════ */
  SHARED: {
    CUSTOMERS: {
      title: "Customers & CRM",
      intro: "Every buyer across all GoMina businesses — with lifetime spend, loyalty points and contact details in one directory.",
      tasks: [
        {
          name: "Add a customer",
          steps: [
            "Click “Add New Customer”.",
            "Enter the name, phone and any notes (company, location).",
            "Save — the customer becomes selectable in every sale form across the group.",
          ],
        },
        {
          name: "Use the CRM data",
          steps: [
            "Total Spent and loyalty points grow automatically whenever that customer buys at any branch.",
            "Search by name or phone to find a customer's history instantly.",
          ],
        },
      ],
      faqs: [
        {
          q: "Are customers shared between businesses?",
          match: ["shared", "other", "branch"],
          answer: "Yes — one registry for the whole group. A customer created at any branch can buy everywhere, and their spend and loyalty total across all seven-plus businesses.",
        },
      ],
    },
    SUPPLIERS: {
      title: "Suppliers & Vendors",
      intro: "Everyone you buy from — feed mills, cement distributors, importers — with payment terms and reliability notes.",
      tasks: [
        {
          name: "Add a supplier",
          steps: [
            "Click “Add Supplier”.",
            "Enter the company, contact and what they supply (category).",
            "Save — purchases and payables can now be tagged to them.",
          ],
        },
      ],
      faqs: [
        { q: "Who can edit or delete records here?", match: ["delete", "edit", "permission", "who", "remove", "manage"], answer: "The OWNER always can. Managers only when the OWNER has granted them record-management permission via “Manage Access”. Deleting asks for a reason and is permanently logged in the Deletion Audit Trail at the bottom of this page with the user, date and time." },
        { q: "Why register suppliers?", match: ["why", "purpose"], answer: "Tagging purchases to suppliers shows pricing trends and reliability per vendor — and keeps the Purchases sections in the business modules tidy." },
      ],
    },
    EMPLOYEES: {
      title: "Employees & Payroll",
      intro: "The group's complete HR desk: full employee registration (personal info, photo, work schedule & leave entitlement, ID & compliance), document vault, record history — all linked to Business → Branch → Payroll → Attendance → Reports.",
      tasks: [
        {
          name: "Register an employee (full record)",
          steps: [
            "Click “Add Employee” — the Employee Registration form opens.",
            "Personal: full name, employee ID (auto-generated if blank), date of birth, gender, phone, email, address, emergency contact — plus a photo from upload or the live camera capture.",
            "Work & attendance: schedule, shift, hours per day, assigned working days and annual leave entitlement.",
            "Identity: ID type & number and work permit where applicable, then save — registration is written to the record history.",
          ],
        },
        {
          name: "Open an employee profile",
          steps: [
            "Click the person icon on any row to open the profile.",
            "The linkage strip shows their Business, Branch, Payroll entries & net pay, Attendance rows & overtime, leave used vs entitlement, and history count.",
            "The Overview tab holds every field; Edit record reopens the registration form for authorized users.",
          ],
        },
        {
          name: "File documents & track history",
          steps: [
            "Profile → Documents: file the employment contract, certificates, qualifications, work permit or ID scans (image/PDF, downloadable).",
            "Profile → Record history: an immutable trail of every important change — registration, field edits (old → new), photo updates, document add/remove, each stamped with who and when.",
          ],
        },
      ],
      faqs: [
        { q: "Who can edit or delete records here?", match: ["delete", "edit", "permission", "who", "remove", "manage"], answer: "The OWNER always can. Managers only when the OWNER has granted them record-management permission via “Manage Access”. Deleting asks for a reason and is permanently logged in the Deletion Audit Trail at the bottom of this page with the user, date and time." },
        { q: "Where does an employee record appear?", match: ["payroll", "attendance", "link", "report", "business", "branch"], answer: "Everywhere, automatically: Payroll runs pick ACTIVE employees up with their basic salary, business and branch; attendance & overtime recorded in the Payroll Center rolls onto their profile linkage strip (entries, net pay, rows, OT hours, leave used); payroll reports aggregate the same numbers; the record history keeps the full audit trail of changes to their file." },
        { q: "How do photos and documents work?", match: ["photo", "camera", "document", "contract", "certificate", "permit", "upload"], answer: "The registration form takes a photo either by upload or live camera capture (resized automatically). Contracts, certificates, qualifications, work permits and ID scans are filed on the profile's Documents tab as images or PDFs — downloadable anytime, and every addition/removal is written to the record history." },
        { q: "Worker vs Branch Manager?", match: ["role", "worker", "manager"], answer: "WORKERs record sales and expenses in their own branch only; BRANCH_MANAGERs also manage workers, assets and branch registers. Owners/GMs see everything." },
      ],
    },
    ASSETS: {
      title: "Assets & Machinery",
      intro: "The group's asset register: machines, vehicles, cages and equipment with purchase cost, current value and maintenance notes.",
      tasks: [
        {
          name: "Register an asset",
          steps: [
            "Click “Register Asset” — or “Scan QR” if the asset already carries a tag.",
            "Enter the name, category, branch, purchase cost and date.",
            "Save — it starts depreciating on schedule, appears in branch reports, and gets a printable QR identity label.",
          ],
        },
        {
          name: "Download a filtered register",
          steps: [
            "Click “Filters”, narrow by branch or category, then download.",
            "The export matches what you filtered — handy for insurance or audits.",
          ],
        },
      ],
      faqs: [
        { q: "How is current value computed?", match: ["value", "depreciation"], answer: "Assets depreciate from purchase cost over their useful life; the register shows both figures so balance-sheet values stay realistic." },
      ],
    },
    INVENTORY: {
      title: "Enterprise Inventory",
      intro: "Every stock item in every GoMina business on one screen — the group-wide shelf with branch tags and statuses.",
      tasks: [
        {
          name: "Add a stock item",
          steps: [
            "Click “Add Stock Item” — or scan the item's QR code first.",
            "Choose the owning business, then name, category, quantity, cost and selling price.",
            "Save — it appears in that business's stock and sale pickers instantly, with a printable QR label.",
          ],
        },
        {
          name: "Scan or find by QR code",
          steps: [
            "Click “Scan QR” in the header and point the camera at the tag (or type the code).",
            "Known codes open the item record; new codes start a guided registration already linked to the right business and branch.",
          ],
        },
        {
          name: "Read the group shelf",
          steps: [
            "Filter by business to focus on one branch, or scan statuses for group-wide low stock.",
            "Quantities here are the same live numbers the business modules show — sales update them in real time.",
          ],
        },
      ],
      faqs: [
        { q: "Why two inventory screens?", match: ["two", "difference", "module"], answer: "Each business module manages its own stock day-to-day; this enterprise view exists for Head Office to compare and audit all branches at once." },
      ],
    },
    TRANSACTIONS: {
      title: "Transactions & MoMo",
      intro: "The complete money ledger of the group: every sale, expense and transfer with branch, method (Cash, MTN MoMo…) and recorder.",
      tasks: [
        {
          name: "Record a transaction",
          steps: [
            "Click “New Transaction”.",
            "Choose INCOME or EXPENSE, the business/branch, category and amount (GH₵).",
            "Pick the payment method, add a description and save.",
          ],
        },
        {
          name: "Find anything fast",
          steps: [
            "Filter by business, type or method, and search the description.",
            "Every module across the app writes here — this is the audit trail Head Office trusts.",
          ],
        },
      ],
      faqs: [
        { q: "Who can edit or delete records here?", match: ["delete", "edit", "permission", "who", "remove", "manage"], answer: "The OWNER always can. Managers only when the OWNER has granted them record-management permission via “Manage Access”. Deleting asks for a reason and is permanently logged in the Deletion Audit Trail at the bottom of this page with the user, date and time." },
        { q: "Is MoMo separated from cash?", match: ["momo", "cash", "method"], answer: "Yes — each transaction carries its method, so MoMo vs cash vs bank totals can be reconciled separately at close of day." },
      ],
    },
    FINANCE: CENTRAL_FINANCE_GUIDE,
    FINANCE_REPORT: CENTRAL_FINANCE_GUIDE,
  },

  /* ═══════════════ INTEGRATION HUB → CCTV ═══════════════ */
  CCTV: {
    DEFAULT: {
      title: "CCTV Security Command",
      intro:
        "Every camera in the group, organised strictly as Business → Branch → Cameras. Register IP cameras, PTZ units, Wi-Fi cameras and full NVR/DVR systems with their brand, model and connection details; test connections, reassign or retire units — and control exactly which managers may touch which branches.",
      tasks: [
        {
          name: "Add a camera",
          steps: [
            "Open Integration Hub and click “CCTV Security Command Center”.",
            "Click “Add Camera”, pick the owning Business, and confirm the Branch code (auto-filled).",
            "Enter the camera name, physical location, brand, camera type and model.",
            "Fill in the connection details (see “Connect…” below) and save — the card appears under that branch instantly.",
          ],
        },
        {
          name: "Connect IP cameras, NVRs & DVRs",
          steps: [
            "Choose the connection type: PoE + RTSP, ONVIF, Wi-Fi, Cloud P2P, Coax/BNC, or an NVR/DVR channel.",
            "For IP cameras (Hikvision, Dahua, Uniview, Axis, Reolink, VIGI…) enter the camera IP and port (usually 554) or paste the full RTSP stream URL.",
            "For NVR/DVR systems register the recorder itself (host + port, e.g. 37777 for Dahua) — its channels inherit the same endpoint.",
            "Device username/password are stored securely and never displayed again — a ✓ marker shows credentials are saved.",
          ],
        },
        {
          name: "Test a connection",
          steps: [
            "Click “Test” on any camera card you manage.",
            "The hub performs a handshake against the stored stream URL or host:port and reports the result on the card.",
            "A passing test flips the camera ONLINE with the verified timestamp; a failing one lists exactly which detail is missing.",
          ],
        },
        {
          name: "Update or reassign a camera",
          steps: [
            "Click “Edit” on the camera card.",
            "Change any field — name, location, brand, model, connection details, or status (Online / Offline / Maintenance).",
            "To move a camera to another business or branch, change the Business/branch fields — the record, its test history and permissions follow automatically.",
          ],
          tip: "Managers can only reassign cameras between branches they are authorised for; the OWNER can move anything anywhere.",
        },
        {
          name: "Troubleshoot an OFFLINE camera",
          steps: [
            "Run “Test” — the result message tells you what is missing (stream URL, host/IP or port).",
            "Verify the camera has power and network (PoE switch link light, or Wi-Fi signal), then confirm the IP/port in Edit.",
            "Use Status = Maintenance while a unit is being serviced so dashboards stop flagging it as a fault.",
            "If the camera moved subnets, update the host field and test again.",
          ],
        },
        {
          name: "Remove a camera & grant a manager CCTV access",
          steps: [
            "To remove: click “Remove”, then confirm. The card disappears from the branch immediately.",
            "To share the workload: the OWNER opens Users & Access, edits the manager and switches on “Manage CCTV cameras”.",
            "That manager can now add, test, edit and remove cameras — but only inside the businesses/branches they already have access to. The OWNER always keeps control of every camera.",
          ],
        },
      ],
      faqs: [
        { q: "Which brands and systems are supported?", match: ["brand", "hikvision", "dahua", "uniview", "axis", "reolink", "support"], answer: "Any of them. Built-in choices cover Hikvision, Dahua, Uniview, Axis, Reolink, TP-Link VIGI, EZVIZ and Annke — plus “Other / Generic” for anything else. Standalone IP/PTZ/Wi-Fi cameras and full NVR or DVR systems (or individual recorder channels) are all first-class." },
        { q: "My camera test failed — what now?", match: ["test", "failed", "offline", "connect", "troubleshoot"], answer: "The failure message names the missing piece. You need either a full stream URL (rtsp://…) or a host/IP plus port. Check power and network on the device, update the fields under Edit, then Test again." },
        { q: "Who can add or remove cameras?", match: ["permission", "who", "manager", "delete", "remove", "access"], answer: "The OWNER manages every camera in every branch. A manager manages cameras only after the OWNER switches on “Manage CCTV cameras” in Users & Access — and only for businesses/branches already in that manager's access scope." },
        { q: "Are device passwords visible to everyone?", match: ["password", "credential", "secret", "visible"], answer: "No. Passwords are write-only: they are stored for the connection handshake but never returned to any screen. Cards show a ✓ marker when a credential is on file; re-enter it in Edit only when changing it." },
      ],
    },
  },

  /* ═══════════════ EMPLOYEES → PAYROLL COMMAND CENTER ═══════════════ */
  AUDIT: {
    DEFAULT: {
      title: "Supervisor & Auditor Control Center",
      intro:
        "Oversight for the whole group: review the records workers already keep — daily checklists, operations & production logs, sales & finance, inventory, employees, payroll, attendance, assets and CCTV — without creating any duplicate checklists. Verify what is right, flag what is wrong (incomplete tasks included), comment, request corrections and attach photo evidence. Flagged issues travel the pipeline Flagged → Under Review → Correction Required → Resolved → Verified and are routed automatically to the assigned user's dashboard; every step — who, when, why, with what evidence — is on the issue thread and the immutable audit trail. The OWNER controls every Auditor permission; authorized managers may manage Auditor access for their own branches; auditors see only what they are authorized to audit.",
      tasks: [
        {
          name: "Review a record end-to-end",
          steps: [
            "Open Audit & Review from the sidebar (Oversight & Assurance).",
            "Use the filters to narrow by Business, Branch, Worker, activity/module, date range or review status.",
            "Find the record, then choose an action: Verify (confirm it is right), Flag (raise an issue), Request Correction, or Comment.",
            "Give a reason for flags and corrections — it is required — and attach evidence (photo link, receipt number, note).",
            "The record's review state updates immediately and the action lands on the Audit Log with your name and timestamp.",
          ],
        },
        {
          name: "Work an issue through the pipeline",
          steps: [
            "Open the Issues tab — every flag and correction request across your scope shows its pipeline status, the assigned user, the linked record and full history.",
            "When you flag or request a correction (reason required, photo evidence supported), the issue is routed to the assigned user's bell & My Audit Issues inbox automatically.",
            "The assigned user responds with notes/photos and sends it back (Under Review) or marks the correction complete (Resolved) — you are notified.",
            "Open Review response & verify: satisfied → Verify & close (terminal); not satisfied → Request correction to send it back to their dashboard.",
            "Filter by pipeline stage: Flagged, Under Review, Correction Required, Resolved or Verified.",
          ],
        },
        {
          name: "Respond to issues assigned to you",
          steps: [
            "Watch the bell in the top bar (and the red strip on your dashboard) — flagged issues and correction requests assigned to you arrive there instantly.",
            "Open My Audit Issues from the notification or the strip; each issue stays linked to the original checklist, activity or record.",
            "Write your response, attach photo or document evidence, then choose Respond & mark for review or Correction complete — mark resolved.",
            "The auditor is notified; watch for the Verified & closed confirmation when they accept it.",
          ],
        },
        {
          name: "Read the oversight reports",
          steps: [
            "Open Reports & Charts for the performance, compliance and discrepancy picture.",
            "Compliance shows what share of records per module has been reviewed; the trend chart tracks review throughput over the last 6 months.",
            "Financial discrepancies lists open flags/corrections on money records with the amounts at risk, totaled at the top.",
            "Reviewer performance shows each supervisor/auditor's verifications, flags, corrections and resolutions.",
            "Export the full register with Reviews CSV.",
          ],
        },
        {
          name: "Manage auditor access (OWNER / delegated managers)",
          steps: [
            "Open the Auditor Access tab (visible only if you may manage auditors).",
            "Pick an existing user, the business they may audit and the exact modules (Operations, Finance, Inventory, Employees, Payroll, Attendance, Assets, CCTV) — optionally one branch only.",
            "Save; re-saving the same user+business updates the grant. Revoke switches access off immediately.",
            "The OWNER additionally toggles which managers may manage Auditor access under Manager delegation — those managers can only grant within their own assigned branches.",
            "Every grant, update, revocation and delegation flip is written to the Audit Log.",
          ],
        },
      ],
      faqs: [
        {
          q: "How does the issue lifecycle work?",
          match: ["lifecycle", "status", "pipeline", "flagged", "under review", "resolved", "verified", "close"],
          answer: "Every issue travels: Flagged (auditor raises it) → Under Review (the assigned user responded with notes/photos and sent it back) → Correction Required (auditor sent it back for fixes) → Resolved (assigned user completed the correction) → Verified (auditor reviewed the response and closed it — terminal). Each step notifies the other side's bell and is written to the issue thread and the audit trail.",
        },
        {
          q: "What happens when I flag a checklist task or a worker's record?",
          match: ["flag", "route", "notify", "assigned", "dashboard", "worker", "incomplete task"],
          answer: "The issue is automatically routed to the user responsible for that record: it lands on their notification bell and in My Audit Issues on their dashboard, linked to the original checklist or activity. They respond with a note and photo evidence, then either send it back for review or mark the correction complete — and you get notified to verify & close it.",
        },
        {
          q: "Who can see the Audit Center?",
          match: ["who can see", "access", "auditor see", "permission"],
          answer: "The OWNER sees everything. General Managers, Branch Managers and Supervisors act as supervisors inside their accessible businesses. Any other user appears only after being granted Auditor access — and then they see strictly the businesses and modules in their grants. Workers without a grant never see the tab, but they still receive issues assigned to them via the bell and My Audit Issues.",
        },
        {
          q: "How are auditor permissions controlled?",
          match: ["grants", "revoke", "owner control", "delegate", "manage auditor"],
          answer: "Only the OWNER sets Auditor access — which user, which business, which modules, optionally which branch — directly or by authorizing a manager to manage Auditor access for their own branches. Grants can be updated or revoked at any time and every change is logged with the actor and timestamp.",
        },
        {
          q: "Does auditing change or duplicate worker records?",
          match: ["duplicate", "change records", "workflow", "checklist"],
          answer: "Never. Reviews attach to the existing transactions, stock items, employees, payroll runs, attendance rows, daily checklist completions, assets, cameras and production logs. Workers keep their exact workflows; the Control Center only layers verification, flags, comments, correction requests and evidence on top, with a full audit trail.",
        },
      ],
    },
  },

  PAYROLL: {
    DEFAULT: {
      title: "Payroll Command Center",
      intro:
        "The group's complete payroll desk: employees' base salaries, allowances, overtime and deductions roll into monthly runs that move DRAFT → REVIEWED → APPROVED → PAID. Paying posts real expense transactions, so every payment updates Transactions, the Financial Reports and each business dashboard automatically.",
      tasks: [
        {
          name: "Run payroll end-to-end",
          steps: [
            "Open the Employees & Payroll module and click “Payroll Center”, then “New Payroll Run”.",
            "Pick the business and month — a draft is built for every ACTIVE employee with base salary plus the month's overtime pulled from attendance.",
            "Expand the run, adjust allowances/deductions where needed, then click “Mark Reviewed” → “Approve”.",
            "Click “Pay All” (or the wallet icon on one entry), choose Cash, MTN MoMo, Bank Transfer or Other — done: net pay is recorded in the ledger instantly.",
          ],
        },
        {
          name: "Track attendance, leave & overtime",
          steps: [
            "Open the Attendance & OT tab and pick an employee, date and status (Present, Half day, Absent, Leave, Off day).",
            "Enter working hours and any overtime hours; Leave rows carry a leave type (Annual, Sick, Maternity, Unpaid).",
            "Overtime hours saved here are added automatically to that employee's next payroll run at 1.5× the hourly rate (monthly salary ÷ 208).",
          ],
        },
        {
          name: "Read paid vs outstanding",
          steps: [
            "The KPI strip shows Total Net Pay, Paid Out and Outstanding Payroll for the selected business (or all).",
            "Inside a run, each employee row shows base, allowances, overtime, deductions and net with PENDING/PAID status.",
            "Use the business filter at the top to isolate one branch's wage bill.",
          ],
        },
        {
          name: "Print payslips & export reports",
          steps: [
            "Expand a run and click the document icon on any employee row to open the payslip — it shows gross pay, every employee deduction (SSNIT, PAYE, others), net pay and the employer's own contributions — print or save it as PDF.",
            "The Reports & Charts tab shows the monthly payroll trend, cost composition, paid-vs-outstanding per business and the statutory remittance summary (SSNIT EE+ER, Tier-2, PAYE due per month).",
            "Download the payroll register per run or combined as CSV, PDF or Excel — with full statutory columns and ledger references for audits.",
          ],
        },
        {
          name: "Keep statutory rates up to date",
          steps: [
            "Open the Statutory Settings tab (OWNER, or a manager with record-management permission).",
            "Adjust SSNIT Tier-1 employee/employer percentages, the Tier-2 pension rate and who bears it, edit the PAYE monthly bands, or add other statutory contributions/levies.",
            "Save — new runs use the new rates immediately; click “Recalculate with current statutory rates” on any open (unpaid) run to re-apply them there. Paid entries never change.",
          ],
        },
      ],
      faqs: [
        { q: "Who can approve and pay payroll?", match: ["permission", "who", "approve", "manager", "owner"], answer: "The OWNER always can. A manager (General/Branch) can run, review, approve and pay payroll only after the OWNER grants them record-management permission in Users & Access — and only for businesses inside their access scope. Workers have no payroll access." },
        { q: "Where does a payment go after I pay?", match: ["finance", "transaction", "report", "update", "ledger"], answer: "Each payment creates a completed EXPENSE transaction (category “Staff Payroll”) against the employee's business and branch with the method used. Transactions & MoMo, the central Financial Report, business dashboards, payroll trends — everywhere updates immediately." },
        { q: "How is overtime calculated?", match: ["overtime", "ot", "rate", "hourly"], answer: "Hourly rate = monthly base salary ÷ 208 (26 days × 8 hours). Overtime is paid at 1.5× that rate. Hours recorded in the Attendance & OT tab for the payroll month flow into the run automatically when it is created." },
        { q: "Can a paid run be changed?", match: ["paid", "edit", "change", "delete", "vvoid", "reverse"], answer: "Paid entries and paid runs are locked for audit. Draft runs can be discarded entirely; an APPROVED run cannot be deleted — revert it by editing entries before payment, or leave it for the record." },
        { q: "How are SSNIT, PAYE and net pay calculated?", match: ["ssnit", "paye", "tax", "statutory", "net", "deduction", "tier"], answer: "Gross = basic + allowances + overtime. Employee SSNIT = the configured % of basic (default 5.5%) and is deducted before tax; PAYE applies the configured progressive monthly bands to the taxable income (gross − employee SSNIT and any employee-borne pension/levies); net = gross − (SSNIT + PAYE + other deductions). The employer's own SSNIT share (default 13%) and Tier-2 pension show separately as employer contributions — they never come out of the employee's pay." },
        { q: "Can I change statutory rates when regulations change?", match: ["rate", "regulation", "setting", "config", "update ssnit", "band", "levy", "editable"], answer: "Yes — the OWNER (or a manager with record-management permission) opens Payroll Center → Statutory Settings and edits SSNIT percentages, the Tier-2 rate and bearer, the PAYE bands, and can add other statutory contributions with their own %, base (basic/gross) and bearer. New runs and recalculated open runs use the saved configuration; paid entries are never recomputed." },
        { q: "How do I adjust one employee's salary or deductions?", match: ["adjust", "manual", "override", "basic salary", "correct"], answer: "Expand the run and click the pencil icon on the employee's row (OWNER/authorized managers only, and only before payment). You can change basic salary, allowances, other deductions, overtime hours or switch statutory deductions off for that entry — the modal previews gross → deductions → net live, and saving recomputes everything with the current statutory configuration." },
      ],
    },
  },

  /* ═══════════════ COMMAND CENTER / ROLES ═══════════════ */
  COMMAND_CENTER: {
    COMMAND_CENTER: {
      title: "Enterprise Command Center",
      intro:
        "360° headquarters: every business unit's revenue, profit, ROI, stock alerts and checklist compliance on one executive screen.",
      tasks: [
        {
          name: "Open any business",
          steps: [
            "Click a unit in the left sidebar list, or its row on this page.",
            "You land inside that unit's own full module — use the same sidebar to jump back.",
          ],
        },
        {
          name: "Create a new branch / unit",
          steps: [
            "Click “New Branch / Unit”.",
            "Enter the name, pick the business type, set the region/district/town and the manager.",
            "Set initial capital and monthly target, then Create.",
            "The unit gets the exact same module as the original of its type, a starter stock kit and its checklists — and opens ready for work.",
          ],
        },
        {
          name: "Watch group risk in seconds",
          steps: [
            "The stock-alerts strip lists every low/out-of-stock item across the group.",
            "The checklist compliance column shows which branches ran their morning routine.",
            "“Export / Audit” (top right) downloads any unit's full report.",
          ],
        },
        {
          name: "Manage any business unit (Owner)",
          steps: [
            "Click “Manage Units” (Owner only) to open the management console.",
            "Use the pencil to edit: rename, change location, change business type, change manager, targets or status.",
            "Use the power button to deactivate a unit — it is flagged INACTIVE everywhere but keeps ALL its data; click again to re-activate.",
            "Use the trash button to permanently delete — you must type the unit code to confirm, and every related record (stock, sales, orders, finance, checklists) is removed.",
            "Every change updates inventory, sales, finance, dashboards and reports automatically.",
          ],
        },
      ],
      faqs: [
        {
          q: "Where do the numbers come from?",
          match: ["number", "from", "source"],
          answer: "Every figure is the sum of the units' own recorded activity (sales, restocks, expenses, checklists). Head Office never types totals — the branches generate them.",
        },
        {
          q: "How do I add another business?",
          match: ["add", "new", "business", "branch"],
          answer: "“New Branch / Unit” — pick its type and it receives the same dashboard and features as the original business of that type, automatically provisioned and linked.",
        },
        {
          q: "How do I edit, rename, deactivate or delete a business?",
          match: ["edit", "rename", "deactivate", "delete", "remove", "manage", "type", "location"],
          answer: "Open “Manage Units” (Owner). The pencil edits name, location, business type, manager and targets — changing type auto-provisions the new module's starter stock and checklists. The power button deactivates/re-activates without losing data. The trash button deletes the unit and all its records — you must type the unit code to confirm.",
        },
      ],
    },
  },
  WORKER: {
    WORKER: {
      title: "My Worker Workspace",
      intro:
        "Your daily desk at {biz}: record sales and expenses for your branch and see your own results — nothing else is touched.",
      tasks: [
        {
          name: "Record a sale",
          steps: [
            "Click “Record Sale”.",
            "Pick the product from your branch's live stock.",
            "Enter quantity and customer, choose the payment method (Cash, MTN MoMo…).",
            "Submit — the receipt is issued and the sale counts towards your activity below.",
          ],
        },
        {
          name: "Record a daily expense",
          steps: [
            "Click “Record Daily Expense”.",
            "Category, amount, payment method, description — then save.",
          ],
        },
        {
          name: "Check my performance",
          steps: [
            "“My Sales Today” and “My Sales Activity” show your own records only.",
            "Managers and the Owner see your totals in the branch reports automatically.",
          ],
        },
      ],
      faqs: [
        { q: "Can I see other branches?", match: ["other", "branch", "see"], answer: "No — your workspace is strictly scoped to {biz}. That keeps every branch's figures clean and your activity personally credited." },
      ],
    },
  },
  SALES_CENTER: {
    SALES_CENTER: {
      title: "Sales & Payments Center",
      intro:
        "The till for {biz}: sell from live stock, take Cash/MoMo payments, issue receipts and invoices — stock and finance update instantly.",
      tasks: [
        {
          name: "Make a sale",
          steps: [
            "Click “New Sale”.",
            "Pick the product from live stock (only available items are listed).",
            "Enter the quantity, choose the customer (or Create Customer), and the payment method.",
            "Submit — stock deducts, an official receipt/reference is generated automatically.",
          ],
        },
        {
          name: "Create an invoice",
          steps: [
            "Click “New Invoice” and build the bill for the customer from stock items.",
            "Convert to a sale with “Convert to Invoice” flow when paid — fulfilment deducts stock and books the revenue.",
          ],
        },
        {
          name: "Handle returns",
          steps: [
            "Open the customer's sale from the activity list and start a customer return.",
            "Returned quantities go back into stock and the refund is booked against the day.",
          ],
        },
      ],
      faqs: [
        {
          q: "Which payment methods can I take?",
          match: ["payment", "momo", "cash", "methods"],
          answer: "Cash, MTN MoMo, Telecel Cash, bank transfer and card — the method rides on every transaction so daily reconciliation splits payment channels cleanly.",
        },
      ],
    },
  },

  /* ═══════════════ CUSTOMER ORDER TRACKING ═══════════════ */
  TRACKING: {
    TRACKING: {
      title: "Customer Order & Tracking — register, maps & delivery",
      intro:
        "The Orders register lists every customer order with its tracking code, payment and fulfilment state — filterable by business, branch, customer, code, date and status, each one linked to Sales, Inventory, Finance and Delivery. Customers order from {biz} on the public /order storefront (pinning their exact delivery point on Google Maps) and follow everything on /track with their GM-* code — no login. Your team receives, confirms, processes, collects payment, dispatches (live Google Map) and completes each order here.",
      tasks: [
        {
          name: "Work the Orders register",
          steps: [
            "The Orders view is the default table: every customer order with its Order ID, GM-* tracking code, customer, business, branch, products, amount, payment status, order status and date.",
            "Search by code, customer or product, and filter by Business, Branch, payment state, order status or a From/To date range — “Reset filters” clears everything.",
            "Tap any row to open the order: the Linked-systems strip shows its Tracking code, Sales document, Finance transaction, Inventory reservation and Delivery state at a glance.",
            "Confirm, Process, Ready-for-Pickup, Dispatch, Deliver and Complete run from that same panel (only valid next steps are offered); the customer sees every move on /track instantly.",
            "The Live tracking view is the courier-focused list: dispatch sharing and per-order timelines.",
          ],
          tip: "The Owner sees and manages every business; managers and workers only the businesses they are assigned to — enforced server-side.",
        },
        {
          name: "Deliver to a Google Maps pin",
          steps: [
            "Storefront delivery customers pin their exact doorstep: “Use my location” captures their GPS, the arrow pad adjusts the pin to the metre, and the live Google Map follows every move.",
            "The pin is stored with the order as address + latitude + longitude and a ready-made Google Maps link.",
            "Open the order here — the Delivery-location card shows the map, the coordinates, GPS accuracy and an “Open in Google Maps” button for the courier.",
            "Once dispatched, “Courier route: live position → customer pin” opens turn-by-turn navigation from the courier's live GPS straight to the pin.",
            "The customer's /track page shows their own pin (so they can spot a mistake immediately) plus the live courier map during dispatch.",
          ],
          tip: "The pin stays private: only the business team, the courier and the customer themself (with their tracking code) ever see it.",
        },
        {
          name: "Process a new online order",
          steps: [
            "A bell notification and the ONLINE chip tell you a storefront order arrived (they also appear here under Active Orders).",
            "Tap the order — check the products, the customer's phone and any note they left.",
            "Tap “Confirmed”: the items are instantly reserved from your branch stock. If stock is short, GoMina 360 blocks the confirm and tells you exactly what is missing — top up inventory first.",
            "Move it through Processing → Ready for Pickup (pickup orders) or Dispatched (deliveries) → Completed / Delivered.",
            "Cancelling a confirmed order automatically returns its reserved stock.",
          ],
          tip: "You are notified by bell the moment an online order lands — the faster you confirm, the sooner the customer sees movement on /track.",
        },
        {
          name: "Collect & confirm payments",
          steps: [
            "Every online/staff order shows a payment state: UNPAID (customer pays on pickup/delivery) or “MoMo pending” (customer says they paid).",
            "Check your MoMo line or cash in hand, pick the method (Cash / MTN MoMo) and tap “Confirm payment received”.",
            "GoMina 360 books the revenue against today's figures, marks the order PAID, and tells the customer on their tracking page.",
            "Till (counter) sales are already PAID — they never need this step.",
          ],
        },
        {
          name: "Give a customer a tracking code",
          steps: [
            "Automatic: every sale you record already mints a code — it shows in the green success banner (and on the order row here).",
            "Manual (phone/WhatsApp orders, special jobs): tap “New Tracking”, pick the business, type the customer name, add the products, choose Pickup or Delivery, then “Create tracking code”.",
            "Read the GM-* code to the customer, or tap “Copy link” and send them the ready-made /track?code=… link.",
            "The customer opens /track on their phone — no account, no password — and only ever sees their own order.",
          ],
          tip: "Each code is unique and unguessable — it is the only key a customer needs, and it unlocks nothing but their own order.",
        },
        {
          name: "Update an order status",
          steps: [
            "Find the order (search by code, customer or product) and tap its row to expand it.",
            "Type an optional note for the customer timeline (e.g. “Ready by 2pm”).",
            "Tap the green next-step button — the flow is Order Received → Confirmed → Processing → Ready for Pickup / Dispatched → Completed / Delivered.",
            "Only valid next steps are offered; closed orders (Delivered / Completed / Cancelled) cannot change.",
            "The customer's /track page refreshes automatically every 15 seconds and shows your note with the time.",
          ],
          tip: "You can only see and update orders for businesses you are assigned to — the Owner sees everything.",
        },
        {
          name: "Dispatch a delivery with live map tracking",
          steps: [
            "Create the order as “Delivery (live map)” and type the destination.",
            "If the customer sent a Google Maps share link, paste it into “Google Maps pin” — their exact point is stored with the order.",
            "Move it to Dispatched when the courier leaves.",
            "Tap “Share my live location with the customer” on the dispatching device — the customer's /track page now shows a LIVE Google Map that follows the courier.",
            "Tap Stop or mark the order Delivered on arrival — the map closes automatically.",
          ],
          tip: "Live location is only visible while the order is Dispatched; before and after, the customer sees statuses only.",
        },
        {
          name: "Handle pickups and cancellations",
          steps: [
            "Pickup orders end at “Ready for Pickup” → “Completed” when the customer collects.",
            "Any open order can be Cancelled — the customer sees the cancelled state immediately on /track.",
          ],
        },
      ],
      faqs: [
        {
          q: "How do customers order online?",
          match: ["online", "order", "storefront", "shop", "website", "buy"],
          answer: "They open /order (linked from the sign-in screen and every tracking page), pick a business/branch, add products from live stock, choose Pickup or Delivery, pay Cash/MoMo on delivery or flag a MoMo payment — and instantly get a GM-* tracking code. No account is ever needed. Share your storefront link anywhere: /order.",
        },
        {
          q: "Where does the customer track their order?",
          match: ["customer", "track", "where", "link", "page", "login"],
          answer: "On the public /track page (linked on the sign-in screen too). They type their GM-* code — no account is ever needed — and they only see information linked to that exact code: status journey, products, payment status, delivery progress, and the live map while a delivery is on the road.",
        },
        {
          q: "How do payments work for online orders?",
          match: ["payment", "paid", "momo", "cash", "money", "confirm payment"],
          answer: "The customer either pays Cash/MoMo when the order arrives (UNPAID until then) or chooses MTN MoMo at checkout (shows as “MoMo pending”). When the money is in, open the order, pick the method and tap “Confirm payment received” — revenue is booked to the day's figures, the CRM spend updates, and the customer's page flips to Paid.",
        },
        {
          q: "What happens to stock when an online order comes in?",
          match: ["stock", "inventory", "reserve", "deduct", "quantity"],
          answer: "Stock is reserved the moment you tap “Confirmed” (the order fails to confirm if stock is short, telling you what is missing). Cancelling a confirmed order returns the reserved items to inventory automatically.",
        },
        {
          q: "Who is allowed to update a tracking status?",
          match: ["who", "permission", "allowed", "update", "staff", "manager"],
          answer: "Any signed-in staff member can create trackings and move orders forward — but strictly inside the businesses they are assigned to (the same Business/Branch access rules enforced across GoMina 360). The Owner sees and manages every business.",
        },
        {
          q: "How does the live map work?",
          match: ["map", "google", "location", "live", "gps", "dispatch"],
          answer: "When an order is Dispatched, a staff member (usually the courier) taps “Share my live location”. The device streams GPS to GoMina 360 and the customer's /track page draws it on a live Google Map until the order is Delivered or sharing stops.",
        },
        {
          q: "Does the customer get notifications?",
          match: ["notify", "notification", "alert", "updates"],
          answer: "Yes — on the /track page the customer can turn on “Notify me”: their device alerts them whenever the status changes. The page also auto-refreshes every 15 seconds and keeps a full timestamped update feed.",
        },
        {
          q: "How do I filter or find a specific order?",
          match: ["filter", "find", "search", "orders register", "date", "branch"],
          answer: "In the Orders view: type a code/customer/product in search, then narrow by Business, Branch, payment state, order status and a From/To date range. Every filter stacks. The summary line shows how many orders match and the active-order value.",
        },
        {
          q: "What is the delivery pin and who can see it?",
          match: ["pin", "delivery location", "coordinates", "privacy", "maps pin", "drop off"],
          answer: "Delivery customers pin their exact point on Google Maps at checkout (GPS + fine-tune arrows). It is stored with the order as address + coordinates and kept private: only scoped staff, the assigned courier and the customer themself (via their tracking code) can ever see it. Pickup customers instead see the branch's public pickup-point map.",
        },
      ],
    },
  },
};

/** Resolve the guide for a module+section with graceful fallbacks. */
export function getGuide(
  moduleKey: string,
  section: string,
  biz?: { name?: string; code?: string; category?: string } | null,
): SectionGuide {
  const mod = GUIDES[moduleKey] || {};
  const found = mod[section] || mod.DEFAULT || COMMON[section] || COMMON.DEFAULT;
  const bizName = biz?.name || "this business";
  const sub = (s: string) => s.replaceAll("{biz}", bizName);
  return {
    title: found.title,
    intro: sub(found.intro),
    tasks: found.tasks.map((t) => ({
      ...t,
      steps: t.steps.map(sub),
      tip: t.tip ? sub(t.tip) : undefined,
    })),
    faqs: found.faqs.map((f) => ({ ...f, answer: sub(f.answer) })),
  };
}

/** Keyword-matched free-text answer scoped to the CURRENT section's guide. */
export function answerQuestion(guide: SectionGuide, question: string): string {
  const query = question.toLowerCase();
  const words = query.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);

  let bestFaq: { score: number; answer: string } | null = null;
  for (const f of guide.faqs) {
    const score = f.match.reduce((s, kw) => (query.includes(kw.toLowerCase()) ? s + kw.split(" ").length : s), 0);
    if (score > 0 && score > (bestFaq?.score ?? 0)) bestFaq = { score, answer: f.answer };
  }
  if (bestFaq) return bestFaq.answer;

  let bestTask: { score: number; text: string } | null = null;
  for (const t of guide.tasks) {
    const nameWords = t.name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
    const score = nameWords.filter((w) => words.includes(w)).length;
    if (score > 0 && score > (bestTask?.score ?? 0)) {
      bestTask = {
        score,
        text:
          `To ${t.name.charAt(0).toLowerCase() + t.name.slice(1)}:\n` +
          t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          (t.tip ? `\n\nTip: ${t.tip}` : ""),
      };
    }
  }
  if (bestTask) return bestTask.text;

  return (
    `In this section you can: ${guide.tasks.map((t) => t.name.toLowerCase()).join("; ")}. ` +
    `Tap a task above for numbered steps, or try asking "${guide.faqs[0]?.q ?? "how do I start?"}".`
  );
}
