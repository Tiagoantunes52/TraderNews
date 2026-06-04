import { fetchWithRetry } from "@/lib/http";

const BASE_URL = "https://api.polygon.io/v2/reference/news";

export type PolygonArticle = {
  id: string;
  title: string;
  article_url: string;
  published_utc: string; // ISO 8601
  description: string | null;
  publisher: { name: string };
  tickers: string[];
};

export async function getPolygonStockNews(
  ticker: string,
  publishedAfter: Date
): Promise<PolygonArticle[]> {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error("POLYGON_API_KEY not set");

  const url = new URL(BASE_URL);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("published_utc.gte", publishedAfter.toISOString().split("T")[0]);
  url.searchParams.set("limit", "50");
  url.searchParams.set("order", "desc");
  url.searchParams.set("apiKey", apiKey);

  const res = await fetchWithRetry(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Polygon error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as { results: PolygonArticle[] };
  return data.results ?? [];
}
