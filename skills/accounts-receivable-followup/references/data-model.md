# AR Follow-up — Data Model & Worked Example

This documents the exact EaveSide fields the skill relies on, so a run trusts
the right field instead of guessing. All shapes below are from live data.

## The funnel: `ar_aging_report()` IS the receivable

For the full-AR follow-up, `ar_aging_report()` is the primary and authoritative
source: one call returns every outstanding invoice, and `summary.grand_total`
equals the AR figure on the EaveSide screen. Enrich each invoice with one
`get_job(job_id)` for the rep and details. Do not try to scan `job_completed`
(thousands of rows, `list_jobs` caps at 50) — the aging report already contains
every job that owes money, whatever its status.

## Job statuses (from `job_status_summary`) — for context

| status | meaning | shows in AR? |
|--------|---------|-----------|
| `new_lead` | unconverted lead | no |
| `proposal_signed` | sold, not built | only if invoiced early → **Review** |
| `production` | install in progress / just done | if invoiced |
| `payments_invoicing` | **billing & collection stage** | yes — most AR lives here |
| `job_completed` | done (usually already paid/closed) | only the rare unpaid one |
| `cancelled` / `lost` | dead | if still invoiced → **Review/Excluded** |

## `get_job(id)` — fields that matter

```jsonc
{
  "job_number": "6044",
  "status": "payments_invoicing",
  "work_type": "Insurance",                    // ← insurance signal (NOT is_insurance_job)
  "assigned_to": "wstandridge@roofingforce.com", // the rep to alert
  "customer_name": "Alex Waloski",
  "customer": { "phone": "(479) 317-5157", "email": "..." },
  "address": "15295 Goshen Tuttle Road", "city": "Elkins", "state": "AR",
  "contract_amount": 23859.79,

  "installed_at": "2026-06-30T22:09:11+00:00", // ← INSTALL COMPLETE timestamp (UTC)
  "install_date": "2026-06-30",                // date-only mirror; BOTH can be null
  "paid_at": "2026-06-26T17:06:34+00:00",      // ⚠️ NOT proof of payment — see below
  "completed_at": null,                        // usually null — never use as trigger

  // Insurance detail fields — OFTEN NULL even when work_type == "Insurance"
  "is_insurance_job": false,                   // ⚠️ unreliable — ignore it
  "insurance_carrier": null,
  "claim_number": null,
  "deductible_amount": null
}
```

**Trigger date = `installed_at`.** Use `install_date` as a fallback if
`installed_at` is null. `completed_at` is frequently null — do not use it as the
trigger. If both `installed_at` and `install_date` are null, treat it as an
"install date missing" case (see SKILL.md edge cases), don't skip it.

**⚠️ `paid_at` does NOT mean the job was paid.** Live example: job 6044 has
`paid_at: 2026-06-26` yet `collected_total: 0`. `paid_at` tracks an internal
pipeline milestone, not money received. Never infer collection from it — read
`collected_total` from `get_job_financials`.

**⚠️ Insurance detection: use `work_type == "Insurance"`, not
`is_insurance_job`.** Jobs 6044, 5988, and 6110 all have `work_type:
"Insurance"` but `is_insurance_job: false` and null carrier/claim/deductible.
Trust `work_type`.

## `get_job_financials(id)` — the money truth

```jsonc
{
  "contract_amount": 19000,
  "invoiced_total": 19000,     // 0 = not billed yet
  "collected_total": 19000,    // ← 0 = NOTHING collected (the core signal)
  "ar_balance": 0,
  "balance_due": 0             // > 0 = money still owed
}
```

You usually don't need this per invoice — the aging report already gives
`balance_due` and `total`, and **collected = total − balance_due**. Call
`get_job_financials` only when an invoice looks off and you want to confirm.

Categorization decision table (per outstanding invoice):

| balance_due vs total | job status | category |
|-----------------|-------------|--------|
| `balance_due == total` (≥ total − $1) | active | **Nothing collected** (urgent if installed 2+ days) |
| `0 < balance_due < total` | active | **Partial — balance remains** |
| any balance | `cancelled` / `lost` | **Review/Excluded** — void or write off |
| balance, `installed_at` null | `proposal_signed` / unassigned | **Review** — not installed / no owner |
| `balance_due == 0` | — | paid — not in AR, ignore |

Treat amounts under $1 as zero (rounding). These match the numbers the office
sees on the job P&L and the AR screen.

## `ar_aging_report()` — the outstanding-invoice funnel

One call. Returns a `summary` (current / 1-30 / 31-60 / 61-90 / 90+ buckets with
counts and totals) and `invoices` grouped the same way. Each invoice:

```jsonc
{
  "invoice_number": "5942-1",
  "job_id": "5f7e7bfd-...",      // ← join key back to the job
  "customer_id": "5db39f55-...",
  "total": 25482.43,
  "balance_due": 25482.43,        // == total → nothing collected on this invoice
  "issue_date": "2026-06-13",     // approximates completion for age sorting
  "status": "sent"                // or "partial"
}
```

Use `job_id` to pull `get_job`. `balance_due == total` → nothing collected on
that invoice; `status: "partial"` → some came in; `collected = total −
balance_due`. `issue_date` is your age proxy when `installed_at` is null. A job
can have more than one outstanding invoice — keep them as separate lines, as the
AR report does.

**Reconciliation is the acceptance test.** Sum `balance_due` across every
invoice you output; it must equal `summary.grand_total`. If it doesn't, you
dropped or double-counted an invoice.

## Worked examples (today = 2026-08-10)

**Nothing collected (urgent):**
1. `ar_aging_report()` → invoice `6044-1`, job `e795a757-...`, `total 23859.79`,
   `balance_due 23859.79` (== total → nothing collected).
2. `get_job(e795a757-...)` → `assigned_to wstandridge@...`, `work_type
   Insurance`, `installed_at 2026-06-30` (41 days ago ✓ ≥2), customer + phone.
3. collected = 23859.79 − 23859.79 = 0 → **Nothing collected**, urgent, under
   `wstandridge`:
   ```
   @wstandridge — collect on Job #6044, Alex Waloski (Elkins, AR) — INSURANCE
   Installed Jun 30 (41 days ago) · $0 collected of $23,860 · nothing in yet.
   Chase the first/ACV check AND the deductible. Customer: (479) 317-5157.
   ```

**Partial (balance remains):**
1. Invoice `5929-1`, job `4a7b5fb6-...`, `total 19439.71`, `balance_due 9719.86`
   (0 < balance < total → partial).
2. `get_job` → `assigned_to rmdavis@...`, `work_type Insurance`, installed
   Jun 14.
3. collected = 19439.71 − 9719.86 = 9719.85 → **Partial**, under `rmdavis`:
   ```
   @rmdavis — Job #5929, Marsha McRoberts (Osawatomie, KS) — INSURANCE
   PARTIAL: $9,720 in, $9,720 still owed of $19,440. Installed Jun 14 (57d ago).
   Collect the remaining balance. Customer: (913) 755-6441.
   ```

## Rep email → display name

`assigned_to` is an email like `gdavis@roofingforce.com`. Address the rep by the
local part (`gdavis`) unless you can resolve a friendlier name from context. The
active reps with the most open work include cluna, adominguez, bsibbett,
tkincaid, ajohnson, gdavis, rdavis, zsmith, tschulze (from
`open_jobs_by_assignee`). `unassigned` is a real value — bucket those separately.
