import { db } from "@/lib/db";
import { getMarketNews, getStockNews } from "@/lib/finnhub";
import { getMarketauxStockNews } from "@/lib/marketaux";
import { analyzeSentiment } from "@/lib/llm";

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  errors: string[];
};

function dateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runPipeline(): Promise<PipelineResult> {
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, errors: [] };

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. Fetch and store general market news (for the news feed)
  try {
    const general = await getMarketNews("general");
    result.articles.fetched += general.length;

    const validArticles = general
      .filter((a) => a.url && a.headline)
      .map((a) => ({
        headline: a.headline,
        summary: a.summary ?? null,
        url: a.url,
        source: a.source,
        publishedAt: new Date(a.datetime * 1000),
      }));

    const { count } = await db.article.createMany({
      data: validArticles,
      skipDuplicates: true,
    });
    result.articles.saved += count;
  } catch (e) {
    result.errors.push(`General news fetch failed: ${String(e)}`);
  }

  // 2. Fetch stock-specific news only for stocks users are watching
  const stocks = await db.stock.findMany({
    select: { id: true, ticker: true },
    where: { userStocks: { some: {} } }, // at least one user follows it
  });

  // Finnhub free tier only supports /company-news for US tickers (no dot-exchange suffix, no crypto)
  const usStocks = stocks.filter((s) => !s.ticker.includes(".") && !s.ticker.endsWith("-USD"));

  for (const stock of usStocks) {
    try {
      const news = await getStockNews(stock.ticker, dateStr(from), dateStr(to));
      result.articles.fetched += news.length;

      const valid = news.filter((a) => a.url && a.headline);

      // Bulk insert new articles, skip existing (by unique url)
      const { count } = await db.article.createMany({
        data: valid.map((a) => ({
          headline: a.headline,
          summary: a.summary ?? null,
          url: a.url,
          source: a.source,
          publishedAt: new Date(a.datetime * 1000),
        })),
        skipDuplicates: true,
      });
      result.articles.saved += count;

      // Fetch IDs for all URLs (new + existing) to create stock links
      const urls = valid.map((a) => a.url);
      const articles = await db.article.findMany({
        where: { url: { in: urls } },
        select: { id: true },
      });

      await db.articleStock.createMany({
        data: articles.map((a) => ({ articleId: a.id, stockId: stock.id })),
        skipDuplicates: true,
      });
      result.tags += articles.length;

      // Respect Finnhub free tier rate limit (60 req/min)
      await sleep(1100);
    } catch (e) {
      result.errors.push(`Stock news failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  // 2b. Fetch news for non-US stocks via Marketaux (Finnhub free tier doesn't support these)
  const nonUsStocks = stocks.filter((s) => s.ticker.includes("."));

  if (nonUsStocks.length > 0) {
    if (!process.env.MARKETAUX_API_KEY) {
      result.errors.push("Marketaux skipped: MARKETAUX_API_KEY not set");
    } else {
      const BATCH = 5; // keep request count low on free tier (100 req/day)
      const fromISO = from.toISOString();

      for (let i = 0; i < nonUsStocks.length; i += BATCH) {
        const batch = nonUsStocks.slice(i, i + BATCH);
        const symbols = batch.map((s) => s.ticker);

        try {
          const news = await getMarketauxStockNews(symbols, fromISO);
          result.articles.fetched += news.length;

          const valid = news.filter((a) => a.url && a.title);

          const { count } = await db.article.createMany({
            data: valid.map((a) => ({
              headline: a.title,
              summary: a.description ?? null,
              url: a.url,
              source: a.source,
              publishedAt: new Date(a.published_at),
            })),
            skipDuplicates: true,
          });
          result.articles.saved += count;

          // Resolve saved article IDs and link to stocks via entities
          const urls = valid.map((a) => a.url);
          const savedArticles = await db.article.findMany({
            where: { url: { in: urls } },
            select: { id: true, url: true },
          });
          const urlToId = new Map(savedArticles.map((a) => [a.url, a.id]));

          const links: Array<{ articleId: string; stockId: string }> = [];
          for (const article of valid) {
            const articleId = urlToId.get(article.url);
            if (!articleId) continue;
            for (const entity of article.entities) {
              const stock = batch.find((s) => s.ticker === entity.symbol);
              if (stock) links.push({ articleId, stockId: stock.id });
            }
          }

          if (links.length > 0) {
            await db.articleStock.createMany({ data: links, skipDuplicates: true });
            result.tags += links.length;
          }

          await sleep(1000);
        } catch (e) {
          result.errors.push(`Marketaux news failed for [${symbols.join(",")}]: ${String(e)}`);
        }
      }
    }
  }

  // 3. Run sentiment for all watched stocks that have tagged articles
  for (const stock of stocks) {
    try {
      const recentArticles = await db.article.findMany({
        where: {
          articleStock: { some: { stockId: stock.id } },
          publishedAt: { gte: from },
        },
        orderBy: { publishedAt: "desc" },
        take: 10,
        select: { headline: true },
      });

      if (recentArticles.length === 0) continue;

      const sentiment = await analyzeSentiment(
        stock.ticker,
        recentArticles.map((a) => a.headline)
      );

      await db.sentiment.create({
        data: { stockId: stock.id, score: sentiment.score, summary: sentiment.summary },
      });

      result.sentiments++;
    } catch (e) {
      result.errors.push(`Sentiment failed for ${stock.ticker}: ${String(e)}`);
    }
  }

  return result;
}
