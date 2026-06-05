import { fetchWithRetry } from "@/lib/http";

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

  const res = await fetchWithRetry(url.toString(), { next: { revalidate: 3600 } });
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

export type EarningsEvent = { symbol: string; date: string };

export async function getEarningsCalendar(from: string, to: string): Promise<EarningsEvent[]> {
  // GET /calendar/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD (no symbol = all stocks)
  const data = await get<{ earningsCalendar: Array<{ symbol: string; date: string }> }>(
    "/calendar/earnings", { from, to }
  );
  return data.earningsCalendar ?? [];
}

// Insider transactions (SEC Form 4). Note: Finnhub does NOT return the insider's
// role/title — only their name — so CEO/CFO identification needs EDGAR (deferred).
export type FinnhubInsiderTxn = {
  name: string;
  share: number; // shares held after the transaction
  change: number; // signed share delta (+ acquired, - disposed)
  filingDate: string; // YYYY-MM-DD
  transactionDate: string; // YYYY-MM-DD
  transactionCode: string; // SEC code: P, S, A, M, F, G...
  transactionPrice: number; // per-share price (0 when N/A, e.g. gifts)
  isDerivative?: boolean;
  id?: string; // SEC accession number
  symbol?: string;
};

export async function getInsiderTransactions(symbol: string, from: string, to: string): Promise<FinnhubInsiderTxn[]> {
  const data = await get<{ data: FinnhubInsiderTxn[]; symbol: string }>(
    "/stock/insider-transactions", { symbol, from, to }
  );
  return data.data ?? [];
}

// Pre-aggregated monthly net-insider flow. `mspr` is Finnhub's monthly share
// purchase ratio (-100..100): >0 net buying, <0 net selling.
export type FinnhubInsiderSentiment = { symbol: string; year: number; month: number; change: number; mspr: number };

export async function getInsiderSentiment(symbol: string, from: string, to: string): Promise<FinnhubInsiderSentiment[]> {
  const data = await get<{ data: FinnhubInsiderSentiment[]; symbol: string }>(
    "/stock/insider-sentiment", { symbol, from, to }
  );
  return data.data ?? [];
}
