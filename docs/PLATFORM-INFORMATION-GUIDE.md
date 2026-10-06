# How to edit the Platform's information — GoMina 360

**Audience:** the Platform Owner / Super Admin (the "Main Owner" account).
**What this covers:** everything a customer sees in the Help/Contact panel on the
Order Page, and everything a prospective business sees when they register.

---

## 1. The two things you control

| What | Where customers see it | Who may edit it |
|---|---|---|
| **Platform Help / Contact** — contact name, phone, WhatsApp, email, address, opening hours, "Good to know" notes | The **HELP** panel on `/order`, and the "Prefer to talk to us?" line on `/join` | The **Super Admin**, the platform organisation's **OWNER**, or any staff member you grant *"Customer Support — storefront HELP"* |
| **Join GoMina 360 registration** — on/off switch, headline, invitation note | The green **"Join GoMina 360"** block inside HELP, the join line in the order-page footer, and the intro of `/join` | **Super Admin only** |

> Why the difference? Contact details are day-to-day operational text, so you can
> delegate them. Opening or closing **public registration for the whole platform**
> is a business decision, so it stays with you alone.

---

## 2. Edit the Platform Help / Contact information

1. Sign in as the Super Admin (`kwame.owner@gomina360.com` by default).
2. In the left sidebar, open the **Settings & Storefront** section.
3. Click **Support — Storefront HELP**.
4. Fill in the fields:

   | Field | What customers see |
   |---|---|
   | **Contact name** | "Your customer-care contact" |
   | **Phone** | A tap-to-call link |
   | **WhatsApp** | A "Chat with us on WhatsApp" link |
   | **Email** | A mailto link |
   | **Business address / location** | "Our shop location" |
   | **Opening hours** | "Opening hours" |
   | **Other important support information** | The amber **"Good to know"** box |

5. Click **Save support info**.
6. The panel tells you how it landed:
   * *"Saved — customers see this the moment they tap HELP on the order page."* → you edited the **platform** row (correct for the Super Admin).
   * *"Saved — this is your organisation's own helpdesk information."* → you edited a **tenant** row.

**Live immediately.** Tap **HELP** on `/order` in another tab to confirm — the
server serves this with `Cache-Control: no-store`, so there is no cache to clear.

> **Leave a field blank to hide that line** from customers.

---

## 3. Control the "Join GoMina 360" registration invite

In the **same editor**, scroll to the fuchsia **"Join GoMina 360 — registration"**
block. It is visible **only to the Super Admin**.

| Control | Effect |
|---|---|
| **Checkbox** — *Show the registration invite on the customer order page* | Un-tick to **hide** the storefront invite (HELP block + footer line). The `/join` page stays reachable by direct link but shows *"Registration is closed right now"* plus your contact details. |
| **Checkbox** — *Show the "Want your business on GoMina 360? Register it" link on the staff sign-in page* | The **login page** switch, separate from the one above. **Off by default** — the sign-in page then stays purely about authentication. Tick it to show the recruitment line (a fuchsia button under the customer shortcuts) on the sign-in page; untick to hide it. It changes **nothing** about the order-page invite, the footer line or `/join`. |
| **Headline** | The big title in the HELP block, on `/join`, and in the invite. e.g. *"Run your business on GoMina 360"* |
| **Short invitation** | One or two sentences under the headline. |

> **How the login-page switch works.** `/` is a cached (static) page, so the
> switch travels with the page itself — no extra call from the browser, and
> sign-in speed is unaffected. Flipping it refreshes the page immediately; if a
> refresh is ever lost, it catches up within a minute. If the switch has never
> been set, the link is hidden — the safe default.

Click **Save support info** — the fuchsia block saves together with the contact
fields. A **"Preview the public sign-up page"** link opens `/join` in a new tab so
you can see it exactly as a prospect would.

**If you leave the headline and note empty**, a sensible default is published
instead, so the invite is never blank.

---

## 4. Review the businesses that register

Every request from the storefront Help/Contact panel or `/join` goes **privately**
to you. Nobody else — not another Owner, not their staff, not any customer — can
see it.

### Where they land — three ways in, all pointing at the same request

| Route | What happens |
|---|---|
| 🔔 **Bell** | A **"New platform request"** row appears for you (platform-scoped: no business, no tenant). **Click it and the Platform requests console opens with that exact request already expanded** — no hunting. |
| **Action Center** | Under **"Platform registrations awaiting you"** — the same request, with **Review request · GMR-XXXXXX** (opens it expanded) and **Track as task** (gives you a personal deadline; the task closes itself when you decide). |
| **Left sidebar → Platform Owners** (or the **Command Center** row) | The console itself. The badge counts everything still needing you — including requests you have **approved but not yet provisioned**. |

All three surfaces are the *same* record, read live from the database: nothing is
copied, so they can never disagree. Decide a request and the bell, the badge and
the Action Center all update together — and a finished request stops asking for
attention everywhere at once.

### The review queue

* Filter chips: **Needs attention · Pending · In review · Needs info · Approved · Rejected · Closed · All**.

* Each row shows the **status**, the **purpose** the applicant chose, the business
  name, who sent it, the reference code and the received time.
* Click **Review** to expand the full submission: business, type, phone, email,
  location, the message, and who last acted on it.
* Type into **Note / reason** before acting — it is **required to reject** and is
  kept in the record either way.

### The six actions

| Button | Result |
|---|---|
| **Start review** | Moves it to `IN_REVIEW` — signals "I have picked this up". |
| **Needs info** | `NEEDS_INFO` — you are waiting on the applicant. |
| **Approve** | `APPROVED` — records the **decision**. Nothing is created yet. |
| **Reject** | `REJECTED` — **requires a reason**. No account is created. |
| **Close** | `CLOSED` — filed, e.g. a support question that was handled. |
| **Provision workspace** | Unlocks **after** approval. Creates the organisation + the Owner's login. |

### What the bell tells you

The notification is not a one-shot alert: it keeps you honest as the request moves.

| Stage | Bell title | Read? | Still in the Action Center? |
|---|---|---|---|
| Just submitted | New platform request | unread | yes |
| In review / needs info | …in review / …awaiting the applicant | unread | yes |
| **Approved** | Platform request approved — **provision the workspace** | unread | **yes** — provisioning is still owed |
| Provisioned | Platform request fulfilled — workspace created | **read** | no — done |
| Rejected | Platform request rejected | **read** | no — done |
| Closed | Platform request closed | **read** | no — done |

The bell never re-marks a row you have already opened as unread, so it cannot
nag you twice — but it also never quietly clears work you have not done.

### Approve → Provision (deliberately two steps)

Approve records a decision. **Provision workspace** is the action that creates a
live account, so it is a separate click — an account can never be created by a
stray click on a queue row.

When you provision, the console shows **once**:

* the new **organisation name**
* the **sign-in email**
* the **one-time password**

> ⚠️ **Copy the one-time password immediately.** It is displayed once, never
> stored, and never sent by notification. Hand it to the new Owner securely; they
> can change it after signing in. The new Owner is a normal organisation OWNER —
> it can never become a Super Admin.

### What the applicant sees

They get a **reference code** (e.g. `GMR-9PW7MK`) on screen and nothing else —
there is no public list and no status lookup, so nobody can browse your queue.
If the same email submits again while a request is still open, they see
*"We already have your request…"* instead of creating a duplicate.

---

## 5. Quick reference

| I want to… | Go to |
|---|---|
| Change the support phone / email / hours customers see | **Settings & Storefront → Support — Storefront HELP** |
| Add a "Good to know" note to HELP | same editor → *Other important support information* |
| Turn the "Join GoMina 360" invite on or off | same editor → fuchsia **Join GoMina 360 — registration** block (Super Admin only) |
| Change the registration headline / wording | same editor → *Headline* / *Short invitation* |
| See who registered | Sidebar **Platform Owners → Platform requests**, or click the 🔔 bell row (opens it expanded), or the **Action Center** row |
| Get a deadline on a registration | Action Center → **Track as task** — it closes itself when you decide |
| Approve or reject a registration | expand the request → **Approve** / **Reject** (+ reason) |
| Create the account for an approved business | same row → **Provision workspace** → copy the one-time password |
| Give a staff member the helpdesk editor | **Enterprise Users → edit user → "Customer Support — storefront HELP"** (never grants registration control) |
| Give a manager the **staff directory** (Enterprise Users) | **Users & Access → Permissions → 🔒 Enterprise Users** → Save (see `docs/ENTERPRISE-PERMISSIONS-AND-FINANCIAL-ACCESS.md`) |
| Give an accountant/manager the **Central Financial Report** | same place → 🔒 **Finance & Reports** → Save |
| Take money or directory access away again | same toggle → off → Save (effective immediately, no re-login) |

---

## 6. Who may see money and the staff directory

Two surfaces are **never** switched on by a role alone — not even for a General
Manager. Only the OWNER (or the platform Super Admin) holds them, and the OWNER
hands them out explicitly from **Users & Access → Permissions**:

| Surface | Toggle | What it opens |
|---|---|---|
| **Enterprise Users** | 🔒 *Enterprise Users — open the staff directory & access console* | the staff directory + permission console, scoped to that person's units |
| **Financial figures** | 🔒 *Finance & Reports — CENTRAL FINANCIAL REPORT* | the Central Financial Report, Command Center P&L, budgets, cash-flow forecast, payroll, **employee salaries** and **financial exports** |

Without the finance authorisation the Command Center still runs — checklists,
risk score, stock and sales counts stay live — but every money figure is shown
as `•••••` with a notice saying who to ask. The figures are removed on the server,
so they are not present in the page's data either.

The same authorisation governs **what may leave through the Export Center**: the
*Data export* switch decides whether someone may export at all, while the module
decides what — money modules (Command Center, Sales & Payments, Financial
Transactions, payroll/budget) and the Enterprise Users directory each need their
own authorisation, and an export approval is gated the same way. Employee
**rosters** stay operational for branch users (names, roles, contacts, schedules,
documents); the **salary** figure is withheld and shown as *Restricted*.

Full detail, role-by-role matrix and troubleshooting:
**`docs/ENTERPRISE-PERMISSIONS-AND-FINANCIAL-ACCESS.md`**.

---

## 7. Notes & good practice

* **Nothing here is public by accident.** The review queue is gated on the Super
  Admin flag on the server, not merely hidden in the UI.
* **Audit trail.** Every decision writes an immutable audit row
  (`PLATFORM_REQUEST_APPROVE`, `PROVISION_PLATFORM_REQUEST`, …) with
  `ownerId = null`, so platform events are never attributed to a tenant.
* **Spam protection is automatic.** Per-IP burst + hourly limits, a hidden
  honeypot field, and one-open-request-per-email. A rejected request that comes
  back from the same email will be accepted again — that is normal.
* **The invite says the right thing.** The HELP block is worded about the
  *platform* ("your business on GoMina 360") and carries the line *"Goes privately
  to the GoMina 360 platform team — not to any shop on this page."* Please keep
  that meaning if you rewrite the headline: `/order` sells every tenant's stock,
  so a shopper must never think the shop they are browsing is recruiting them.
* **No email is sent** (the platform has no mail provider yet). Contact is by the
  phone/WhatsApp/email you publish in the Help/Contact section — which is exactly
  why those details should always be filled in.

---

## 8. If something looks wrong (troubleshooting)

| Symptom | What it means / what to do |
|---|---|
| An applicant's workspace was created but the request still shows **Approved** | Retry **Provision workspace** on that row. The platform now recognises a workspace that already exists for the applicant's email and **adopts** it (the row is stamped with the organization and Owner it belongs to) instead of creating a second account. If it was adopted, no new password is issued — the applicant keeps the one they were given. |
| "A user with this email already exists." | That email signs in to another organization (or already owns one). Sign-in emails are globally unique by design. Ask the applicant for a different email, or manage the existing account in **Enterprise Users**. |
| Two people applying for the same business | One request per email. The second submission is answered with "we already have your request", without exposing the first reference code. |
| A build log line: `note: N company_settings row(s) reference a deleted organization` | Purely informational and harmless — those settings rows belong to organizations that were deleted, and the platform now **absorbs** them instead of failing. To prune them (optional): `delete from company_settings where organization_id not in (select id from organizations);` |
| A build log line: `[seq] N serial sequence(s) realigned forward-only (never rewound)` | Normal. The build repairs identifier sequences so they can only move **forward**, which is what stops a deleted organization's id from ever being handed to a new one. No action needed. |
| Registration invite still says "being set up" on `/order` | The platform Help/Contact row is unpublished or `registration_enabled` is off. Publish it in **Settings & Storefront → Support — Storefront HELP** (Super Admin). |
| I approved a request and the 🔔 bell still shows it | **Correct.** Approval is a decision; the workspace is created by **Provision workspace**. The bell says *"…approved — provision the workspace"* and only clears once the account exists. |
| A notification click took me to the Command Center | Only possible for an old row written before this fix (its link had no reference). Click the 🔔 row again — new rows land on the request. |
| The Action Center shows a registration but a colleague cannot see it | By design: platform registrations are Super-Admin-only and are never derived from a business scope, so no other Owner, GM or BM sees them anywhere — not even in their own Action Center. |
