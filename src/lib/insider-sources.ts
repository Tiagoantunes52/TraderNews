// Insider-trade aggregation, mirroring the news/price adapter pattern.
//
// Each provider is an InsiderSource that knows whether it's configured, which
// tickers it supports (insider/Form-4 data is US-equity only), and how to fetch
// + normalize transactions for one ticker. v1 ships a single Finnhub adapter;
// the adapter shape lets an EDGAR Form 4 source (which carries insider *roles*,
// enabling C-suite detection) slot in later without touching the pipeline stage.

import { getInsiderTransactions, type FinnhubInsiderTxn } from "@/lib/finnhub";
import { resolveCik, getForm4Filings, fetchForm4Xml, parseForm4, type Form4Owner, type Form4Transaction } from "@/lib/edgar";
import { isEtf } from "@/lib/etf";

/** Normalized SEC transaction taxonomy. Only the two OPEN_MARKET_* types are
 *  "conviction" signals; everything else is comp/admin noise (see normalizeTxnType). */
export type InsiderTxnType =
  | "OPEN_MARKET_BUY"
  | "OPEN_MARKET_SELL"
  | "GRANT"
  | "OPTION_EXERCISE"
  | "TAX_WITHHOLDING"
  | "GIFT"
  | "CONVERSION"
  | "OTHER";

export type InsiderTxn = {
  insiderName: string;
  // Role/relationship — only the EDGAR source populates these (Finnhub omits them).
  officerTitle: string | null;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPctOwner: boolean;
  transactionCode: string; // raw SEC code
  txnType: InsiderTxnType;
  isDerivative: boolean;
  isPlanned: boolean; // 10b5-1 (EDGAR aff10b5One)
  shares: number; // signed: + acquired, - disposed
  price: number | null;
  value: number | null; // |shares| * price (notional)
  sharesAfter: number | null;
  pctHoldingsChg: number | null; // |shares| / prior holdings, when computable
  transactionDate: Date;
  filingDate: Date;
  accessionId: string | null;
  dedupKey: string;
};

export type InsiderSource = {
  name: string;
  /** True when usable (e.g. API key present). */
  configured(): boolean;
  /** Insider data exists only for US-listed operating companies. */
  supports(ticker: string): boolean;
  /** Fetch + normalize transactions filed since `since` for one ticker. */
  fetch(ticker: string, since: Date): Promise<InsiderTxn[]>;
};

/** US operating company: no dot-exchange suffix, not crypto, not an ETF. */
export function isInsiderEligible(ticker: string): boolean {
  return !ticker.includes(".") && !ticker.endsWith("-USD") && !isEtf(ticker);
}

/**
 * Map an SEC transaction code to our normalized taxonomy. The point of this map
 * is the noise filter: only P (open-market buy) and S (open-market sell) carry
 * conviction; A (grant), M (option exercise), F (tax withholding), G (gift) and
 * conversions are compensation/admin mechanics that must never reach an alert.
 */
export function normalizeTxnType(code: string): InsiderTxnType {
  switch (code?.toUpperCase()) {
    case "P":
      return "OPEN_MARKET_BUY";
    case "S":
      return "OPEN_MARKET_SELL";
    case "A":
      return "GRANT";
    case "M":
      return "OPTION_EXERCISE";
    case "F":
      return "TAX_WITHHOLDING";
    case "G":
      return "GIFT";
    case "C":
    case "X":
      return "CONVERSION";
    default:
      return "OTHER";
  }
}

const dateStr = (d: Date) => d.toISOString().split("T")[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * True when an officer title is C-suite level (CEO/CFO/COO/President/Chair) — the
 * conviction tier for insider buys. Excludes VPs and accounting/controller roles
 * (e.g. "Principal Accounting Officer"), which file as officers but aren't C-suite.
 */
export function isCsuiteTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/chief\s+(executive|financial|operating)\s+officer/.test(t)) return true;
  if (/principal\s+(executive|financial)\s+officer/.test(t)) return true;
  if (/\b(ceo|cfo|coo)\b/.test(t)) return true;
  if (/\bchair(man|woman|person)?\b/.test(t)) return true;
  if (/\bpresident\b/.test(t) && !/vice\s+president/.test(t)) return true;
  return false;
}

/** Identity key shared across sources so EDGAR and Finnhub rows for the same SEC
 *  transaction collapse. Value-inclusive: re-fetches no-op, distinct lines stay. */
function buildDedupKey(ticker: string, name: string, txDate: Date, code: string, signedShares: number, price: number): string {
  return [ticker, name, dateStr(txDate), code, signedShares, price].join("|");
}

/** Normalize one raw Finnhub row into an InsiderTxn (pure; exported for tests). */
export function mapFinnhubTxn(ticker: string, raw: FinnhubInsiderTxn): InsiderTxn {
  const shares = raw.change;
  const price = raw.transactionPrice > 0 ? raw.transactionPrice : null;
  const value = price != null ? Math.abs(shares) * price : null;
  const sharesAfter = Number.isFinite(raw.share) ? raw.share : null;
  const prior = sharesAfter != null ? sharesAfter - shares : null;
  const pctHoldingsChg = prior != null && prior > 0 ? Math.abs(shares) / prior : null;

  const txDate = new Date(raw.transactionDate);
  const filingDate = raw.filingDate ? new Date(raw.filingDate) : txDate;

  return {
    insiderName: raw.name,
    officerTitle: null, // Finnhub does not report role/title
    isOfficer: false,
    isDirector: false,
    isTenPctOwner: false,
    transactionCode: raw.transactionCode,
    txnType: normalizeTxnType(raw.transactionCode),
    isDerivative: !!raw.isDerivative,
    isPlanned: false,
    shares,
    price,
    value,
    sharesAfter,
    pctHoldingsChg,
    transactionDate: txDate,
    filingDate,
    accessionId: raw.id ?? null,
    dedupKey: buildDedupKey(ticker, raw.name, txDate, raw.transactionCode, shares, raw.transactionPrice),
  };
}

/** Build an InsiderTxn from a parsed EDGAR Form 4 transaction (carries role data). */
export function mapEdgarTxn(
  ticker: string,
  owner: Form4Owner | null,
  isPlanned: boolean,
  txn: Form4Transaction,
  filingDate: string
): InsiderTxn {
  const shares = txn.acquired ? txn.shares : -txn.shares; // sign by acquired/disposed
  const price = txn.price && txn.price > 0 ? txn.price : null;
  const value = price != null ? Math.abs(shares) * price : null;
  const sharesAfter = txn.sharesAfter;
  const prior = sharesAfter != null ? sharesAfter - shares : null;
  const pctHoldingsChg = prior != null && prior > 0 ? Math.abs(shares) / prior : null;
  const txDate = new Date(txn.transactionDate);
  const name = owner?.name ?? "Unknown";

  return {
    insiderName: name,
    officerTitle: owner?.officerTitle ?? null,
    isOfficer: owner?.isOfficer ?? false,
    isDirector: owner?.isDirector ?? false,
    isTenPctOwner: owner?.isTenPctOwner ?? false,
    transactionCode: txn.code,
    txnType: normalizeTxnType(txn.code),
    isDerivative: false,
    isPlanned,
    shares,
    price,
    value,
    sharesAfter,
    pctHoldingsChg,
    transactionDate: txDate,
    filingDate: new Date(filingDate),
    accessionId: null,
    dedupKey: buildDedupKey(ticker, name, txDate, txn.code, shares, price ?? 0),
  };
}

export const finnhubInsiderSource: InsiderSource = {
  name: "Finnhub",
  configured: () => !!process.env.FINNHUB_API_KEY,
  supports: isInsiderEligible,
  async fetch(ticker, since) {
    const rows = await getInsiderTransactions(ticker, dateStr(since), dateStr(new Date()));
    const out = rows
      .filter((r) => r.name && r.transactionCode && r.transactionDate)
      .map((r) => mapFinnhubTxn(ticker, r));

    // Collapse any duplicate dedupKeys within a single response.
    return [...new Map(out.map((t) => [t.dedupKey, t])).values()];
  },
};

// SEC EDGAR Form 4 — adds the insider's role/title (enabling the C-suite signal)
// and the structured 10b5-1 flag. Heavier than Finnhub (one HTTP fetch per
// filing), so it's opt-in via INSIDER_EDGAR=1. When enabled it's the preferred
// source; Finnhub stays as the fallback (see getInsiderTxns).
const EDGAR_MAX_FILINGS = Number(process.env.INSIDER_EDGAR_MAX_FILINGS) || 80;

export const edgarInsiderSource: InsiderSource = {
  name: "EDGAR",
  configured: () => process.env.INSIDER_EDGAR === "1",
  supports: isInsiderEligible,
  async fetch(ticker, since) {
    const cik = await resolveCik(ticker);
    if (!cik) return []; // not in SEC's ticker map → let the caller fall back

    const filings = (await getForm4Filings(cik, since)).slice(0, EDGAR_MAX_FILINGS);
    const out: InsiderTxn[] = [];
    for (const f of filings) {
      try {
        const xml = await fetchForm4Xml(cik, f.accession, f.rawDoc);
        const parsed = parseForm4(xml, { filingDate: f.filingDate });
        for (const t of parsed.transactions) {
          out.push(mapEdgarTxn(ticker, parsed.owner, parsed.isPlanned, t, f.filingDate));
        }
      } catch {
        // One unreadable filing shouldn't sink the whole ticker — skip it.
      }
      await sleep(180); // stay well under SEC's ~10 req/s
    }
    return [...new Map(out.map((t) => [t.dedupKey, t])).values()];
  },
};

// EDGAR first (richer, opt-in), Finnhub as the always-on fallback.
export const DEFAULT_INSIDER_SOURCES: InsiderSource[] = [edgarInsiderSource, finnhubInsiderSource];

/**
 * Fetch normalized insider transactions for one ticker. Tries each configured,
 * supporting source in order and returns the first non-empty result; falls
 * through on error or empty so an EDGAR hiccup degrades to Finnhub. Returns `[]`
 * (no error) for unsupported tickers, so non-US/ETF/crypto are a clean skip.
 */
export async function getInsiderTxns(
  ticker: string,
  since: Date,
  sources: InsiderSource[] = DEFAULT_INSIDER_SOURCES
): Promise<{ txns: InsiderTxn[]; source: string | null }> {
  for (const source of sources) {
    if (!source.configured() || !source.supports(ticker)) continue;
    try {
      const txns = await source.fetch(ticker, since);
      if (txns.length > 0) return { txns, source: source.name };
    } catch {
      // try the next source
    }
  }
  return { txns: [], source: null };
}
