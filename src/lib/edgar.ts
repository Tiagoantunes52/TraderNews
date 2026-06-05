// SEC EDGAR client + Form 4 (insider ownership) parser.
//
// Free and keyless, but the SEC REQUIRES a descriptive User-Agent (it 403s
// without one) and asks for <10 req/s. We resolve ticker→CIK once (cached), list
// a company's recent Form 4 filings via the submissions API, then fetch + parse
// the raw ownership XML. EDGAR's value over Finnhub is the reporting owner's
// ROLE (officer/director/title) and the structured 10b5-1 flag — which is what
// powers the C-suite conviction-buy signal.

import { fetchWithRetry } from "@/lib/http";

const SEC_UA = process.env.SEC_USER_AGENT || "TraderNews-insider/1.0 (contact@example.com)";

function secGet(url: string) {
  return fetchWithRetry(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" } });
}

// ── Ticker → CIK (cached for the process lifetime) ──────────────────────────

let cikMap: Map<string, string> | null = null;

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikMap) return cikMap;
  const res = await secGet("https://www.sec.gov/files/company_tickers.json");
  if (!res.ok) throw new Error(`SEC company_tickers ${res.status}`);
  const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
  const m = new Map<string, string>();
  for (const k of Object.keys(data)) {
    const e = data[k];
    if (e?.ticker) m.set(e.ticker.toUpperCase(), String(e.cik_str).padStart(10, "0"));
  }
  cikMap = m;
  return m;
}

export async function resolveCik(ticker: string): Promise<string | null> {
  const m = await loadCikMap();
  return m.get(ticker.toUpperCase()) ?? null;
}

// ── Filing list + document fetch ────────────────────────────────────────────

export type Form4Filing = { accession: string; filingDate: string; rawDoc: string };

/** Recent Form 4 filings for a CIK, filed on/after `since`. */
export async function getForm4Filings(cik10: string, since: Date): Promise<Form4Filing[]> {
  const res = await secGet(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  if (!res.ok) throw new Error(`SEC submissions ${res.status}`);
  const data = (await res.json()) as { filings?: { recent?: Record<string, unknown[]> } };
  const r = data.filings?.recent;
  if (!r || !Array.isArray(r.form)) return [];

  const sinceStr = since.toISOString().split("T")[0];
  const out: Form4Filing[] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== "4") continue;
    const filingDate = String(r.filingDate[i] ?? "");
    if (filingDate < sinceStr) continue;
    // primaryDocument points at the XSL-rendered view (xslF345X06/form4.xml);
    // strip the stylesheet prefix to get the raw ownership XML filename.
    const rawDoc = String(r.primaryDocument[i] ?? "form4.xml").replace(/^xsl[^/]*\//, "");
    out.push({ accession: String(r.accessionNumber[i]), filingDate, rawDoc });
  }
  return out;
}

export async function fetchForm4Xml(cik10: string, accession: string, rawDoc: string): Promise<string> {
  const cikNoZeros = String(Number(cik10));
  const accNoDashes = accession.replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accNoDashes}/${rawDoc}`;
  const res = await secGet(url);
  if (!res.ok) throw new Error(`SEC form4 doc ${res.status}`);
  return res.text();
}

// ── Form 4 XML parsing (pure; exported for tests) ───────────────────────────

export type Form4Owner = {
  name: string;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPctOwner: boolean;
  officerTitle: string | null;
};

export type Form4Transaction = {
  transactionDate: string; // YYYY-MM-DD
  code: string; // raw SEC transaction code
  shares: number; // unsigned magnitude
  price: number | null;
  acquired: boolean; // true = acquired (A), false = disposed (D)
  sharesAfter: number | null;
};

export type ParsedForm4 = {
  issuerSymbol: string | null;
  owner: Form4Owner | null;
  isPlanned: boolean; // aff10b5One
  transactions: Form4Transaction[];
};

function firstBlock(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

function allBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/** Leaf text of <tag>, unwrapping a nested <value> if present (Form 4 wraps most
 *  fields as <field><value>X</value></field>; relationship booleans are direct). */
function leaf(block: string, tag: string): string | null {
  const wrap = firstBlock(block, tag);
  if (wrap == null) return null;
  const v = wrap.match(/<value>([\s\S]*?)<\/value>/);
  return (v ? v[1] : wrap).trim() || null;
}

function boolLeaf(block: string, tag: string): boolean {
  const v = leaf(block, tag);
  return v === "true" || v === "1";
}

function numLeaf(block: string, tag: string): number | null {
  const v = leaf(block, tag);
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function parseForm4(xml: string, opts: { filingDate?: string } = {}): ParsedForm4 {
  const issuer = firstBlock(xml, "issuer");
  const issuerSymbol = issuer ? leaf(issuer, "issuerTradingSymbol") : null;

  const ownerBlock = firstBlock(xml, "reportingOwner");
  let owner: Form4Owner | null = null;
  if (ownerBlock) {
    const name = leaf(ownerBlock, "rptOwnerName");
    const rel = firstBlock(ownerBlock, "reportingOwnerRelationship") ?? "";
    if (name) {
      owner = {
        name,
        isOfficer: boolLeaf(rel, "isOfficer"),
        isDirector: boolLeaf(rel, "isDirector"),
        isTenPctOwner: boolLeaf(rel, "isTenPercentOwner"),
        officerTitle: leaf(rel, "officerTitle"),
      };
    }
  }

  const isPlanned = boolLeaf(xml, "aff10b5One");

  const transactions: Form4Transaction[] = [];
  for (const block of allBlocks(xml, "nonDerivativeTransaction")) {
    const code = leaf(block, "transactionCode");
    const date = leaf(block, "transactionDate");
    const shares = numLeaf(block, "transactionShares");
    if (!code || !date || shares == null) continue; // not a real transaction line

    transactions.push({
      transactionDate: date,
      code,
      shares: Math.abs(shares),
      price: numLeaf(block, "transactionPricePerShare") || null, // 0/empty → null
      acquired: leaf(block, "transactionAcquiredDisposedCode") !== "D",
      sharesAfter: numLeaf(block, "sharesOwnedFollowingTransaction"),
    });
  }

  // opts.filingDate is carried through by the caller (it lives in the submissions
  // index, not the XML); kept in the signature so callers pass it explicitly.
  void opts.filingDate;

  return { issuerSymbol, owner, isPlanned, transactions };
}
