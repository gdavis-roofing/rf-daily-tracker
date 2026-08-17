# RF Claim Scope Analyzer → Eaveside Implementation Handoff

**From:** Roofing Force (George Davis)
**Reference implementation (working, public):** https://github.com/gdavis-roofing/rf-claim-analyzer — live at https://rf-hub.netlify.app (Claim Scope tab)
**Purpose:** Eaveside's Insurance Claim import currently produces wrong check amounts. This document specifies the exact behavior of RF's working analyzer so Eaveside can match it. Every formula below is taken verbatim from the working code, and a full worked example with expected outputs is included for verification.

---

## 1. The two defects observed in Eaveside today

Test claim: **State Farm, claim 360K4V361 (Reichert, Crystal), deductible $2,237.00, RCV policy.**

Verified against the actual claim PDF (page 3, "Summary for Coverage A"): RCV **$22,387.22**, Less Depreciation **(13,361.88)**, Less Deductible **(2,237.00)**, **Net Actual Cash Value Payment $6,788.34**. RF's report matches the carrier to the penny.

| Value | Eaveside shows | Correct (RF analyzer / carrier) | Cause |
|---|---|---|---|
| Imported deductible | $0.00 | **$2,237.00** | Printed twice on the claim (page 1 header "Deductible: $2,237.00" and summary "Less Deductible (2,237.00)") — never imported |
| 1st Check | $9,025.34 | **$6,788.34** | Missing deductible → subtracted $0 instead of $2,237 |
| 2nd Check | $13,361.88 | **$13,616.93** (PWI performed) | Paid-When-Incurred (PWI) item dropped → missing $255.05 |
| Out of Pocket | $0.00 | **$2,237.00** | Same missing deductible |
| Ice & water barrier line | $0.00 RCV | **$255.05 PWI** | RCV column read literally; PWI amount lives in the note text |
| Declining a line item | Reduces the 1st check | **Never changes the 1st check** | See §4 — declining changes the contract amount and out of pocket, not the carrier's ACV payment |

These are data-capture and modeling problems, not formula problems. Sections 2–4 define the rules; section 5 defines the math; section 7 is the acceptance test.

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
- "paid upon installation/documentation" (State Farm wording)

State Farm additionally prints **"PWARR"** in the ACV column instead of a dollar amount on these lines — treat that marker as PWI too.

**Amount extraction** — for PWI items the RCV column in the PDF is usually **blank or $0.00**. The real amount is in the note text. Verbatim from this claim (line 9):

> "Ice & water barrier — 168.76 SF — PWARR
> Code Item. Paid upon installation/documentation. Unit Price $1.48 Total $255.05"

Extract the dollar amount from the note ($255.05) and store it as the item's PWI RCV. **Never leave a PWI item at $0 when the note contains a dollar amount.** (This is exactly what Eaveside did — it read the $0.00 column and the $255.05 vanished.)

Special case: if the summary page has a "Dwelling – Ordinance or Law – Code Upgrade Paid When Incurred" section (Travelers style), extract its "Total Paid When Incurred" as `codeUpgradeRCV` and prefer it over per-item amounts.

**Required UI behavior for PWI lines:**
- Cannot be declined (no decline checkbox).
- Show a checkbox: **"Paid when incurred — check if [contractor] will perform."**
- The PWI RCV amount is displayed in an editable field (rep can override, e.g. for a carrier code-upgrade bucket).
- Excluded from ACV/1st-check totals **whether or not the box is checked** (the carrier does not pay it up front).
- When checked ("will perform"): its RCV is **added to the 2nd check** and to the displayed total RCV.
- When unchecked: it contributes to nothing.

---

## 4. Declined items: what changes and what never changes

When the customer declines line items (work the contractor will not perform):

**The 1st check NEVER changes.** The 1st check is the carrier's ACV payment on the **full approved scope** minus the deductible — the amount printed on the claim as "Net Actual Cash Value Payment." The carrier issues it regardless of which items the contractor performs. Declining items must not reduce it. (This is Eaveside's current behavior and it is wrong.)

**What declining DOES change:**

| Value | Effect of declining a line |
|---|---|
| 1st Check | **None — ever** |
| Contract amount (what the contractor signs for) | Reduced — contractor collects only the **RCV of performed work**: `summaryRCV − Σ rcv(declined) + PWI performed` |
| 2nd Check | Reduced only by the declined lines' **recoverable dep** (carrier releases rec dep only on completed work) |
| Out of Pocket | Reduced — the declined lines' **ACV is credited to the customer** against deductible + non-rec dep |

Worked example on this claim — decline line 1 (Tear off, $1,831.95, no dep) and line 21 (A/C comb, $185.53, no dep), declined ACV = $2,017.48:

- 1st check: **$6,788.34 — unchanged**
- Contract amount: 22,387.22 − 2,017.48 = **$20,369.74**
- 2nd check: **$13,361.88 — unchanged** (neither declined line carries rec dep)
- Out of pocket: max(0, 2,237.00 + 0 − 2,017.48) = **$219.52**

---

## 5. Calculation engine (verbatim from working implementation)

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
- **`firstCheck` is computed from summary-page totals only. Declined lines never enter the formula.**
- **PWI never counts toward ACV or the 1st check.** It moves money into the 2nd check only, and only when marked "will perform."
- Declining a line reduces displayed RCV (the contract amount) and rec dep, and credits the line's ACV against the customer's out of pocket — see §4.
- Sanity check shown to the user: `firstCheck` must equal the summary page's **Net Claim** within $1.00 (when nothing is declined and no PWI). If not, show a warning instead of the "numbers verified" badge.

---

## 6. Sales tax handling (needed for correct totals on several carriers)

- Detect `taxMethod` from the line-item table headers: a per-line **TAX** column ⇒ `line_item` (tax already baked into each RCV — no extra handling). No TAX column ⇒ `summary` (tax added once on the summary page).
- **Shelter Insurance is always `summary`** regardless of columns.
- Auto-correct: if `summaryRCV − Σ line RCV (non-PWI) < $1.00`, force `line_item`.
- For `summary` carriers: extract the summary "Sales Tax x.xxx% … $y" line (`taxRate`, `taxAmount`). If Shelter and no tax line parsed, derive `taxAmount = summaryRCV − Σ line RCV`.
- Summary tax is apportioned between contracted and declined scope **by ACV ratio**, and the declined share is included in the declined-ACV credit against out of pocket.

---

## 7. Acceptance test — State Farm / Reichert claim

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

Declined-items scenario — decline line 1 (Tear off, $1,831.95) and line 21 (A/C comb, $185.53), PWI unchecked:

| Value | Expected |
|---|---|
| 1st Check | **$6,788.34 — unchanged** |
| Contract amount / displayed RCV | $20,369.74 |
| 2nd Check | $13,361.88 (declined lines carry no rec dep) |
| Out of Pocket | $219.52 |

An implementation that shows 1st check $9,025.34, reduces the 1st check when items are declined, shows 2nd check $13,361.88 with PWI checked, or shows out of pocket $0.00 on this claim **fails** the test.

---

## 8. Payment tracking: field labels and the recovery total

Observed on Eaveside's claim form after the deductible import was fixed (deductible now imports at $2,237.00 — good):

**Field label.** The field labeled **"ACV (Initial Payment)"** holds $9,025.34. That is mislabeled: $9,025.34 is the **ACV amount** of the scope. The **initial payment** is ACV − deductible = **$6,788.34** — the check the carrier actually cuts (the claim's "Net Actual Cash Value Payment"). Label the field "ACV Amount" and derive Initial Payment = ACV − deductible.

**Payment Recovery total.** Eaveside shows Total **$24,624.22** = 9,025.34 (full ACV) + 2,237.00 (deductible) + 13,361.88 (dep received). This **double-counts the deductible by exactly $2,237.00** — the deductible is already inside the $9,025.34, then it is added again as its own step. The total exceeds the entire claim RCV, which means the customer would be over-billed by one deductible.

Correct steps and total:

| Step | Amount | Source |
|---|---|---|
| 1. Carrier ACV check | **$6,788.34** | ACV − deductible |
| 2. Customer deductible | $2,237.00 | Collected from customer |
| 3. Recoverable dep received | $13,361.88 | Carrier, after completion |
| **Total** | **$22,387.22** | **= contract RCV** |

**Invariant:** the payment-recovery total must equal the contract RCV (+ PWI performed + approved supplements). It can **never exceed** it. Any recovery total above RCV is a double count. (With the Ice & water PWI performed, the correct total is 22,387.22 + 255.05 = $22,642.27, and dep-received step becomes $13,616.93.)

**Recoverable Depreciation field must track declines.** Observed: declining three window lines correctly reduced the 2nd check to $10,780.66 (13,361.88 − 2,581.22 declined rec dep), but the "Recoverable Depreciation" field below stayed at $13,361.88. These are the same concept — rec dep on the work being performed — and **must always match**. The carrier releases depreciation only on completed work, so a stale $13,361.88 feeding the Payment Recovery tracker bills for depreciation that will never be paid. The original $13,361.88 may be shown only as a clearly-labeled "parsed from claim" reference value. Rule: every field that drives billing or payment recovery recomputes from the contracted (non-declined) scope, live, on every decline/undecline — none of them may hold the claim's static parsed value.

---

## 9. Reference code map

| Behavior | File in `gdavis-roofing/rf-claim-analyzer` |
|---|---|
| PDF extraction rules (deductible, PWI note parsing, dep brackets, tax method, carrier quirks) | `api/parse-claim.js` — the extraction prompt |
| Live calculation engine | `public/index.html` — `recalcOOP()` |
| PWI row UI (checkbox, editable RCV, no decline) | `public/index.html` — `renderLineItems()` |
| Customer report math (declined credit, tax apportionment) | `public/index.html` — `generatePDF()` |
| Sanity checks | `public/index.html` — `recalcWarnings()` |

The repo is public — Eaveside's team can read the exact working code rather than reverse-engineering from this document.
