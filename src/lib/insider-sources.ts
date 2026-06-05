// Insider-trade aggregation, mirroring the news/price adapter pattern.
//
// Each provider is an InsiderSource that knows whether it's configured, which
// tickers it supports (insider/Form-4 data is US-equity only), and how to fetch
// + normalize transactions for one ticker. v1 ships a single Finnhub adapter;
// the adapter shape lets an EDGAR Form 4 source (which carries insider *roles*,
// enabling C-suite detection) slot in later without touching the pipeline stage.

import { getInsiderTransactions, type FinnhubInsiderTxn } from "@/lib/finnhub";
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
  transactionCode: string; // raw SEC code
  txnType: InsiderTxnType;
  isDerivative: boolean;
  isPlanned: boolean; // 10b5-1; always false until EDGAR is wired in
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

  // Value-inclusive identity key: re-fetches of the same row upsert as no-ops,
  // distinct lines never collapse. Ticker is unique, so it scopes the key per stock.
  const dedupKey = [ticker, raw.name, dateStr(txDate), raw.transactionCode, shares, raw.transactionPrice].join("|");

  return {
    insiderName: raw.name,
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
    dedupKey,
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

export const DEFAULT_INSIDER_SOURCES: InsiderSource[] = [finnhubInsiderSource];

/**
 * Fetch normalized insider transactions for one ticker from the first configured
 * source that supports it. Returns `[]` (no error) for unsupported tickers, so the
 * caller can treat non-US/ETF/crypto as a clean skip.
 */
export async function getInsiderTxns(
  ticker: string,
  since: Date,
  sources: InsiderSource[] = DEFAULT_INSIDER_SOURCES
): Promise<{ txns: InsiderTxn[]; source: string | null }> {
  for (const source of sources) {
    if (!source.configured() || !source.supports(ticker)) continue;
    const txns = await source.fetch(ticker, since);
    return { txns, source: source.name };
  }
  return { txns: [], source: null };
}
