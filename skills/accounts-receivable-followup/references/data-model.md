# AR Follow-up — Data Model & Worked Example

This documents the exact EaveSide fields the skill relies on, so a run trusts
the right field instead of guessing. All shapes below are from live data.

## Job statuses (from `job_status_summary`)

| status | meaning | relevant? |
|--------|---------|-----------|
| `new_lead` | unconverted lead | no |
| `proposal_signed` | sold, not built | no |
| `production` | install in progress / just done | maybe (recently wrapped) |
| `payments_invoicing` | **billing & collection stage** | **yes — primary funnel** |
| `job_completed` | done (usually already paid/closed) | only if uncollected |
| `cancelled` / `lost` | dead | exclude |

There are thousands of `job_completed` rows going back years, and `list_jobs`
caps at 50 with no date filter — do NOT scan them all. Funnel via
`payments_invoicing` + `ar_aging_report` instead.

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

Decision table for a given job:

| collected_total | balance_due | bucket |
|-----------------|-------------|--------|
| `0` | `> 0` | **PRIMARY alert** — nothing collected |
| `0` | `0` & invoiced_total `0` | **PRIMARY alert** — not even invoiced yet |
| `> 0` | `> 0` | secondary — "partial, still owed" |
| `> 0` | `0` | done, paid — ignore |

Treat `collected_total < 1` as zero (rounding). These are the same numbers the
job's P&L page shows, so they match what the office sees.

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

Use `job_id` to pull `get_job` / `get_job_financials`. `balance_due == total`
means nothing collected on that invoice; `status: "partial"` means some came in.
`issue_date` is a good age proxy when you want to sort most-at-risk first.

## Worked example (today = 2026-08-10)

1. `ar_aging_report()` → invoice `6044-1`, `job_id` `e795a757-...`,
   `total 23859.79`, `balance_due 23859.79`, `issue_date 2026-07-01`.
2. `get_job(e795a757-...)` → `installed_at 2026-07-01T...`,
   `assigned_to bsibbett@roofingforce.com`, retail (no insurance fields),
   customer + phone.
3. `get_job_financials(e795a757-...)` → `collected_total 0`, `balance_due
   23859.79`, `invoiced_total 23859.79`.
4. Rule check: install ~40 days ago (≥2 ✓), `collected_total == 0` ✓, not
   cancelled ✓ → **PRIMARY alert**, grouped under `bsibbett`.
5. Draft:

   ```
   @bsibbett — collect on Job #6044, <customer> (<city>)
   Installed Jul 1 (40 days ago) · $0 collected of $23,860 · nothing in yet.
   Retail job — go get the first payment. Customer: <phone>.
   ```

## Rep email → display name

`assigned_to` is an email like `gdavis@roofingforce.com`. Address the rep by the
local part (`gdavis`) unless you can resolve a friendlier name from context. The
active reps with the most open work include cluna, adominguez, bsibbett,
tkincaid, ajohnson, gdavis, rdavis, zsmith, tschulze (from
`open_jobs_by_assignee`). `unassigned` is a real value — bucket those separately.
