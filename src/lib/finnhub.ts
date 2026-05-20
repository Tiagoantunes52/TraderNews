const BASE_URL = "https://finnhub.io/api/v1";
const API_KEY = process.env.FINNHUB_API_KEY!;

export type FinnhubArticle = {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
};

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("token", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Finnhub error: ${res.status} ${path}`);
  return res.json();
}

export function getMarketNews(category: "general" | "forex" | "crypto" | "merger" = "general") {
  return get<FinnhubArticle[]>("/news", { category });
}

export function getStockNews(ticker: string, from: string, to: string) {
  return get<FinnhubArticle[]>("/company-news", { symbol: ticker, from, to });
}

export function searchStocks(query: string) {
  return get<{ count: number; result: { description: string; displaySymbol: string; symbol: string; type: string }[] }>(
    "/search",
    { q: query }
  );
}
