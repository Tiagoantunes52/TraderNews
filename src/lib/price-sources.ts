// Centralised daily-price fetching with ordered fallback.
//
// Mirrors the news aggregator: each provider is a PriceSource adapter. We try
// them in order and return the first that yields usable data, so one provider
// being unavailable (or not covering a ticker) transparently falls back to the
// next. Tiingo is primary for US equities and crypto (adjusted prices, API
// key); Yahoo is the universal fallback and the primary for the dot-suffixed
// international tickers Tiingo's plan doesn't serve.

import { getTiingoDailyPrices, type DailyPrice } from "@/lib/tiingo-prices";
import { getYahooDailyPrices } from "@/lib/yahoo-prices";
import { getBinanceDailyPrices, toBinanceSymbol } from "@/lib/binance-prices";
import { getCoinGeckoDailyPrices, toCoinGeckoId } from "@/lib/coingecko-prices";

const MIN_POINTS = 2; // fewer than this is unusable for indicators

export type PriceSource = {
  name: string;
  configured(): boolean;
  supports(ticker: string): boolean;
  fetch(ticker: string, since: Date): Promise<DailyPrice[]>;
};

export type PriceResult = {
  prices: DailyPrice[];
  provider: string | null; // which source served the data (null = none worked)
  errors: string[]; // non-fatal per-source failures
};

/** Binance — crypto only (`-USD` → USDT pair). Full daily OHLCV; keyless. */
export const binancePriceSource: PriceSource = {
  name: "Binance",
  configured: () => true,
  supports: (ticker) => toBinanceSymbol(ticker) !== null,
  fetch: (ticker, since) => getBinanceDailyPrices(ticker, since),
};

/** Tiingo — US equities + crypto (`-USD`). Skips dot-exchange listings it can't serve. */
export const tiingoPriceSource: PriceSource = {
  name: "Tiingo",
  configured: () => !!process.env.TIINGO_API_KEY,
  supports: (ticker) => !ticker.includes("."),
  fetch: (ticker, since) => getTiingoDailyPrices(ticker, since),
};

/** CoinGecko — crypto only, broad coin coverage. Crypto fallback behind Binance/Tiingo. */
export const coinGeckoPriceSource: PriceSource = {
  name: "CoinGecko",
  configured: () => true,
  supports: (ticker) => toCoinGeckoId(ticker) !== null,
  fetch: (ticker, since) => getCoinGeckoDailyPrices(ticker, since),
};

/** Yahoo chart API — free, keyless, universal (US, crypto, international). */
export const yahooPriceSource: PriceSource = {
  name: "Yahoo",
  configured: () => true,
  supports: () => true,
  fetch: (ticker, since) => getYahooDailyPrices(ticker, since),
};

// Order matters: crypto-specialised sources first (Binance best OHLCV), then
// Tiingo (US equities + crypto), then CoinGecko (crypto fallback), then Yahoo
// (universal catch-all, incl. international equities).
export const DEFAULT_PRICE_SOURCES: PriceSource[] = [
  binancePriceSource,
  tiingoPriceSource,
  coinGeckoPriceSource,
  yahooPriceSource,
];

/**
 * Fetch daily prices for a ticker, trying each applicable source in order and
 * returning the first that produces at least MIN_POINTS rows.
 */
export async function getDailyPrices(
  ticker: string,
  since: Date,
  sources: PriceSource[] = DEFAULT_PRICE_SOURCES
): Promise<PriceResult> {
  const errors: string[] = [];

  for (const source of sources) {
    if (!source.configured() || !source.supports(ticker)) continue;
    try {
      const prices = await source.fetch(ticker, since);
      if (prices.length >= MIN_POINTS) {
        return { prices, provider: source.name, errors };
      }
    } catch (e) {
      errors.push(`${source.name} prices failed for ${ticker}: ${String(e)}`);
    }
  }

  return { prices: [], provider: null, errors };
}
