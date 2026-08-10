---
name: accounts-receivable-followup
description: >-
  Flags roofing jobs where the install is finished but no money has been
  collected, and drafts an internal follow-up to the assigned sales rep. Use
  this ANY time someone at Roofing Force wants to chase collections, first
  checks, or deductibles: "who hasn't paid yet," "run AR follow-ups," "jobs
  we've completed but haven't collected on," "which reps have money to collect,"
  "we're owed money on installed jobs," or the weekly AR rep report. The core
  rule: once a job's install has been done for 2+ days and nothing has been
  collected, the assigned rep needs to go get the first check and the
  deductible. Runs against the EaveSide MCP tools. Trigger even when the person
  doesn't say "accounts receivable" — collections, uncollected installs, and
  "money owed after a completed job" all belong here.
---

# Accounts Receivable Follow-up

## What this does and why

Roofing Force gets paid in pieces. On a completed install the money that should
come in first is the **first check** (the insurance ACV check, or the retail
customer's initial payment) and the **deductible** (what the homeowner owes).
When a roof is on the house but nothing has landed, that cash is at risk — the
longer it sits, the harder it is to collect. Real money is on the line: at any
given time there is well over a million dollars of outstanding AR.

The company's rule is simple: **once a job's install has been complete for 2 or
more days and nothing has been collected, the sales rep assigned to that job has
to go follow up and collect the first check and the deductible.**

This skill turns that rule into two concrete outputs:

1. **Rep alerts** — for each job that has crossed the line (install done 2+ days
   ago, still $0 collected), a short message addressed to the assigned rep
   telling them exactly which job to go collect on.
2. **Weekly rollup** — once a week, a per-rep summary of everything still
   uncollected so a manager can run the numbers in one place.

The audience is **internal** (the sales rep / the manager), not the customer.
Nothing is sent to homeowners by this skill.

## Run modes

Figure out which the person wants; when unclear, default to **daily alerts** and
mention the weekly rollup is available.

- **Daily alerts** ("run AR follow-ups", "who do we need to collect from") —
  find newly-crossed-the-line jobs and draft a per-rep message for each.
- **Weekly rollup** ("weekly AR report", "the Monday collections update") — the
  same detection, but aggregated into one per-rep summary with company totals,
  meant to go out once a week.

## The detection rule (be precise here)

**What "completed" means here — read this first.** The business rule is "the
*install* is completed." In EaveSide that is signaled by `installed_at` being
set, which happens when a job moves into the **`payments_invoicing`** stage —
NOT by the status literally named `job_completed`. Counter-intuitively,
`job_completed` is the *terminal, already-paid* state (old closed jobs); keying
detection on that status alone would find nothing to collect. So detect on
"install date is set + nothing collected," and sweep both `payments_invoicing`
and `job_completed` so a genuinely uncollected completed job is never missed.

A job belongs on the follow-up list when **all** of these hold:

- The install is finished — `installed_at` is set and is a real past date.
- It has been **2 or more days** since `installed_at` (compare against today;
  `installed_at` is a UTC timestamp, so compare on the date, not the clock).
- **Nothing has been collected** — `collected_total` from
  `get_job_financials` is `0` (treat anything under $1 as zero to absorb
  rounding). This is the heart of the rule: not "a balance remains," but
  "no money at all has come in."
- The job is not cancelled or lost (`status` is not `cancelled` / `lost`).

**Do NOT trust `paid_at` — it is a trap.** In live data, jobs with
`collected_total: 0` (nothing collected at all) still have a `paid_at`
timestamp set, because `paid_at` marks an internal pipeline milestone, not
actual money received. The ONLY authoritative "did money come in?" signal is
`collected_total` from `get_job_financials`. Always confirm there, never infer
collection from `paid_at`.

Jobs where *some* money has come in but a balance remains (partial payments)
do **not** meet the strict rule. They are still worth surfacing, so put them in
a separate **"partial — still owed"** section rather than mixing them into the
primary alerts. Keep the two clearly distinct so a rep knows which jobs have had
literally nothing collected versus which are half-done.

## How to find the jobs efficiently

There are thousands of historical completed jobs, and `list_jobs` returns at
most 50 rows with no date filter — so never try to scan all completed jobs.
Instead, funnel down to a small candidate set, then enrich only those.

**Step 1 — build the candidate set (cheap, a few calls):**

- `list_jobs(status="payments_invoicing", limit=50)` — this is the
  billing/collection stage where installed-but-unpaid jobs naturally sit. This
  is the primary pool for the follow-up rule.
- `ar_aging_report()` — one call returns every outstanding invoice with its
  `job_id`, `issue_date`, `total`, and `balance_due`, already bucketed by age.
  Any job here has an unpaid balance, whatever its status — this is the safety
  net that catches an uncollected `job_completed` job.
- `list_jobs(status="job_completed", limit=50)` — the closed pile is mostly
  paid, but sweep it too and keep only rows where `collected_total == 0`, so a
  completed-but-never-collected job doesn't slip through. Most will drop out.
- Optionally `list_jobs(status="production", limit=50)` if you want jobs that
  just wrapped install but haven't moved to invoicing yet.

Union the `job_id`s from these into one candidate list. This is the set of jobs
plausibly "installed but not collected" — usually dozens, not thousands.

**Step 2 — enrich and apply the rule (per candidate):**

- `get_job(id)` → read `installed_at`, `assigned_to`, `status`, customer name /
  phone, and insurance fields (`is_insurance_job`, `insurance_carrier`,
  `claim_number`, `deductible_amount`).
- `get_job_financials(id)` → read `collected_total`, `balance_due`,
  `invoiced_total`, `contract_amount`.
- Apply the detection rule above. Compute **days since install** =
  `today − date(installed_at)`.

Keep the candidate set focused so this stays a bounded number of calls. If the
candidate list is large, prioritize the oldest `installed_at` first (those are
the most at-risk dollars) and say so in the output rather than silently
truncating.

**Step 3 — group by rep.** Bucket the flagged jobs by `assigned_to`. Jobs with
`assigned_to` = `unassigned` (or null) go in an **"UNASSIGNED — needs an owner"**
bucket so they aren't lost.

See `references/data-model.md` for the exact field shapes and a worked example.

## Output format

### Rep alert (one per flagged job, or grouped per rep)

Address the rep by the name portion of their email. Lead with the money and the
age, because that's what drives urgency. Keep it short — a rep should be able to
act off it without opening anything.

```
@gdavis — collect on Job #135, Mike Caton (Odessa, MO)
Installed 4 days ago (Apr 30) · $0 collected of $19,000 · nothing in yet.
Go get the first check + deductible. Customer: (816) 285-6209.
```

For insurance jobs, name the pieces explicitly so the rep knows what to chase:

```
@cluna — collect on Job #5942, Jane Doe (Wichita, KS) — INSURANCE
Installed 6 days ago (Aug 4) · $0 collected of $25,482.
Carrier: State Farm · Claim #ABC123 · Deductible $2,500.
Chase the ACV/first check AND the $2,500 deductible.
```

### Weekly rollup (aggregated)

```
AR Follow-up — Weekly Collections Update (week of Aug 10)

Uncollected installed jobs (2+ days, nothing collected): 7 jobs · $141,204 at risk

By rep:
  cluna     — 3 jobs · $63,180   (oldest: Job #5924, installed 11 days ago)
  gdavis    — 2 jobs · $31,156   (oldest: Job #135,  installed 4 days ago)
  bsibbett  — 1 job  · $23,860   (Job #6044, installed 3 days ago)
  UNASSIGNED— 1 job  · $23,008   (Job #6071 — needs an owner)

Partial payments still owed (money in, balance remains): 4 jobs · $58,900
  ...

Action: each rep above owes a first-check + deductible follow-up this week.
```

Always include: count of jobs, total dollars at risk, per-rep breakdown, and the
oldest/most-at-risk job per rep. Dollars are what get attention — put the totals
up top.

## Delivery

There is no "message a rep" tool exposed, so the default is to **produce the
drafted messages as output** for the manager to send through their normal
channel (text, Slack, the morning huddle). Two options if asked:

- **Log it on the job** — `add_note(job_id, ...)` drops the follow-up note
  directly on the job in EaveSide so there's a record the rep was pinged. Only
  do this when the person explicitly wants notes written back; it changes data.
- **Draft only** (default) — output the text, change nothing.

Never send anything to the customer from this skill. `send_customer_notification`
is off-limits here — the follow-up is internal to the rep.

## Edge cases and judgment

- **Timezone / date math.** `installed_at` is a UTC timestamp. Compare on the
  calendar date against today so a job installed "2 days ago" isn't missed by a
  few hours. Today's date is provided in context.
- **Insurance vs retail — read `work_type`, not `is_insurance_job`.** In live
  data `is_insurance_job` is often `false` on jobs whose `work_type` is
  `"Insurance"`, and `insurance_carrier` / `deductible_amount` / `claim_number`
  are frequently null even then. So detect insurance from `work_type ==
  "Insurance"` and phrase the follow-up as "chase the first/ACV check and the
  deductible." If carrier/claim/deductible fields happen to be populated,
  include them; if not, still tell the rep it's an insurance job so they know to
  chase both pieces. `work_type == "Retail"` (or Commercial) just needs the
  initial payment — say "first payment" rather than "ACV check."
- **Not invoiced yet.** A completed job with `invoiced_total: 0` and
  `collected_total: 0` is the worst case — it hasn't even been billed. Flag it
  and note "not invoiced yet" so the rep/office fixes the billing gap too.
- **Install date missing.** Some jobs sit in the collection stage with an
  invoice and `collected_total: 0` but `installed_at` (and `install_date`) null
  — e.g. a job that's been invoiced before its install date got recorded. Don't
  silently skip these: surface them in a **"nothing collected — install date
  missing, verify"** note so the office both records the install and chases the
  money. Don't assume they're under 2 days old just because the date is blank.
- **Unassigned jobs.** Don't drop them — surface them in their own bucket so a
  manager can assign an owner.
- **Very old completed jobs.** If an ancient job surfaces with $0 collected,
  include it but flag the age loudly (e.g. "installed 300+ days ago") — that's
  either a real write-off risk or a data issue worth a human look.
- **Don't over-call.** If you find yourself about to enrich hundreds of jobs,
  stop and narrow the candidate set first (oldest-installed first), and tell the
  user you prioritized rather than scanning everything.

## Quick reference: the tools you'll use

| Need | Tool |
|------|------|
| Collection-stage jobs | `list_jobs(status="payments_invoicing")` |
| All outstanding invoices, aged | `ar_aging_report()` |
| Install date, rep, insurance fields, customer | `get_job(id)` |
| collected_total, balance_due, contract | `get_job_financials(id)` |
| Log a follow-up note on the job (opt-in) | `add_note(job_id, ...)` |

Full field shapes and a worked end-to-end example are in
`references/data-model.md` — read it if you're unsure which field to trust.
