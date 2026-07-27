import type { DailyPrice } from "@/lib/tiingo-prices";

// Yahoo Finance chart API — free, keyless, covers US equities, crypto, and
// international exchanges (the dot-suffixed tickers Tiingo's plan can't serve).
// Returns the same DailyPrice shape as the Tiingo source so they're interchangeable.

const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: { currency?: string };
      indicators?: {
        quote?: Array<{
          close?: (number | null)[];
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          volume?: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
      };
    }>;
    error?: unknown;
  };
};

export async function getYahooDailyPrices(ticker: string, startDate: Date): Promise<DailyPrice[]> {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);

  const url = new URL(`${BASE_URL}/${encodeURIComponent(ticker)}`);
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1d");

  // Yahoo rejects requests without a browser-like User-Agent.
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Yahoo prices error: ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as YahooChartResponse;
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp;
  if (!result || !timestamps) return [];

  const quote = result.indicators?.quote?.[0] ?? {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
  const closes = quote.close ?? [];
  const opens = quote.open ?? [];
  const highs = quote.high ?? [];
  const lows = quote.low ?? [];
  const volumes = quote.volume ?? [];

  // London (and some other) listings quote in pence ("GBp"); normalize the
  // minor unit to the major unit (GBp → GBP) so prices match every other market.
  const divisor = result.meta?.currency === "GBp" ? 100 : 1;

  const out: DailyPrice[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const rawClose = adjClose?.[i] ?? closes[i];
    if (rawClose == null) continue; // skip gap days Yahoo returns as null
    const close = rawClose / divisor;
    out.push({
      date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      close,
      volume: volumes[i] ?? 0,
      open: (opens[i] ?? rawClose) / divisor,
      high: (highs[i] ?? rawClose) / divisor,
      low: (lows[i] ?? rawClose) / divisor,
    });
  }
  return out;
}
