import { fetchWithRetry } from "@/lib/http";

// Alpaca's historical News API (Benzinga-sourced). Free on the Basic plan,
// 200 req/min. Articles arrive symbol-tagged, so no headline-matching heuristics
// are needed to associate them with a watchlist ticker.
//
// Docs: https://docs.alpaca.markets/reference/news-3
const BASE_URL = "https://data.alpaca.markets/v1beta1/news";

// `limit` caps at 50 per page; we page via next_page_token. Bound the walk so a
// busy symbol set over a wide window can't run away (50 × 5 = 250 articles/batch).
const PAGE_LIMIT = 50;
const MAX_PAGES = 5;

export type AlpacaNewsArticle = {
  id: number;
  headline: string;
  author: string;
  created_at: string; // RFC-3339
  updated_at: string;
  summary: string;
  url: string;
  symbols: string[]; // tickers Alpaca/Benzinga tagged this article with
  source: string; // upstream publisher, e.g. "benzinga"
};

type AlpacaNewsResponse = {
  news: AlpacaNewsArticle[];
  next_page_token: string | null;
};

/**
 * Fetch Benzinga news for `symbols` published since `publishedAfter`, newest
 * first, following pagination up to MAX_PAGES. Throws on a missing key or a
 * non-ok HTTP status so the adapter layer can record a per-source failure.
 */
export async function getAlpacaNews(
  symbols: string[],
  publishedAfter: Date
): Promise<AlpacaNewsArticle[]> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set");
  if (symbols.length === 0) return [];

  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
  const out: AlpacaNewsArticle[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(BASE_URL);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("start", publishedAfter.toISOString());
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("sort", "desc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetchWithRetry(url.toString(), { headers, cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Alpaca error: ${res.status} — ${body}`);
    }

    const data = (await res.json()) as AlpacaNewsResponse;
    out.push(...(data.news ?? []));
    pageToken = data.next_page_token ?? null;
    if (!pageToken) break;
  }

  return out;
}
