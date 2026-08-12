# Restatement Authorization & Execution Directive

*Recorded 2026-08-12*

## Authorization

On 2026-08-12 the owner (geoandadri@gmail.com) reviewed the AccuLynx ↔ Eaveside
reconciliation summary (`reports/acculynx-reconciliation-2026-08-12.md`) and
approved open item 3 with the instruction: **"make the changes but keep a paper
trail."**

## Approved change (item 3 only)

Restate the **30 jobs** whose Eaveside invoice was raised for an amount different
from the contract value both systems agree on, where the migration payment entry
copied the same wrong figure. For each of the 30:

1. Set the Eaveside invoice total to the **AccuLynx approved contract value**.
2. Adjust the matching migration payment entry (source `acculynx_migration`) to
   the same corrected amount, so the invoice remains settled — AccuLynx confirms
   every one of these customers is paid in full.

Control totals the executed change MUST reproduce (from the reconciliation
working papers):

| | Jobs | Amount |
|---|---|---|
| Invoiced under contract (restate up) | 18 | +$49,844 |
| Invoiced over contract (restate down) | 12 | −$60,619 |
| Net effect on recognised revenue | 30 | **−$10,776** |

If the job list resolved at execution time does not tie to these totals
exactly, **stop and reconcile the list first** — do not proceed on a
population that doesn't match the approved working paper.

## Paper-trail requirements (owner condition of approval)

- **No silent overwrites.** Preserve every prior value: write the old invoice
  total, old payment amount, new value, and delta to an audit/quarantine record
  before mutating, per the safety rules in `Eaveside_Migration_Fix_MASTER_SPEC`
  (snapshot before write, soft-change only, idempotent re-runs).
- **Per-job note in Eaveside**, on each of the 30 jobs:
  "Invoice restated to AccuLynx approved contract value per owner authorization
  2026-08-12. Old invoice total $X → $Y; migration payment entry adjusted to
  match. No change to cash actually received."
- **Restatement register**: one row per job (job #, customer, invoice #, old
  total, new total, delta, timestamps, executed-by), filed with the accounting
  records alongside the per-job working papers, and a copy committed to this
  repository under `reports/`.
- **Post-run verification**: each of the 30 invoices equals the contract value;
  each payment equals its invoice; company-wide revenue delta equals −$10,776
  net; re-running the job changes nothing (idempotence check).

## Explicitly NOT authorized by this directive

- Items 1 and 2 of the report (jobs 1760, 5139, 6042, 1165) — still awaiting
  bank confirmation.
- Item 4 (job 3874, Ryan Imholz) — still awaiting materials cost from operations.
- Backfilling the nine pre-Eaveside jobs ($181,935) — remains deliberately
  untouched as pre-Eaveside history.

## Execution status

- 2026-08-12: Authorization recorded. Execution requires Eaveside database
  write access (invoice totals and migration payment entries are not writable
  through the Eaveside MCP tool surface available to the session that recorded
  this directive) and the per-job working paper listing the 30 jobs, both of
  which live with the environment that produced the reconciliation. Handed off
  for execution there; this file should be updated with the register location
  and completion date once the run is verified.
