import type { DailyPrice } from "@/lib/tiingo-prices";
import { fetchWithRetry } from "@/lib/http";

// CoinGecko market data — free Demo tier (optional key via COINGECKO_API_KEY).
// Broad coin coverage. The market_chart endpoint returns daily close + volume
// but no intraday high/low, so high/low fall back to close (ATR is degraded but
// RSI/MACD/momentum/Bollinger/volatility are unaffected). Used as a crypto
// fallback behind Binance.

const BASE_URL = "https://api.coingecko.com/api/v3";

/** Our `-USD` tickers → CoinGecko coin ids. */
export const COINGECKO_IDS: Record<string, string> = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
  "SOL-USD": "solana",
  "XRP-USD": "ripple",
  "ADA-USD": "cardano",
  "DOGE-USD": "dogecoin",
  "AVAX-USD": "avalanche-2",
  "DOT-USD": "polkadot",
  "MATIC-USD": "matic-network",
  "LTC-USD": "litecoin",
  "LINK-USD": "chainlink",
  "BCH-USD": "bitcoin-cash",
  "TRX-USD": "tron",
  "XLM-USD": "stellar",
  "ATOM-USD": "cosmos",
};

export function toCoinGeckoId(ticker: string): string | null {
  return COINGECKO_IDS[ticker] ?? null;
}

export async function getCoinGeckoDailyPrices(ticker: string, startDate: Date): Promise<DailyPrice[]> {
  const id = toCoinGeckoId(ticker);
  if (!id) return [];

  const days = Math.max(1, Math.ceil((Date.now() - startDate.getTime()) / 86_400_000));
  const url = new URL(`${BASE_URL}/coins/${id}/market_chart`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(days));
  url.searchParams.set("interval", "daily");

  const headers: Record<string, string> = {};
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;

  const res = await fetchWithRetry(url.toString(), { headers, cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`CoinGecko prices error: ${res.status}`);

  const data = (await res.json()) as {
    prices?: [number, number][];
    total_volumes?: [number, number][];
  };
  const prices = data.prices ?? [];
  const volumeByDay = new Map(
    (data.total_volumes ?? []).map(([t, v]) => [new Date(t).toISOString().split("T")[0], v])
  );

  return prices.map(([t, price]) => {
    const date = new Date(t).toISOString().split("T")[0];
    // Daily market_chart gives one point per day — no OHLC, so open/high/low all
    // collapse to that point (the file header already notes this degrades ATR).
    return { date, close: price, open: price, high: price, low: price, volume: volumeByDay.get(date) ?? 0 };
  });
}
