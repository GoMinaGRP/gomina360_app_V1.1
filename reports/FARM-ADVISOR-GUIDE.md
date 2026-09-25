# Farm Advisor — Step-by-Step User Guide

How Owners and external Farm Advisors use GoMina 360's advisor feature. Every
button and screen name below is exactly what you'll see in the app.

---

## Part 1 — Owner: add a Farm Advisor

> Only the **OWNER** can create Farm Advisor accounts. General Managers and
> Branch Managers cannot (the app blocks it).

1. **Sign in** as the Owner.
2. In the sidebar, open **Enterprise Users** (marked with the **HQ** chip).
3. Click the green **Register New Account** button.
4. Fill in the **Register User Account** form:
   - **Full Name** — e.g. *Dr. Serwaa Konadu*
   - **Email** — the advisor's login email
   - **Phone Number** — optional
   - **Role** — choose **Farm Advisor (external, read-only)**
   - A teal **Advisor Access & Settings** panel appears (no branch, no
     worker permissions — advisors are read-only by design):
     - **Initial Password** — type a password to hand to the advisor
       (if you leave it blank, the app generates one and shows it to you
       once).
     - **Farm units** — tap the unit chips to select what the advisor may
       monitor. Farm-type units (poultry, aquaculture, livestock) are
       highlighted with a green border and a **· FARM** tag; selected chips
       turn teal.
     - **Access expires (optional)** — pick a date if the engagement is
       time-boxed (e.g. a 2-week consult). Leave empty for no expiry.
     - **Visible sections** — for every selected farm unit a section panel
       appears; all sections are on by default — uncheck what the advisor
       must not see (details in **Part 2b**).
     - **Scope note (optional)** — e.g. *"Growth & health review only"*.
5. Click **Save Record**.
6. A one-time confirmation opens: **Farm Advisor account created**, showing
   the advisor's initial password (copy it and share it securely — it is
   displayed only this once) plus a summary of the units that were granted
   in the same flow.

Everything you skipped here (units, expiry, scope) can be added or changed
later — from the advisor's row in **Users & Access** or from the
**Farm Advisors** console (next part).

> What the app enforces automatically: advisors get no branch, no management
> permissions (the app rejects any), no data export, and read-only access to
> everything except their own notes.

---

## Part 2 — Owner: grant access to farm units

> There are two surfaces for this and they share **one** grant list —
> whatever you change in one is instantly visible in the other:
> the **Farm Advisors** console (below) and each advisor's row in
> **Users & Access** (Part 8).

1. In the sidebar, scroll to the **Decision Support & Hub** section and click
   **Farm Advisors** (marked with an **ACCESS** chip).
2. You land on **Farm Advisors — Access & Guidance**. Under
   **Grant Advisor Access**:
   - **Advisor account** — pick the advisor you just created.
   - **Access expires (optional)** — pick a date if the engagement is
     time-boxed (e.g. a 2-week consult). Leave empty for no expiry.
   - **Farm units** — click one or more unit chips to select them (farm-type
     units — Poultry, Aquaculture, Livestock — are highlighted with
     **· FARM**; each unit can be toggled on/off).
   - **Scope note (optional)** — e.g. *"Growth & health review only"*.
3. Click **Grant access (N units)**.

The grant immediately appears in the **Active Grants** table below, showing
**Advisor / Unit / Scope / Expires / State / Actions**. Each grant is one
row — one advisor, one unit — so you can mix and match (e.g. poultry now,
fish later).

**How access ends:**
- **Expiry** — on the expiry date the grant flips to **EXPIRED** and the
  advisor loses that unit automatically (no action needed).
- **Revoke** — click **Revoke** on the grant row for immediate removal.
- **Re-activate** — revoked or expired rows show a **Re-activate** button;
  clicking it (or re-granting the unit) restores access instantly.

Every grant, change, and revocation is written to the immutable audit trail.

---

## Part 2b — Owner: choose which SECTIONS the advisor can view

Every grant carries a **section allowlist** — the Owner decides, per farm
unit, exactly which parts of that unit the advisor may see. Anything not
selected is inaccessible **in the UI and via the API** (the server strips
the data before it ever leaves, so a hidden tab can never be reconstructed
from the network payload).

**Where you set it (all three write to the same grant):**
- **Register New Account → Farm Advisor** — after picking the unit chips,
  a **visible sections** panel appears per selected farm unit.
- **Farm Advisors console** — under **Grant Advisor Access**, the same
  per-unit section chips appear for the picked units.
- **Users & Access → advisor row → Manage Access** — every active grant
  shows its section chips; toggle and press **Save changes**.

**Defaults:** *ALL SECTIONS* is preselected (chip **ALL SECTIONS ✓**).
Uncheck what the advisor must **not** see; unchecking everything leaves the
unit visibly **locked** for them ("No sections enabled for this unit").

**Section catalogs:**

| Poultry Farm | Aquaculture | Livestock |
|---|---|---|
| Dashboard · Flocks & Batches · Growth & Weights · Benchmark Performance · Feed · Water · Health & Vaccination · Production & Sales · Inventory · Daily Checklist · Smart Alerts · AI Knowledge | Dashboard · Fish Stock & Batches · Ponds / Tanks · Growth & Weights · Benchmark Performance · Feed Management · Water Quality · Tasks & Activities · Harvest Status · Smart Alerts | Livestock Operations (Overview, Herd & Grazing, Checklist) |

Hidden sections behave consistently everywhere: the module tab is removed,
dashboard sub-panels (alerts / benchmark / growth) collapse, the checklist
API returns **403**, and denied datasets return empty from `/api/poultry`,
`/api/aquaculture` and `/api/init`. Recording is unaffected by sections —
advisors are read-only on every section, always.

---

## Part 3 — Advisor: first login

1. Go to the app's sign-in page and log in with the **email + initial
   password** the Owner gave you.
2. You land on the **Farm Advisor Console** — your home screen, marked
   **READ-ONLY MONITOR**. It shows four counters: **Open follow-ups,
   Overdue, Addressed, Total notes**.
3. If you see *"No active engagements"*, the Owner hasn't granted you any
   farm units yet — ask them for access.

**Your sidebar has just two things:**
- **Advisor Console** (top) — back to this home screen.
- **My Farm Units (N)** — the units the Owner granted, each marked with a
  **MONITOR** chip.

Everything else in GoMina 360 (finance, HR, users, sales) is not just hidden
— the server blocks it entirely for your role.

---

## Part 4 — Advisor: monitor a farm

1. From the console's **My Engagements** cards, click **Open unit
   (read-only)** — or click the unit's name in the sidebar. The card also
   shows your **Scope**, the **expiry date**, and who granted the access.
2. The farm's management module opens with an **ADVISOR · READ-ONLY** badge
   in the header. What you can see:

| Available tabs (Poultry) | Available tabs (Fish) |
|---|---|
| Dashboard, Flocks, Feed, Water, Health, Production, Stock, Daily Checklist, AI Knowledge | Dashboard, Fish Stock & Batches, Ponds / Tanks, Feed, Water Quality, Tasks & Activities, Harvest Status |

3. On the **Dashboard** you get the full performance picture: live counts,
   lay % / feed rates, **AI Smart Alerts**, the **Benchmark Performance**
   panel (your flock vs target vs farm history), checklist compliance, and
   the production & growth charts. The **Flocks** / **Fish Stock & Batches**
   tabs show each flock/batch with its age, stage, and benchmark badges.
4. What you will *not* see, by design: the **Feed Mill** tab (formulation
   costs), the **Finance** tab, inventory **prices** (stock *levels* are
   visible), and every **add / record** button — there is nothing to click
   that could change farm data. If you try any recording API directly, the
   server rejects it.

---

## Part 5 — Advisor: file a note or recommendation

You can write notes from either place:

**A. From the console** (covers any granted unit):
1. In **My Recent Notes**, use the **Choose unit…** dropdown to pick a farm.
2. Click **New note**.

**B. From inside a farm** (recommended — links the flock automatically):
1. On the farm's **Dashboard**, scroll to the **Advisor Notes & Guidance**
   panel and click **New Note**.

The **Advisor Note — observation & recommendation** window opens:

1. **Farm date** — defaults to today; you can back-date up to 30 days.
2. **Flock** (poultry) or **Batch** (fish) — optional; pick one to attach the
   note to that specific flock/batch, or leave **— whole farm —**.
3. **Follow-up due** — optional deadline for the farm to act.
4. **Category** — Growth, Feed & Nutrition, Health & Disease, Mortality,
   Water Quality, Biosecurity, Stocking, Environment, Management, Market
   Timing, or General.
5. **Priority** — Low / Medium / High / Critical.
6. **Title** — short summary, e.g. *"Weight gain below target in House 2"*.
7. **Observation & recommendation** — what you saw, and what you recommend.
8. Click **Save note** (the button shows **Analyzing…** while it runs).

On save, **GoMina AI** automatically analyzes your note and **cross-checks
it against the flock's real benchmark data** — the saved note shows an
**AI** severity badge (WATCH / URGENT…) and a **DATA:** verdict badge
(e.g. *DATA: SUPPORTED* or *DATA: NO DATA*). Hover the badge to see the
exact KPIs it compared. The note starts as **OPEN**; the farm's managers
(and the Owner, for High/Critical notes) get a notification immediately.

---

## Part 6 — Advisor: follow up

1. **See what needs attention**: the console's **Open Follow-ups** section
   lists every open item, sorted by due date, with **OVERDUE** flags on
   anything past its date.
2. **Track responses**: open any note (click it) to expand the full thread —
   your text, the AI analysis, the farm-data cross-check, and every staff
   reply. The first staff reply automatically moves a note from **OPEN** to
   **IN PROGRESS**.
3. **Reply to staff**: type in the **Respond to the advisor…** box and click
   **Send**.
4. **Move the follow-up along**: use the status buttons —
   **Mark IN PROGRESS**, **Mark ADDRESSED**, **Mark CLOSED** (or **Mark
   OPEN** to reopen). Closed is the end state — notes are never deleted;
   the farm's guidance history is permanent.
5. **Notifications come to you**: when staff respond or change a status,
   your bell shows **Re: …** / **Follow-up …** messages — clicking one takes
   you straight to the console.
6. **Fixing a mistake**: you can edit your own note (title/body/priority/
   due date) within **24 hours** of filing it — the AI re-analyzes and the
   farm's AI memory is rebuilt, nothing is double-counted. After 24 hours,
   only the Owner can revise a note.

---

## Part 7 — Owner: review advisor feedback

1. **From notifications**: each advisor note pings your bell as
   *"Advisor note: …"* — High and Critical notes are escalated to you even
   if a Branch Manager runs the unit. Click the notification to jump
   straight to that farm's dashboard.
2. **From the farm**: open the unit (sidebar → unit name) — the
   **Advisor Notes & Guidance** panel sits right on the dashboard with an
   **N OPEN · M OVERDUE** counter. Click any note to expand the
   observation, evidence photo, **GoMina AI analysis**, the
   **Farm-data cross-check**, and the whole response thread.
3. **Across all units**: open **Farm Advisors** (Decision Support & Hub) —
   the **Advisor Notes Across the Group** section lists the latest notes
   with priority/status chips and an **open unit →** link for each.
4. **You can participate too**: in the panel, **Add Guidance Note** files
   your own note on the unit, and anyone with manager access can reply in
   the thread or move the status (**Mark ADDRESSED**, **Mark CLOSED**, …).

---

## Part 8 — Owner: manage or remove advisor access

You can work from **either** surface — they show and change the same grants:

**A. Users & Access** (sidebar → **Enterprise Users**):
1. Find the advisor's row — the **Assigned Branch** column shows their farm
   units as code chips (green **ACTIVE**, amber **EXPIRED**, grey
   **REVOKED**) with an *"N units · M active"* summary, and the permissions
   column reads **READ-ONLY · NOTES**.
2. Click the stethoscope icon (🩺 **Manage Advisor Access**) on the row.
3. The **Advisor Access** window opens with:
   - **Current Grants** — one card per unit showing its state, the granter,
     an **Expires** date field and a **Scope note** field. Edit either and
     click **Save changes** to renew or re-scope; **Revoke** cuts access
     immediately; **Re-activate** restores a revoked or expired grant.
   - **Grant / Renew Access** — pick more unit chips (**· FARM** types
     highlighted, already-held units marked **HELD**), set an expiry and
     scope, then **Grant access (N units)**.
   - A link to **Open the Farm Advisors console →** for the group-wide view.

**B. Farm Advisors** (Decision Support & Hub):

| To do this | Do this |
|---|---|
| Pause / remove one unit | **Active Grants** table → **Revoke** on that row (takes effect immediately) |
| Restore a revoked grant | **Re-activate** on that row |
| Extend or shorten an engagement | Grant the same unit again with a new **Access expires** date |
| Change what the advisor focuses on | Re-grant with a new **Scope note** |
| Add another farm to their scope | Use **Grant Advisor Access** and pick the new unit(s) |
| End the advisor relationship entirely | Revoke every grant, then disable the account in **Enterprise Users** (Owner only) |

State chips in the grants table: **ACTIVE** (advisor can see the unit),
**EXPIRED** (date passed — access already cut), **REVOKED** (you removed it).

---

## At a glance — what each side can do

| | Owner / Managers | Farm Advisor |
|---|---|---|
| Create advisor accounts (with units, expiry & scope in one flow) | ✅ Owner only | — |
| Grant / renew / revoke / re-activate unit access | ✅ Owner — from Users & Access *and* the Farm Advisors console (one shared grant list) | — |
| See farm operations & performance | ✅ full | ✅ read-only, granted units only |
| Choose which sections of a unit the advisor sees | ✅ per-unit allowlist (Register form, console, Users & Access) | — sees only the allowed sections (UI + API) |
| Feed Mill & Finance data | ✅ | ❌ hidden |
| Inventory | ✅ with prices | ✅ stock levels only |
| Record sales / expenses / flocks / logs | ✅ | ❌ blocked |
| File advisor notes | ✅ (as guidance) | ✅ (their one write surface) |
| Respond & change follow-up status | ✅ | ✅ own notes' follow-ups |
| Delete notes | ❌ never — closed, not deleted | ❌ never |
| Edit a note | ✅ anytime | ✅ own notes, first 24 h |

---

*Feature verified end-to-end: 192 automated checks (security, cross-tenant
isolation, grant expiry/revocation/renewal, one-flow onboarding UI, Users &
Access inline management, per-section visibility with two advisors at
different access levels — API stripping + 403s + UI tab/panel filtering +
read-only checklists & weight buttons, notes lifecycle, notifications,
escalation, audit trail, AI corroboration, desktop + mobile 375 px) — all
passing. See `dev-tooling/verify-farm-advisor.mjs`.*
