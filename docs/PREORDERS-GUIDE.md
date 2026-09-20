# GoMina 360 · Pre-Orders — Step-by-Step Guide

Pre-Orders let an Owner sell goods **before they physically land in branch stock** —
the customer pays a deposit (or pays on arrival), the business runs the supplier
pipeline, and the customer watches a 9-stage journey until the item arrives.

Everything below is done inside the app. Same flow works on desktop and mobile.

---

## A. Owner: enable Pre-Orders for a business / branch

> Who is allowed: **Owner** of the organization, or any staff member the Owner
> granted **“Manage Unit”** on that business. (Other managers see the card
> read-only.)

1. Sign in as the **Owner**.
2. Open the sidebar → **Shared Enterprise Modules → Pre-Orders**
   (indigo chip, marked *SETUP*). This is the pre-orders hub.
3. Stay on the **Setup** tab and pick the business/branch from the unit
   selector (top right of the Setup card).
4. Flip the **Pre-Orders ON/OFF** switch next to the unit selector → **ON**.
   - The same switch also lives in **Manage Businesses → Online** tab
     (switch row “Pre-Orders”) — either place works; they stay in sync.
5. Done. The unit can now publish pre-order offers and accept pre-orders.

> Switching a unit **OFF** hides its offers from the storefront and blocks new
> pre-orders (customers see *“This branch does not accept pre-orders yet”*).
> Orders already placed keep flowing to completion — nothing is stranded.

## B. Owner: add pre-order options (price · ETA · shipping · deposit) to a product

*Fulfilment methods (once per organization)*
1. In **Setup**, pick the unit, then click **Seed standard methods**
   (only needed the very first time) — creates *Air / Sea Freight / Road /
   Local Delivery / Pickup* with default lead windows. You may also add your
   own with **+ Method**.

*Offer on a product*
2. Click **Offer** (green) in the Setup header.
3. In the dialog pick:
   - **Product** — from this unit's stock catalogue (out-of-stock is fine;
     that's exactly what pre-orders are for),
   - **Fulfilment method** — e.g. *Air Freight Import*
   - **Price (GH₵)** — the pre-order selling price per unit
   - **Lead-time min / max days** — your honest ETA window
   - **Deposit** — *None*, *% of price*, or *Fixed amount*
   - **Balance timing** — paid *on arrival* (when you land the stock) or
     *when ready* (at handover).
4. **Save.** The option goes live immediately.
5. (Optional) **Edit** / **Disable** any offer from its row later. Disabling
   never affects pre-orders already placed.

## C. It publishes instantly on the Customer Storefront

- The unit's public link is `/order?biz=<businessId>` (QR codes & share
  buttons are in **Manage Businesses → Online**).
- If Online Ordering for that unit is OFF, nothing reaches `/order` — keep it
  on. Pre-orders ride the same storefront.
- On the storefront the unit shows an indigo note *“This branch accepts
  pre-orders …”* and each offered product shows either
  **Pre-order only** (out of stock) or *“· pre-order also available”*
  (in stock too), each with the indigo option card:
  **method · lead days · price · deposit terms**.

## D. Customer: find & place a pre-order

1. Open the store link you received (`/order?biz=…`) — or the shared
   marketplace `/order` — and tap the unit.
2. Products with a pre-order offer show the **indigo card** under the price.
   Tap **Pre-order** on it and pick a quantity (respects any capacity cap).
3. Pre-order lines are separate cart lines (a product sold both ways rings
   up as two lines).
4. At checkout the banner explains the deposit & balance timing. If a deposit
   is due, payment is automatically **MTN MoMo now** — pay-on-delivery cannot
   hold a reservation.
5. Place the order → the customer gets a **tracking code + link**.
6. On `/track?code=…` they watch the **9-stage journey**:
   *Order Received → Confirmed → Supplier Procurement → Shipped → In Transit →
   Arrived → Received Into Stock → Ready/Dispatched → Done* — pre-order stages
   render in **indigo** with deposit & balance status live.

## E. Operator: run the supplier pipeline (Owner / Manage-Unit staff)

1. **Deposit first** — on the order row (Customer Order & Tracking console),
   press the amber deposit-confirm button. The ledger never double-books.
2. Open **Pre-Orders → Procurement** tab → **Raise supplier PO** — waiting
   pre-order quantities are auto-aggregated per product; choose a supplier.
3. Advance the PO one stage at a time (Raised → Sent → Shipped → In Transit →
   Arrived) — the customer's tracking page follows automatically.
4. On **Arrived**, post the **goods receipt** — only this physically lands
   stock. Pre-order lines become *committed* for those customers and never
   dilute free branch stock.
5. Confirm the **balance** payment, then move the order to
   **Ready → Delivered/Completed** as usual.

---

## Access & safety rules (enforced server-side)

| Rule | Where it bites |
| --- | --- |
| Only Owner / Manage-Unit grantees can flip **Pre-Orders Enabled** | PATCH `/api/businesses/:id` — other staff get 403 |
| A unit OFF shows no offers & accepts no pre-orders | Storefront menu strips options; checkout returns *“This branch does not accept pre-orders yet”* |
| Option writes on an OFF unit are refused | 409 from the fulfilment API (turning an existing active option *off* stays allowed so nothing strands) |
| Pre-orders never touch free stock | They commit on goods receipt only |
| Tenant isolation | An owner only ever sees and toggles their own organization's units (super admin sees all) |
