const BASE_URL = "https://api.marketaux.com/v1";

export type MarketauxArticle = {
  uuid: string;
  title: string;
  description: string | null;
  url: string;
  published_at: string;
  source: string;
  entities: Array<{ symbol: string }>;
};

export async function getMarketauxStockNews(
  symbols: string[],
  publishedAfter: Date
): Promise<MarketauxArticle[]> {
  const apiKey = process.env.MARKETAUX_API_KEY;
  if (!apiKey) throw new Error("MARKETAUX_API_KEY not set");

  const url = new URL(`${BASE_URL}/news/all`);
  url.searchParams.set("api_token", apiKey);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("filter_entities", "true");
  // Marketaux expects YYYY-MM-DDTHH:mm format (no seconds, no Z)
  url.searchParams.set("published_after", publishedAfter.toISOString().slice(0, 16));
  url.searchParams.set("language", "en");
  url.searchParams.set("limit", "3"); // free tier cap

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Marketaux error: ${res.status} — ${body}`);
  }
  const data = (await res.json()) as { data: MarketauxArticle[] };
  return data.data ?? [];
}
