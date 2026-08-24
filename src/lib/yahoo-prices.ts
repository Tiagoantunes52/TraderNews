import type { DailyPrice } from "@/lib/tiingo-prices";
import { fetchWithRetry } from "@/lib/http";

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
  const res = await fetchWithRetry(url.toString(), {
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
    // Yahoo serves `adjclose` (split/dividend adjusted) separately from `quote`,
    // whose open/high/low/close are the RAW session prints. Taking the adjusted
    // close but the raw O/H/L would put the four on different bases, which
    // fabricates an enormous gap across every corporate action: after a 2:1 split
    // each pre-split bar would carry a `low` at twice its own `close`. Nothing
    // noticed while the only consumer was a 60-day indicator window that rarely
    // spans a split — but a fill model reading `low <= stop` on such a bar
    // concludes every stop was hit. Tiingo avoids this by serving adjOpen/adjHigh/
    // adjLow (see tiingo-prices.ts); Yahoo makes us derive the ratio ourselves.
    const adjusted = adjClose?.[i] ?? closes[i];
    if (adjusted == null) continue; // skip gap days Yahoo returns as null
    const rawClose = closes[i];
    // Same ratio the split/dividend adjustment applied to the close, reused to put
    // O/H/L on that basis. 1 when the raw close is missing or unusable — the O/H/L
    // fallbacks below then resolve to the adjusted close anyway, so the bar stays
    // internally consistent rather than half-converted.
    const ratio = rawClose != null && rawClose > 0 ? adjusted / rawClose : 1;
    // Raw print → adjusted, in the major currency unit. A missing leg falls back to
    // the adjusted close, which is already on the right basis and so is NOT scaled.
    const onCloseBasis = (rawPrint: number | null | undefined) =>
      (rawPrint == null ? adjusted : rawPrint * ratio) / divisor;
    out.push({
      date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      close: adjusted / divisor,
      // Volume moves inversely to price: a 2:1 split halves the price and doubles
      // the share count. Matches Tiingo's `adjVolume`.
      volume: ratio > 0 ? (volumes[i] ?? 0) / ratio : (volumes[i] ?? 0),
      open: onCloseBasis(opens[i]),
      high: onCloseBasis(highs[i]),
      low: onCloseBasis(lows[i]),
    });
  }
  return out;
}
