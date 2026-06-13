// US congressional trading (STOCK Act Periodic Transaction Reports) from the
// AInvest developer API (/ownership/congress). The endpoint is symbol-queryable,
// so — unlike the bulk Stock Watcher dumps — this is a per-ticker adapter that
// mirrors insider-sources.ts: the pipeline stage iterates watched tickers and
// this module fetches + normalizes one ticker's disclosures.
//
// AInvest reports the politician's party + state (not which chamber) and a coarse
// buy/sell side. It has no date-range parameter, so we page newest-first and stop
// once a page's rows all predate `since`. owner/ptrLink aren't supplied — they're
// kept on the row shape (always null) so a richer source can populate them later.

import { fetchWithRetry } from "@/lib/http";
import { marketNamesForTicker } from "@/lib/market-utils";

const AINVEST_BASE_URL = process.env.AINVEST_BASE_URL || "https://openapi.ainvest.com/open";
const PAGE_SIZE = 50;
const MAX_PAGES = 10; // safety bound — 500 most-recent disclosures per ticker is ample

// Free-tier pacing. AInvest throttles aggressively (status 4014), so requests run
// serially (concurrency 1 in the stage) with a fixed gap between them, plus a few
// backoff retries when we do get throttled. The 45-day disclosure lag makes the
// added latency irrelevant. All env-tunable; 0 disables the wait (used in tests).
const REQUEST_SPACING_MS = Number(process.env.CONGRESS_REQUEST_SPACING_MS ?? 1000);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.CONGRESS_RATE_LIMIT_BACKOFF_MS ?? 1000);
const RATE_LIMIT_RETRIES = 4;

// AInvest envelope status codes we special-case.
const AINVEST_OK = 0;
const AINVEST_UNKNOWN_TICKER = 4012; // non-US / unlisted symbol — a clean skip, not an error
const AINVEST_RATE_LIMITED = 4014; // free-tier frequency cap — retryable with backoff

// US exchanges in the app's market taxonomy (see market-utils). AInvest covers
// US-listed securities only.
const US_MARKETS = new Set(["NYSE", "NASDAQ"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Carries the AInvest envelope status_code so the caller can tell a benign
 *  unknown-ticker skip apart from a real failure. */
class AinvestError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "AinvestError";
  }
}

/** Normalized transaction side. AInvest only distinguishes buy/sell; EXCHANGE/OTHER
 *  are reserved so a richer source (full/partial sale, exchange) maps in cleanly. */
export type CongressTxnType = "PURCHASE" | "SALE" | "EXCHANGE" | "OTHER";

export type CongressTradeRow = {
  politician: string;
  party: string | null;
  state: string | null;
  owner: string | null; // not supplied by AInvest; reserved for a richer source
  txnType: CongressTxnType;
  amountRange: string; // verbatim range string, e.g. "$100K-$250K"
  transactionDate: Date;
  disclosureDate: Date;
  ptrLink: string | null; // not supplied by AInvest; reserved (http(s)-only when set)
  dedupKey: string;
};

/** Raw AInvest /ownership/congress row (only the fields we consume). */
type AinvestCongressRow = {
  name?: string;
  party?: string;
  state?: string;
  trade_date?: string; // YYYY-MM-DD
  filing_date?: string; // YYYY-MM-DD
  trade_type?: string; // "buy" | "sell"
  size?: string; // amount range, e.g. "$100K-$250K"
};

type AinvestEnvelope = {
  status_code?: number;
  status_msg?: string;
  data?: { data?: AinvestCongressRow[] } | AinvestCongressRow[];
};

/** True when the source is usable (AInvest key present). */
export function isCongressConfigured(): boolean {
  return !!process.env.AINVEST_API_KEY;
}

/**
 * AInvest is keyed by US ticker symbol and only knows US-listed securities, so
 * querying a foreign listing just returns 4012 "unknown ticker" and burns the
 * free-tier rate budget. Gate on the app's market mapping: US class shares like
 * BRK.B stay in (they resolve to NYSE/NASDAQ), while foreign exchanges (.L/.PA/
 * .MI/...) and crypto are skipped. This is a source-coverage filter, not a legal
 * one — the STOCK Act itself requires disclosing foreign-stock and crypto trades.
 */
export function isCongressEligible(ticker: string): boolean {
  return marketNamesForTicker(ticker).some((m) => US_MARKETS.has(m));
}

/** Map AInvest's coarse side (tolerating a few richer synonyms) to our taxonomy. */
export function normalizeCongressTxnType(raw: string | null | undefined): CongressTxnType {
  const t = (raw ?? "").toLowerCase();
  if (t.includes("buy") || t.includes("purchase")) return "PURCHASE";
  if (t.includes("sell") || t.includes("sale")) return "SALE";
  if (t.includes("exchange")) return "EXCHANGE";
  return "OTHER";
}

/** http(s)-only URL guard (mirrors the news-URL hardening): rejects javascript:/data:/etc.
 *  AInvest supplies no link today, but the column + this guard are ready for one. */
export function sanitizeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Parse YYYY-MM-DD (also tolerating MM/DD/YYYY) into a UTC Date; null if unparseable. */
export function parseCongressDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (us) [y, m, d] = [+us[3], +us[1], +us[2]];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Value-inclusive identity key so overlapping re-fetch windows upsert as no-ops;
 *  distinct disclosures (different date/side/amount) never collapse. */
export function buildCongressDedupKey(
  ticker: string,
  politician: string,
  tradeDate: Date,
  rawType: string,
  amountRange: string
): string {
  return [
    ticker.toUpperCase(),
    politician.trim().toLowerCase(),
    tradeDate.toISOString().slice(0, 10),
    (rawType ?? "").toLowerCase(),
    amountRange.trim(),
  ].join("|");
}

/** Normalize one raw AInvest row into a CongressTradeRow (pure; exported for tests).
 *  Returns null when the row lacks a usable politician name or transaction date. */
export function mapAinvestRow(ticker: string, raw: AinvestCongressRow): CongressTradeRow | null {
  const politician = raw.name?.trim();
  const transactionDate = parseCongressDate(raw.trade_date);
  if (!politician || !transactionDate) return null;

  const disclosureDate = parseCongressDate(raw.filing_date) ?? transactionDate;
  const amountRange = (raw.size ?? "").trim();
  const rawType = raw.trade_type ?? "";

  return {
    politician,
    party: raw.party?.trim() || null,
    state: raw.state?.trim() || null,
    owner: null,
    txnType: normalizeCongressTxnType(rawType),
    amountRange,
    transactionDate,
    disclosureDate,
    ptrLink: null,
    dedupKey: buildCongressDedupKey(ticker, politician, transactionDate, rawType, amountRange),
  };
}

function rowsOf(body: AinvestEnvelope): AinvestCongressRow[] {
  const data = body.data;
  if (Array.isArray(data)) return data; // tolerate a flatter envelope
  return data?.data ?? [];
}

async function fetchPage(ticker: string, page: number, apiKey: string): Promise<AinvestCongressRow[]> {
  const url = new URL(`${AINVEST_BASE_URL}/ownership/congress`);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(PAGE_SIZE));

  // fetchWithRetry covers transport/5xx; AInvest's rate limit is a 200 with a 4014
  // body, so we retry that here with exponential backoff.
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
      { timeoutMs: 30_000 }
    );
    if (!res.ok) throw new Error(`AInvest HTTP ${res.status}`);

    const body = (await res.json()) as AinvestEnvelope;
    if (body.status_code === AINVEST_OK) return rowsOf(body);

    if (body.status_code === AINVEST_RATE_LIMITED && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
      continue;
    }
    throw new AinvestError(body.status_code ?? -1, `AInvest status ${body.status_code}: ${body.status_msg ?? "error"}`);
  }
}

function dedupe(rows: CongressTradeRow[]): CongressTradeRow[] {
  return [...new Map(rows.map((r) => [r.dedupKey, r])).values()];
}

/**
 * Fetch normalized congress trades for one ticker transacted on/after `since`.
 * AInvest has no date filter, so we page newest-first and stop once a page holds
 * no in-window rows (older pages are then all out too) or a short page ends the
 * list. Returns `{ trades, error }`: a failure degrades to an error string and the
 * rows gathered so far, never throwing, so one ticker can't sink the stage. With
 * no key configured it's a clean empty result (no error).
 */
export async function getCongressTrades(
  ticker: string,
  since: Date
): Promise<{ trades: CongressTradeRow[]; error: string | null }> {
  const apiKey = process.env.AINVEST_API_KEY;
  if (!apiKey) return { trades: [], error: null };

  const out: CongressTradeRow[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (REQUEST_SPACING_MS > 0) await sleep(REQUEST_SPACING_MS); // pace under the free-tier cap
      const rows = await fetchPage(ticker, page, apiKey);
      if (rows.length === 0) break;

      let anyInWindow = false;
      for (const raw of rows) {
        const mapped = mapAinvestRow(ticker, raw);
        if (mapped && mapped.transactionDate >= since) {
          out.push(mapped);
          anyInWindow = true;
        }
      }
      // Newest-first: a full page with nothing in-window means every later page is
      // older still, and a short page is simply the last one.
      if (rows.length < PAGE_SIZE || !anyInWindow) break;
    }
  } catch (e) {
    // An unknown ticker (a listing AInvest doesn't cover) is a clean skip, not an
    // error — keeps the stage's errors array signal-only.
    if (e instanceof AinvestError && e.code === AINVEST_UNKNOWN_TICKER) {
      return { trades: dedupe(out), error: null };
    }
    return { trades: dedupe(out), error: `Congress fetch failed for ${ticker}: ${String(e)}` };
  }
  return { trades: dedupe(out), error: null };
}
