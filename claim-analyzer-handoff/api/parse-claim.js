export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';

async function compressPdfBase64(base64) {
  const pdfBytes = Buffer.from(base64, 'base64');
  const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();
  const pages = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  pages.forEach(page => newDoc.addPage(page));
  const compressed = await newDoc.save({ useObjectStreams: true });
  return Buffer.from(compressed).toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let raw = null;
  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'No PDF data provided' });

    let finalBase64 = pdfBase64;
    if (pdfBase64.length > 4000000) {
      console.log('Large PDF detected, compressing...');
      finalBase64 = await compressPdfBase64(pdfBase64);
      console.log(`Compressed: ${pdfBase64.length} -> ${finalBase64.length} chars`);
    }

    const client = new Anthropic();
    const stream = client.messages.stream({
      model: 'claude-opus-4-5',
      max_tokens: 32000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: finalBase64 } },
        { type: 'text', text: 'Read this insurance claim PDF and extract ALL line items. Return ONLY valid JSON — no preamble, no markdown fences, no explanation.\n\nJSON structure:\n{\n  "carrier": "string",\n  "policyType": "RCV",\n  "hasOP": false,\n  "opTotal": 0,\n  "summaryRCV": 0,\n  "summaryRecDep": 0,\n  "summaryNonRecDep": 0,\n  "summaryACV": 0,\n  "summaryDeductible": 0,\n  "summaryNetClaim": 0,\n  "summaryNetIfRecovered": 0,\n  "taxRate": 0,\n  "taxMethod": "summary",\n  "taxAmount": 0,\n  "customerName": "string",\n  "propertyAddress": "string",\n  "claimNumber": "string",\n  "deductible": 0,\n  "lineItems": [{"lineNumber":1,"description":"string","quantity":"1.00 EA","rcv":0,"recoverableDep":0,"nonRecoverableDep":0,"acv":0,"paidWhenIncurred":true,"section":"string"}]\n}\n\nRules: Include every line item. Dollar amounts as plain numbers. Read summary values from the printed summary page. IMPORTANT: For summaryRCV, summaryRecDep, summaryNonRecDep, summaryACV — always use the GRAND TOTAL across ALL coverages, not individual coverage summaries. For USAA/AllCat this is the final "Line Item Totals" row or the Coverage breakdown table showing the combined total of Dwelling + Other Structures + all coverages. For Shelter and Auto-Owners use their single summary page total. For Farm Bureau, use the "Replacement Cost Value" line from their summary page (labeled "Summary for Extended Coverage - Structure" or similar) — this is always the correct summaryRCV. Farm Bureau may use either recoverable (parentheses) or non-recoverable (angle brackets) depreciation depending on roof age — under 7 years is recoverable, over 7 years is non-recoverable; always follow the bracket notation in the line items. IMPORTANT: To determine taxMethod, look at the column headers of the line item table in the PDF. If the headers include a "TAX" column with dollar amounts per line, tax is already baked into each line item RCV — set taxMethod to "line_item". If no TAX column exists in the line item headers, tax is only applied at the summary level — set taxMethod to "summary". This visual detection rule applies universally to ALL carriers regardless of name. EXCEPTION: Shelter Insurance always uses taxMethod "summary" regardless of what columns appear — never set Shelter to "line_item". Never use a per-coverage subtotal when a grand total is available. For taxRate and taxAmount: on the summary page, look for any line that mentions "Sales Tax" followed by a percentage and a dollar amount (e.g. "Sales Tax 9.500% (applies to materials only, some items overridden): $4,321.69"). Extract the percentage as taxRate (e.g. 9.5) and the dollar amount on that same line as taxAmount (e.g. 4321.69). If no such line exists on the summary page, set both to 0. For summaryNetIfRecovered: find the "Net Estimate if Depreciation Is Recovered" or equivalent total on the summary page. For propertyAddress: extract the physical loss/property location address. Check these in order: (1) Look for "Loss Location:" on the cover/first page — Shelter Insurance uses this label and it is the most reliable source. (2) Look for "Property:" label near the insured name. (3) Look for "Property Address:" anywhere in the document. (4) For Shelter, the address also appears as a mailing address block directly under the insured name on page 1 (no label — just street, city, state zip on separate lines). Return the full street address including city, state and zip as a single string. For section: use the structure or area name the line item belongs to (e.g. "Dwelling", "Storage Shed", "Barn", "Detached Garage", "Other Structures") — this comes from the area/section header above the line item in the PDF. For codeUpgradeRCV: if the claim has a "Dwelling - Ordinance or Law - Code Upgrade Paid When Incurred" section on the summary page, extract the "Total Paid When Incurred" dollar amount from that section and set codeUpgradeRCV to that value; otherwise set to 0. For paidWhenIncurred: read ALL notes and comments printed below each line item. Set to true if the notes say "payable when incurred" or "paid when incurred" or "code upgrade cost is payable when incurred". IMPORTANT: When paidWhenIncurred is true, the RCV column in the PDF is often blank or missing. In that case, extract the RCV dollar amount from the note text below the item (e.g. "476.92 LF of Drip Edge @ $2.70 per LF = $1,287.68" means rcv: 1287.68). Never leave rcv as 0 for a PWI item if a dollar amount can be found in the note text. Set to false for all other items. For recoverableDep and nonRecoverableDep: depreciation notation in the PDF uses two different bracket styles. Parentheses (amount) mean RECOVERABLE depreciation — put the value in recoverableDep and set nonRecoverableDep to 0. Angle brackets <amount> mean NON-RECOVERABLE depreciation — put the value in nonRecoverableDep and set recoverableDep to 0. This rule applies universally to all carriers including Auto-Owners, State Farm, Shelter, and USAA. Never assign angle bracket depreciation to recoverableDep. Return ONLY the JSON object.' }
      ]}]
    });
    const response = await stream.finalMessage();
    raw = response.content[0].text;
    console.log('stop_reason:', response.stop_reason, 'raw.length:', raw.length);
    if (response.stop_reason === 'max_tokens') {
      console.error('Response truncated at max_tokens. raw.length:', raw.length, 'tail:', raw.slice(-500));
      return res.status(500).json({
        error: 'Response truncated: the model hit max_tokens before finishing the JSON. Raise max_tokens or split the PDF.',
        stop_reason: response.stop_reason,
        rawLength: raw.length,
        raw,
      });
    }
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return res.status(500).json({ error: 'Failed to parse AI response as JSON', raw });
    const parsed = JSON.parse(raw.slice(first, last + 1));
    const pwiItems = parsed.lineItems?.filter(i => i.paidWhenIncurred) || [];
    console.log('PWI items found:', pwiItems.length, pwiItems.map(i => i.description));
      // Auto-correct taxMethod: if summaryRCV matches line item sum, tax is baked in (line_item)
  // Shelter always stays summary regardless
  const _isShelt = (parsed.carrier||'').toLowerCase().includes('shelter');
  if (!_isShelt) {
    const _lineSum = (parsed.lineItems||[]).filter(i=>!i.paidWhenIncurred).reduce((s,i)=>s+(i.rcv||0),0);
    const _gap = (parsed.summaryRCV||0) - _lineSum;
    if (_gap < 1.00) {
      parsed.taxMethod = 'line_item';
      parsed.taxAmount = 0;
      parsed.taxRate = 0;
    } else {
      parsed.taxMethod = 'summary';
    }
  }
  console.log('PARSED DATA:', JSON.stringify({taxMethod: parsed.taxMethod, taxRate: parsed.taxRate, taxAmount: parsed.taxAmount, summaryRCV: parsed.summaryRCV}));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(200).json(parsed);
  } catch (error) {
    console.error('Error:', error);
    if (raw !== null) {
      console.error('Raw model response (length', raw.length, '):', raw);
    }
    return res.status(500).json({
      error: error.message,
      rawLength: raw === null ? null : raw.length,
      raw,
    });
  }
}
