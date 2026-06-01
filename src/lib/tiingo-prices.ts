const BASE_URL = "https://api.tiingo.com";

export type DailyPrice = {
  date: string;
  close: number;
  volume: number;
};

export async function getTiingoDailyPrices(
  ticker: string,
  startDate: Date
): Promise<DailyPrice[]> {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) throw new Error("TIINGO_API_KEY not set");

  const start = startDate.toISOString().split("T")[0];

  if (ticker.endsWith("-USD")) {
    return getCryptoPrices(ticker, start, apiKey);
  }
  return getStockPrices(ticker, start, apiKey);
}

async function getStockPrices(
  ticker: string,
  startDate: string,
  apiKey: string
): Promise<DailyPrice[]> {
  const url = new URL(`${BASE_URL}/tiingo/daily/${encodeURIComponent(ticker)}/prices`);
  url.searchParams.set("startDate", startDate);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${apiKey}` },
    cache: "no-store",
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tiingo prices error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as Array<{ date: string; adjClose?: number; close: number; adjVolume?: number; volume: number }>;
  return data.map((d) => ({ date: d.date, close: d.adjClose ?? d.close, volume: d.adjVolume ?? d.volume ?? 0 }));
}

async function getCryptoPrices(
  ticker: string,
  startDate: string,
  apiKey: string
): Promise<DailyPrice[]> {
  // BTC-USD → btcusd
  const tiingoTicker = ticker.replace(/-/g, "").toLowerCase();

  const url = new URL(`${BASE_URL}/tiingo/crypto/prices`);
  url.searchParams.set("tickers", tiingoTicker);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("resampleFreq", "1day");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${apiKey}` },
    cache: "no-store",
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tiingo crypto prices error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as Array<{
    priceData: Array<{ date: string; close: number; volume?: number }>;
  }>;
  return (data[0]?.priceData ?? []).map((d) => ({ date: d.date, close: d.close, volume: d.volume ?? 0 }));
}
