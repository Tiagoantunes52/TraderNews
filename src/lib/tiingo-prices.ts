const BASE_URL = "https://api.tiingo.com";

export type DailyPrice = {
  date: string;
  close: number;
  volume: number;
  high: number;
  low: number;
  /**
   * Session open. Needed to model an executable entry: the paper sim fills at the
   * reference CLOSE, but a decision made after that close can only be acted on at the
   * next open, so sim and broker were pricing different events. Sources that don't
   * publish an open (CoinGecko's daily series) fall back to the close, which is what
   * high/low already do there.
   */
  open: number;
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

  const data = (await res.json()) as Array<{ date: string; adjClose?: number; close: number; adjVolume?: number; volume: number; adjHigh?: number; high?: number; adjLow?: number; low?: number; adjOpen?: number; open?: number }>;
  return data.map((d) => {
    const close = d.adjClose ?? d.close;
    return {
      date: d.date,
      close,
      volume: d.adjVolume ?? d.volume ?? 0,
      high: d.adjHigh ?? d.high ?? 0,
      low: d.adjLow ?? d.low ?? 0,
      // Adjusted open where available, so it sits on the same split/dividend basis as
      // adjClose — mixing raw and adjusted would fabricate gaps across a corporate action.
      open: d.adjOpen ?? d.open ?? close,
    };
  });
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
    priceData: Array<{ date: string; close: number; volume?: number; high?: number; low?: number; open?: number }>;
  }>;
  return (data[0]?.priceData ?? []).map((d) => ({
    date: d.date,
    close: d.close,
    volume: d.volume ?? 0,
    high: d.high ?? d.close,
    low: d.low ?? d.close,
    open: d.open ?? d.close,
  }));
}
