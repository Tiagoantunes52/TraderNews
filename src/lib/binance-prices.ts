import type { DailyPrice } from "@/lib/tiingo-prices";

// Binance public market data — free, keyless, full daily OHLCV with deep
// history. Best crypto price source when reachable. Note: api.binance.com can
// be geo-restricted (HTTP 451) from some regions/hosts, which is why it sits
// behind the price aggregator's fallback chain.

const BASE_URL = "https://api.binance.com/api/v3/klines";

/** BTC-USD → BTCUSDT (Binance quotes major pairs against USDT). */
export function toBinanceSymbol(ticker: string): string | null {
  if (!ticker.endsWith("-USD")) return null;
  const base = ticker.slice(0, -"-USD".length);
  return base ? `${base}USDT` : null;
}

export async function getBinanceDailyPrices(ticker: string, startDate: Date): Promise<DailyPrice[]> {
  const symbol = toBinanceSymbol(ticker);
  if (!symbol) return [];

  const url = new URL(BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("startTime", String(startDate.getTime()));
  url.searchParams.set("limit", "1000");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (res.status === 400) return []; // unknown trading pair
  if (!res.ok) throw new Error(`Binance prices error: ${res.status}`);

  // Kline: [openTime, open, high, low, close, volume, ...]
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    date: new Date(Number(k[0])).toISOString().split("T")[0],
    close: parseFloat(String(k[4])),
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    volume: parseFloat(String(k[5])),
  }));
}
