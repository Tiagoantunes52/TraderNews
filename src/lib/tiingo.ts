import { fetchWithRetry } from "@/lib/http";

const BASE_URL = "https://api.tiingo.com/tiingo/news";

// Tiingo uses concatenated lowercase for crypto: BTC-USD → btcusd, ETH-USD → ethusd
// Equity and FX tickers pass through unchanged.
export function toTiingoTicker(ticker: string): string {
  if (ticker.endsWith("-USD")) return ticker.replace(/-/g, "").toLowerCase();
  return ticker;
}

export type TiingoArticle = {
  id: number;
  title: string;
  url: string;
  publishedDate: string; // ISO 8601
  description: string | null;
  source: string;
  tickers: string[];
};

export async function getTiingoNews(
  tickers: string[],
  publishedAfter: Date
): Promise<TiingoArticle[]> {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) throw new Error("TIINGO_API_KEY not set");

  const url = new URL(BASE_URL);
  url.searchParams.set("tickers", tickers.join(","));
  url.searchParams.set("startDate", publishedAfter.toISOString().split("T")[0]);
  url.searchParams.set("limit", "100");

  const res = await fetchWithRetry(url.toString(), {
    headers: { Authorization: `Token ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tiingo error: ${res.status} — ${body}`);
  }

  return (await res.json()) as TiingoArticle[];
}
