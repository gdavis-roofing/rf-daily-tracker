---
name: accounts-receivable-followup
description: >-
  Builds the full Roofing Force accounts-receivable follow-up: every job with an
  outstanding balance — both jobs where nothing has been collected AND jobs
  that paid partially and still owe — grouped by the assigned sales rep, with a
  drafted collection message for each. Reconciles to the total AR shown in
  EaveSide. Use this ANY time someone wants to chase collections or see who owes
  money: "run AR follow-ups," "who hasn't paid," "which reps have money to
  collect," "the weekly AR report," "we're owed money on installed jobs," first
  checks, deductibles, remaining balances. The urgent core: once a job's install
  has been done 2+ days with nothing collected, the rep must go get the first
  check and deductible — but the skill covers the whole receivable, partials
  included. Runs against the EaveSide MCP tools. Trigger even when the person
  doesn't say "accounts receivable" — collections, uncollected installs, and
  "money owed after a completed job" all belong here.
---

# Accounts Receivable Follow-up

## What this does and why

Roofing Force gets paid in pieces, and at any time there is well over a million
dollars of outstanding AR. This skill produces the **complete collections
worklist** — every job that still owes money — grouped by the sales rep who owns
it, with a drafted follow-up message for each, and a total that **reconciles to
the AR figure shown in EaveSide**.

Outstanding jobs fall into two collection situations, and the message differs:

1. **Nothing collected** — the roof is on but not a dime has come in. The first
   money owed is the **first check** (insurance ACV check, or the retail
   customer's initial payment) and the **deductible** (what the homeowner owes).
   This is the urgent bucket: **once the install has been complete for 2+ days
   and nothing has been collected, the assigned rep must go collect.**
2. **Partial — balance remains** — some money came in, but the job still owes a
   balance. The rep chases the **remaining balance**, not a first check.

Both are real receivables and both belong in the follow-up. The audience is
**internal** (the rep / the manager), never the customer.

## Run modes

Default to the **full AR sweep** unless the person clearly wants only the urgent
slice.

- **Full AR sweep** (default — "run AR follow-ups", "who owes us money", "weekly
  AR report") — every outstanding invoice, categorized, grouped by rep, with a
  drafted message each, reconciled to the EaveSide AR total.
- **Urgent only** ("who do we need to collect from *today*", "nothing-collected
  jobs") — restrict to the **nothing-collected + installed 2+ days ago** subset.

## Where the numbers come from (the funnel)

`ar_aging_report()` **is** the receivable — one call returns every outstanding
invoice with its `job_id`, `total`, `balance_due`, `issue_date`, and aging
bucket, and its `grand_total` is exactly the AR figure on the EaveSide screen.
Start here; this is what makes the output reconcile.

**Step 1 — pull the whole AR (one call):** `ar_aging_report()`. Note the
`summary.grand_total` — your output must sum to it. Each invoice's `balance_due`
is what's still owed on it; `balance_due == total` means nothing collected,
`0 < balance_due < total` means partial.

**Step 2 — enrich each invoice's job (one `get_job` per invoice):**
`get_job(job_id)` → `assigned_to` (the rep), `customer_name` + `customer.phone`,
`city`/`state`, `work_type` (insurance vs retail), `installed_at`, `status`.
The AR report already gives you the money (`balance_due`, `total`), so a single
`get_job` per invoice is usually enough — you don't need `get_job_financials`
for every one. Compute **collected = total − balance_due** and, when
`installed_at` is set, **days since install = today − date(installed_at)**.

This is roughly one call per outstanding invoice (dozens, not thousands). If
that's a lot, fan the enrichment out in parallel batches rather than skipping
any — dropping invoices breaks the reconciliation.

**Step 3 — categorize each invoice:**
- `balance_due == total` (≥ total − $1) → **Nothing collected**
- `0 < balance_due < total` → **Partial — balance remains**
- job `status` is `cancelled`/`lost` → **Review/Excluded** (still on the AR
  books — flag it to void or write off; keep its balance in the total)
- invoiced but **not installed** (`installed_at` null *and* status like
  `proposal_signed`) or **unassigned** → **Review** (don't route a collection
  message to a rep who has nothing to collect yet; surface for a human)

**Step 4 — group by rep** (`assigned_to`). `unassigned`/null jobs get their own
**"UNASSIGNED — needs an owner"** bucket. Sort reps by dollars owed, biggest
first — dollars are what get attention.

See `references/data-model.md` for exact field shapes, the decision table, and a
worked example.

## The 2-day rule, precisely

Within the **Nothing collected** category, the urgency trigger is: **install
complete for 2+ days.** `installed_at` is the install-complete timestamp (set
when a job reaches the `payments_invoicing` stage — *not* the status literally
named `job_completed`, which is the terminal already-paid state). Compare on the
calendar date, since `installed_at` is UTC. A nothing-collected job installed 2+
days ago is a live "go get the first check + deductible" alert.

**Do NOT trust `paid_at`.** In live data, jobs with `collected_total: 0`
(nothing collected) still carry a `paid_at` timestamp — it marks a pipeline
milestone, not money received. Trust `balance_due`/`collected_total`, never
`paid_at`.

## Output format

Lead every section with dollars and counts. Open with the reconciliation so the
total is unmistakable and ties to EaveSide.

```
AR Follow-up — <date>
Total outstanding: $1,229,363 across 85 invoices  (matches EaveSide AR)
  • Nothing collected (rep must chase first check + deductible): $721,279 / 41
      – of which installed 2+ days ago (urgent):                 $614,509 / 39
  • Partial — balance remains:                                    $508,084 / 44
  • Review/Excluded (cancelled, or invoiced-not-installed):       $106,770 / 2
```

Then, **grouped by rep** (biggest owed first), one drafted message per invoice.

**Nothing-collected message** — insurance names both pieces:

```
@wstandridge — collect on Job #6044, Alex Waloski (Elkins, AR) — INSURANCE
Installed Jun 30 (41 days ago) · $0 collected of $23,860 · nothing in yet.
Chase the first/ACV check AND the deductible. Customer: (479) 317-5157.
```

Retail nothing-collected → "…go get the first payment." Missing install date →
"…invoiced (no install date on file). Confirm the install went in, then…".

**Partial message** — name what's in and what's left:

```
@rmdavis — Job #5929, Marsha McRoberts (Osawatomie, KS) — INSURANCE
PARTIAL: $9,720 in, $9,720 still owed of $19,440. Installed Jun 14 (57d ago).
Collect the remaining balance. Customer: (913) 755-6441.
```

**Review message** — no rep action yet, route to a human:

```
Job #6143, Travis Kern (Springfield, MO) — REVIEW
$100,814 invoiced but NOT installed yet (proposal_signed) and UNASSIGNED.
Assign an owner and confirm scope before collecting.
```

If asked for a spreadsheet, produce one sheet with every invoice (rep, job #,
invoice #, customer, phone, type, install date, days since install, collected,
balance owed, invoice total, category, drafted message) plus a summary sheet
(reconciliation, aging table, per-rep totals). The per-rep balances must sum to
the AR grand total — state the reconciliation explicitly.

## Delivery

There is no "message a rep" tool, so the default is to **output the drafted
messages** for the manager to send through their normal channel (text, Slack,
the morning huddle). Options if asked:

- **Log it on the job** — `add_note(job_id, ...)` records the follow-up on the
  job in EaveSide. Only when the person explicitly wants notes written back; it
  changes data.
- **Draft only** (default) — output the text, change nothing.

Never send anything to the customer. `send_customer_notification` is off-limits
here — the follow-up is internal to the rep.

## Edge cases and judgment

- **Reconcile or explain.** The per-rep balances must add up to
  `ar_aging_report().summary.grand_total`. If they don't, you dropped or
  double-counted an invoice — fix it, don't ship a total that disagrees with the
  EaveSide screen. (A job can have more than one outstanding invoice; keep them
  as separate lines, the way the AR report does.)
- **Insurance vs retail — read `work_type`, not `is_insurance_job`.**
  `is_insurance_job` is often `false` on jobs whose `work_type` is `"Insurance"`,
  and `insurance_carrier`/`deductible_amount`/`claim_number` are frequently null.
  Detect insurance from `work_type == "Insurance"`; include carrier/claim/
  deductible only if populated, but still tell the rep it's insurance so they
  chase both the first check and the deductible. `Retail`/`Commercial` just needs
  the first/remaining payment.
- **Install date missing.** Many collection-stage jobs have `installed_at` null
  even though they're invoiced and weeks old. Don't skip them — use the invoice
  `issue_date` as the age proxy and note "(no install date on file)" so the
  office fixes the record. Don't assume they're under 2 days old.
- **Not invoiced yet.** `invoiced_total: 0` and `collected_total: 0` — hasn't
  even been billed. Flag "not invoiced yet" so the office fixes the billing gap.
- **Very old balances.** A 90+-day or year-old balance (partial or full) is a
  write-off risk or a data error — surface it loudly with the age rather than
  burying it, so a human decides collect-vs-close.
- **Unassigned / not-installed.** Route these to Review, not to a rep — a rep
  can't collect on a job that isn't theirs or isn't built. Surface for a manager.
- **Duplicate/near-duplicate jobs.** Watch for the same customer on two similar
  jobs/invoices (a split or a data dupe) and call it out for a human check.

## Quick reference: the tools you'll use

| Need | Tool |
|------|------|
| The whole AR, every outstanding invoice, aged (the funnel + the total) | `ar_aging_report()` |
| Rep, customer, phone, work_type, install date, status per invoice | `get_job(job_id)` |
| Deeper money detail if an invoice looks off (collected_total, etc.) | `get_job_financials(job_id)` |
| Collection-stage jobs (cross-check) | `list_jobs(status="payments_invoicing")` |
| Log a follow-up note on the job (opt-in) | `add_note(job_id, ...)` |

Full field shapes, the categorization decision table, and a worked example are
in `references/data-model.md` — read it if you're unsure which field to trust.
