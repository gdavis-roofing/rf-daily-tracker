# RF Claim Scope Analyzer — Handoff for EaveSide Integration

This folder is a complete snapshot of the RF Claim Scope Analyzer so it can be
tied into EaveSide: the goal is for a rep viewing a job in EaveSide to click a
link and have the insurance claim analyzed.

- **Live app:** https://rf-claim-analyzer.vercel.app
- **Source of truth (repo):** https://github.com/gdavis-roofing/rf-claim-analyzer (public)
- **Hosting:** Vercel project `rf-claim-analyzer` (team `gdavis-roofings-projects`)

## What it does

1. Rep uploads an insurance claim PDF (drag/drop or file picker).
2. The PDF is POSTed to `/api/parse-claim`, a Vercel serverless function that
   sends the document to the Claude API and gets back structured JSON:
   carrier, customer name, property address, claim number, summary financials
   (RCV, recoverable/non-recoverable depreciation, ACV, deductible, net claim),
   tax handling, and **every line item** with per-item RCV/depreciation/ACV,
   section, and paid-when-incurred detection.
3. The frontend renders the summary and line items. The rep can include or
   decline scope items; the app recalculates the customer's out-of-pocket live.
4. "Generate Customer Report" produces a clean, customer-facing printable report.

Carrier-specific parsing rules are already tuned for USAA/AllCat, State Farm,
Shelter, Auto-Owners, and Farm Bureau (grand-total selection, bracket-style
depreciation notation, tax-column detection, PWI note extraction). All of that
lives in the prompt inside `api/parse-claim.js`.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | Entire frontend (single file, no build step). Upload, client-side PDF rasterization/compression for large files, results UI, out-of-pocket calc, report generator. |
| `api/parse-claim.js` | Vercel serverless function. Accepts `{ pdfBase64 }`, compresses >4MB payloads with pdf-lib, calls Claude (`claude-opus-4-5`, PDF document input), post-processes/normalizes the JSON, returns it. |
| `package.json` | Two deps: `@anthropic-ai/sdk`, `pdf-lib`. ESM (`"type": "module"`). |
| `vercel.json` | Routes `/api/*` to functions (300s max duration) and everything else to `public/index.html`. |

## Running / deploying it

No build step. On Vercel: import the repo, set one environment variable, deploy.

- `ANTHROPIC_API_KEY` — required by the serverless function (the SDK reads it
  automatically). **Not included in this handoff — get the key from Geo
  directly, or use EaveSide's own Anthropic key.**

Local dev: `npm install` then `vercel dev`.

## API contract

`POST /api/parse-claim`

```json
{ "pdfBase64": "<base64 of the claim PDF, no data: prefix>", "filename": "claim.pdf" }
```

Response `200`:

```json
{
  "carrier": "State Farm",
  "policyType": "RCV",
  "customerName": "…",
  "propertyAddress": "…",
  "claimNumber": "…",
  "summaryRCV": 0, "summaryRecDep": 0, "summaryNonRecDep": 0,
  "summaryACV": 0, "summaryDeductible": 0, "summaryNetClaim": 0,
  "summaryNetIfRecovered": 0,
  "taxMethod": "summary | line_item", "taxRate": 0, "taxAmount": 0,
  "hasOP": false, "opTotal": 0, "deductible": 0,
  "lineItems": [
    { "lineNumber": 1, "description": "…", "quantity": "1.00 EA",
      "rcv": 0, "recoverableDep": 0, "nonRecoverableDep": 0, "acv": 0,
      "paidWhenIncurred": false, "section": "Dwelling" }
  ]
}
```

Errors come back as `{ "error": "…" }` with status 4xx/5xx (including a
specific truncation error if the model hits max_tokens on a huge claim).

Notes on the request path:
- Function body limit is 10MB; the frontend rasterizes larger PDFs down to
  ~4MB client-side before sending. If EaveSide calls the API server-side, keep
  payloads under 10MB (or reuse the compression approach in `index.html`).
- Parsing a claim typically takes 1–3 minutes for big claims — the function
  allows up to 300s. Show a spinner.

## Integration options for EaveSide (simplest → deepest)

**A. Plain link (works today, zero code).** Put a "Analyze Claim" link on the
EaveSide job page pointing at `https://rf-claim-analyzer.vercel.app`. Rep
clicks, uploads the claim PDF from the job's documents, done.

**B. Deep link with auto-load (small frontend change).** EaveSide already
stores the claim PDF as a job document. Add support for
`?pdfUrl=<signed-url>&customer=<name>` to `index.html`: on load, fetch the
PDF, convert to base64, and kick off `parseClaim()` automatically — the rep
clicks one link in EaveSide and lands on a claim that's already analyzing.
Requirements: the signed URL must be CORS-readable from the analyzer's origin
(or proxy the fetch through a tiny `/api/fetch-pdf` function).

**C. Server-side (deepest).** EaveSide's backend POSTs the stored claim PDF to
`/api/parse-claim` (or hosts a copy of the function itself) and renders the
JSON natively in the EaveSide job view — no separate UI at all. The JSON above
has everything needed to rebuild the scope table and out-of-pocket math.

## Things to know before wiring it up

- **No CORS headers** are set on `/api/parse-claim` today. Same-origin calls
  from the analyzer's own frontend work fine; if EaveSide's browser code calls
  the API cross-origin, add `Access-Control-Allow-Origin` (plus OPTIONS
  handling) to the function — or call it server-to-server, which needs nothing.
- **No auth** on the endpoint. Each call costs real Anthropic tokens, so once
  it's linked from EaveSide, consider a shared-secret header check in the
  function (EaveSide sends `X-RF-Key`, function rejects without it).
- The model is pinned to `claude-opus-4-5` with `max_tokens: 32000` — that
  headroom matters for 200+ line-item claims; don't lower it.
- The carrier rules in the prompt encode a lot of hard-won fixes (Farm Bureau
  depreciation brackets, Shelter tax handling, PWI RCV extraction from note
  text). Treat the prompt as load-bearing; change it carefully.
