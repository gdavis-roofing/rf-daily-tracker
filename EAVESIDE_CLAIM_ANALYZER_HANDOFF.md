# RF Claim Scope Analyzer → Eaveside Implementation Handoff

**From:** Roofing Force (George Davis)
**Reference implementation (working, public):** https://github.com/gdavis-roofing/rf-claim-analyzer — live at https://rf-hub.netlify.app (Claim Scope tab)
**Purpose:** Eaveside's Insurance Claim import currently produces wrong check amounts. This document specifies the exact behavior of RF's working analyzer so Eaveside can match it. Every formula below is taken verbatim from the working code, and a full worked example with expected outputs is included for verification.

---

## 1. The two defects observed in Eaveside today

Test claim: **State Farm, claim 360K4V361 (Reichert, Crystal), deductible $2,237.00, RCV policy.**

| Value | Eaveside shows | Correct (RF analyzer) | Cause |
|---|---|---|---|
| 1st Check | $9,025.34 | **$6,788.34** | Deductible never captured from the PDF → subtracted $0 instead of $2,237 |
| 2nd Check | $13,361.88 | **$13,616.93** | Paid-When-Incurred (PWI) item dropped → missing $255.05 |
| Out of Pocket | $0.00 | **$2,237.00** | Same missing deductible |
| Ice & water barrier line | $0.00 RCV | **$255.05 PWI** | RCV column read literally; PWI amount lives in the note text |

Both defects are data-capture problems, not formula problems. Sections 2–3 define the capture rules; section 4 defines the math; section 6 is the acceptance test.

---

## 2. Deductible capture (defect #1)

1. **Extract the deductible from the claim PDF's summary page** (`summaryDeductible`). Every carrier prints it in the payment summary (e.g. "Less Deductible −$2,237.00").
2. **Auto-fill the claim's deductible field** with the extracted value. The field must remain user-editable, and any edit must re-run all calculations live.
3. The deductible must default to the extracted value — never to 0 — whenever the summary page contains one. A blank deductible field silently producing "ACV − $0" is exactly the failure mode observed.

---

## 3. Paid When Incurred (PWI) capture (defect #2)

PWI items are scope lines the carrier will only pay **after** the work is performed (commonly ice & water barrier, drip edge / code-upgrade items).

**Detection** — a line item is PWI when the notes/comments printed under the line say any of:
- "paid when incurred"
- "payable when incurred"
- "code upgrade cost is payable when incurred"

**Amount extraction** — for PWI items the RCV column in the PDF is usually **blank or $0.00**. The real amount is in the note text, e.g.:

> "168.76 SF of Ice & water barrier @ $1.51 per SF = $255.05"

Extract the dollar amount from the note and store it as the item's PWI RCV. **Never leave a PWI item at $0 when the note contains a dollar amount.** (This is exactly what Eaveside did — it read the $0.00 column and the $255.05 vanished.)

Special case: if the summary page has a "Dwelling – Ordinance or Law – Code Upgrade Paid When Incurred" section (Travelers style), extract its "Total Paid When Incurred" as `codeUpgradeRCV` and prefer it over per-item amounts.

**Required UI behavior for PWI lines:**
- Cannot be declined (no decline checkbox).
- Show a checkbox: **"Paid when incurred — check if [contractor] will perform."**
- The PWI RCV amount is displayed in an editable field (rep can override, e.g. for a carrier code-upgrade bucket).
- Excluded from ACV/1st-check totals **whether or not the box is checked** (the carrier does not pay it up front).
- When checked ("will perform"): its RCV is **added to the 2nd check** and to the displayed total RCV.
- When unchecked: it contributes to nothing.

---

## 4. Calculation engine (verbatim from working implementation)

Inputs per line item: `rcv`, `recoverableDep`, `nonRecoverableDep`, `acv`, `paidWhenIncurred`, plus summary-page grand totals `summaryRCV`, `summaryRecDep`, `summaryNonRecDep`, `summaryNetClaim`, `deductible`.

Depreciation bracket rule when parsing line items: parentheses `(123.45)` = **recoverable** dep; angle brackets `<123.45>` = **non-recoverable** dep. Applies to all carriers.

```
trueACV      = summaryRCV − summaryRecDep − summaryNonRecDep      // ACV excluding PWI
firstCheck   = max(0, trueACV − deductible)

pwiPerformed = Σ pwiRCV of PWI items marked "will perform"

// If nothing is declined use the summary rec-dep (ground truth);
// if lines are declined, sum rec dep over non-declined, non-PWI lines only.
effectiveRecDep = anyDeclined ? Σ recoverableDep(non-declined, non-PWI)
                              : summaryRecDep
secondCheck  = effectiveRecDep + pwiPerformed

nonRecDepContracted = Σ nonRecoverableDep(non-declined, non-PWI)
declinedACV         = Σ acv(declined lines)            // + apportioned tax, see §5
outOfPocket  = max(0, deductible + nonRecDepContracted − declinedACV)

displayedTotalRCV = summaryRCV − Σ rcv(declined lines) + pwiPerformed
```

Key invariants:
- **PWI never counts toward ACV or the 1st check.** It moves money into the 2nd check only, and only when marked "will perform."
- Declining a line reduces displayed RCV and rec dep, and credits the line's ACV against the customer's out of pocket.
- Sanity check shown to the user: `firstCheck` must equal the summary page's **Net Claim** within $1.00 (when nothing is declined and no PWI). If not, show a warning instead of the "numbers verified" badge.

---

## 5. Sales tax handling (needed for correct totals on several carriers)

- Detect `taxMethod` from the line-item table headers: a per-line **TAX** column ⇒ `line_item` (tax already baked into each RCV — no extra handling). No TAX column ⇒ `summary` (tax added once on the summary page).
- **Shelter Insurance is always `summary`** regardless of columns.
- Auto-correct: if `summaryRCV − Σ line RCV (non-PWI) < $1.00`, force `line_item`.
- For `summary` carriers: extract the summary "Sales Tax x.xxx% … $y" line (`taxRate`, `taxAmount`). If Shelter and no tax line parsed, derive `taxAmount = summaryRCV − Σ line RCV`.
- Summary tax is apportioned between contracted and declined scope **by ACV ratio**, and the declined share is included in the declined-ACV credit against out of pocket.

---

## 6. Acceptance test — State Farm / Reichert claim

Parse the State Farm claim PDF (claim 360K4V361). Expected extraction:

| Field | Expected |
|---|---|
| summaryRCV (grand total, excl. PWI) | $22,387.22 |
| summaryRecDep | $13,361.88 |
| summaryNonRecDep | $0.00 |
| deductible (auto-filled) | $2,237.00 |
| Ice & water barrier (168.76 SF) | `paidWhenIncurred: true`, PWI RCV **$255.05** |

Expected outputs, no lines declined:

| Scenario | 1st Check | 2nd Check | Out of Pocket | Total RCV |
|---|---|---|---|---|
| PWI **unchecked** | $6,788.34 | $13,361.88 | $2,237.00 | $22,387.22 |
| PWI **checked** (RF will perform) | $6,788.34 | **$13,616.93** | $2,237.00 | **$22,642.27** |

Derivations: trueACV = 22,387.22 − 13,361.88 − 0 = **9,025.34**; 1st check = 9,025.34 − 2,237 = **6,788.34**; 2nd check (checked) = 13,361.88 + 255.05 = **13,616.93**.

An implementation that shows 1st check $9,025.34, 2nd check $13,361.88 with PWI checked, or out of pocket $0.00 on this claim **fails** the test.

---

## 7. Reference code map

| Behavior | File in `gdavis-roofing/rf-claim-analyzer` |
|---|---|
| PDF extraction rules (deductible, PWI note parsing, dep brackets, tax method, carrier quirks) | `api/parse-claim.js` — the extraction prompt |
| Live calculation engine | `public/index.html` — `recalcOOP()` |
| PWI row UI (checkbox, editable RCV, no decline) | `public/index.html` — `renderLineItems()` |
| Customer report math (declined credit, tax apportionment) | `public/index.html` — `generatePDF()` |
| Sanity checks | `public/index.html` — `recalcWarnings()` |

The repo is public — Eaveside's team can read the exact working code rather than reverse-engineering from this document.
