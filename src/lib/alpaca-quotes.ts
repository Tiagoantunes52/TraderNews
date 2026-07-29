// Live intraday prices from Alpaca's Market Data API (issue: the sim prices trades at
// a close the broker can never fill at).
//
// WHY THIS EXISTS
// Every price in this app is a stored daily close. The paper stage decides after the
// close and books its simulated fill AT that close, while the broker's order can only
// execute later — so the two records describe different events, and the difference is
// not noise but a bias: a buy limit set from the prior close fills when a name gaps down
// and fails when it gaps up, and gapping up is what winners do. Measured on the live
// book, eight of nine entries that never filled were winners averaging +6.3% against a
// book average of -0.35%.
//
// Pricing an in-hours run against the live tape is what closes that gap: the decision,
// the simulated fill and the broker order all refer to the same moment.
//
// This uses the MARKET DATA key pair (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY — the
// same keys as the News API in lib/alpaca.ts), NOT the paper trading keys. They are
// separate credentials on Alpaca and only the data keys authorise this endpoint.
//
// Ships dark behind PAPER_LIVE_QUOTES=1, like every other behaviour change to the
// trading path. Off, nothing here is called and the stage prices from closes exactly
// as before.
//
// Docs: https://docs.alpaca.markets/reference/stocklatesttrades

import { fetchWithRetry } from "@/lib/http";
import { fromAlpacaSymbol, toAlpacaSymbol } from "@/lib/market-utils";

const BASE_URL = "https://data.alpaca.markets/v2/stocks";

// Symbols per request. The endpoint takes a comma-separated list; chunking keeps the
// URL well inside any gateway limit for a watchlist of a few hundred names.
const SYMBOLS_PER_REQUEST = 100;

/**
 * Gate for pricing an in-hours run against the live tape instead of the last stored
 * close. Ship-dark: this changes the price every decision, fill and mark is made at.
 */
export function isLiveQuotesEnabled(): boolean {
  return process.env.PAPER_LIVE_QUOTES === "1";
}

/** True when the market-data credentials are present (separate from the trading keys). */
export function isMarketDataConfigured(): boolean {
  return !!(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function authHeaders(): Record<string, string> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");
  }
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type LatestTrades = {
  /** ticker → last trade price. Absent for anything the feed didn't return. */
  prices: Map<string, number>;
  /** Non-fatal problems, surfaced by the caller rather than thrown. */
  errors: string[];
};

/**
 * Last traded price per symbol, keyed by the caller's (stored) ticker form.
 *
 * The last TRADE, not the mid or the ask: it is the only one of the three that is a
 * price something actually transacted at, which is what both the simulated fill and the
 * marketable-limit reference are meant to represent.
 *
 * Never throws — a quote source that can fail the whole trading stage is worse than one
 * that degrades. Missing symbols are simply absent from the map, and the caller keeps
 * the stored close for those. Feed is left at the account default (IEX on the free
 * plan); an explicit feed would silently 403 an account not entitled to it.
 */
export async function getLatestTrades(symbols: string[]): Promise<LatestTrades> {
  const prices = new Map<string, number>();
  const errors: string[] = [];
  if (symbols.length === 0) return { prices, errors };

  // Ask in Alpaca's symbol form; a single unrecognised symbol 400s the whole request,
  // taking every other name in the chunk down with it.
  for (const group of chunk(symbols.map(toAlpacaSymbol), SYMBOLS_PER_REQUEST)) {
    try {
      const url = `${BASE_URL}/trades/latest?symbols=${encodeURIComponent(group.join(","))}`;
      const res = await fetchWithRetry(url, {
        headers: { ...authHeaders(), Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`Alpaca latest-trades error: ${res.status} — ${body}`);
        continue; // other chunks may still succeed
      }
      const data = (await res.json()) as { trades?: Record<string, { p?: number } | null> };
      for (const [symbol, trade] of Object.entries(data.trades ?? {})) {
        const p = trade?.p;
        // A non-positive or missing price is not a price; leaving it out means the
        // caller falls back to the close rather than marking a book at zero.
        // Back to the stored form so callers can look prices up by their own ticker.
        if (typeof p === "number" && Number.isFinite(p) && p > 0) prices.set(fromAlpacaSymbol(symbol), p);
      }
    } catch (e) {
      errors.push(`Alpaca latest-trades failed: ${String(e)}`);
    }
  }
  return { prices, errors };
}
