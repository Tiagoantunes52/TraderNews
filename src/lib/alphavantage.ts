const BASE_URL = "https://www.alphavantage.co/query";

export type AlphaVantageTickerSentiment = {
  ticker: string;
  relevance_score: string;
  ticker_sentiment_score: string;
  ticker_sentiment_label: string;
};

export type AlphaVantageArticle = {
  title: string;
  url: string;
  time_published: string; // "20240601T120000"
  summary: string;
  source: string;
  ticker_sentiment: AlphaVantageTickerSentiment[];
};

// "20240601T120000" → Date
export function parseAlphaVantageDate(s: string): Date {
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
  );
}

export async function getAlphaVantageNews(
  tickers: string[],
  publishedAfter: Date
): Promise<AlphaVantageArticle[]> {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY not set");

  // Alpha Vantage time_from format: YYYYMMDDTHHMM
  const timeFrom = publishedAfter.toISOString().replace(/[-:]/g, "").slice(0, 13);

  const url = new URL(BASE_URL);
  url.searchParams.set("function", "NEWS_SENTIMENT");
  url.searchParams.set("tickers", tickers.join(","));
  url.searchParams.set("time_from", timeFrom);
  url.searchParams.set("limit", "50");
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpha Vantage error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  if ("Note" in data) throw new Error("Alpha Vantage rate limit reached");
  if ("Information" in data) throw new Error(`Alpha Vantage: ${String(data.Information)}`);

  return (data.feed as AlphaVantageArticle[]) ?? [];
}

export type EtfSectorWeight = { sector: string; weight: number };
export type EtfHolding = { symbol: string; description: string; weight: number };

export type EtfProfileData = {
  netAssets: number | null;
  expenseRatio: number | null;
  dividendYield: number | null;
  inceptionDate: string | null;
  sectors: EtfSectorWeight[];
  holdings: EtfHolding[];
};

const num = (v: unknown): number | null => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/** Fetch ETF holdings, sector weights, and fundamentals via ETF_PROFILE. */
export async function getEtfProfile(symbol: string): Promise<EtfProfileData | null> {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY not set");

  const url = new URL(BASE_URL);
  url.searchParams.set("function", "ETF_PROFILE");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpha Vantage error: ${res.status} — ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if ("Note" in data) throw new Error("Alpha Vantage rate limit reached");
  if ("Information" in data) throw new Error(`Alpha Vantage: ${String(data.Information)}`);

  const sectorsRaw = (data.sectors as Array<Record<string, string>>) ?? [];
  const holdingsRaw = (data.holdings as Array<Record<string, string>>) ?? [];
  // ETF_PROFILE returns nothing meaningful for non-ETF symbols.
  if (sectorsRaw.length === 0 && holdingsRaw.length === 0) return null;

  return {
    netAssets: num(data.net_assets),
    expenseRatio: num(data.net_expense_ratio),
    dividendYield: num(data.dividend_yield),
    inceptionDate: typeof data.inception_date === "string" ? data.inception_date : null,
    sectors: sectorsRaw
      .map((s) => ({ sector: s.sector, weight: num(s.weight) ?? 0 }))
      .filter((s) => s.sector),
    holdings: holdingsRaw
      .map((h) => ({ symbol: h.symbol, description: h.description, weight: num(h.weight) ?? 0 }))
      .filter((h) => h.symbol),
  };
}
