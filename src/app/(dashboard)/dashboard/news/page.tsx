import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper, TrendingUp, TrendingDown, Minus } from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { NewsFilterBar } from "./news-filter-bar";
import { LoadMoreButton } from "./load-more-button";
import type { Prisma } from "@/generated/prisma/client";
import { moodBucket } from "@/lib/mood";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function SentimentBadge({ score }: { score?: number }) {
  if (score === undefined) return null;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 shrink-0"><TrendingUp className="h-3 w-3 mr-1" />Bullish</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 shrink-0"><TrendingDown className="h-3 w-3 mr-1" />Bearish</Badge>;
  return <Badge variant="secondary" className="shrink-0"><Minus className="h-3 w-3 mr-1" />Neutral</Badge>;
}

const TIME_WINDOWS_MS: Record<string, number | null> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export default async function NewsFeedPage({
  searchParams,
}: PageProps<"/dashboard/news">) {
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const timeKey = typeof sp.time === "string" ? sp.time : "all";
  const ticker = typeof sp.ticker === "string" ? sp.ticker : "all";
  const moodFilter = typeof sp.mood === "string" ? sp.mood : "all";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(DEFAULT_LIMIT, Number(typeof sp.limit === "string" ? sp.limit : DEFAULT_LIMIT) || DEFAULT_LIMIT)
  );

  const user = await getOrCreateUser();

  // Available tickers for the filter bar = user's watchlist
  const watchlistTickers = user
    ? (
        await db.userStock.findMany({
          where: { userId: user.id },
          include: { stock: { select: { ticker: true } } },
          orderBy: { stock: { ticker: "asc" } },
        })
      ).map((us) => us.stock.ticker)
    : [];

  const hasWatchlist = watchlistTickers.length > 0;

  // Build the Prisma where clause
  const where: Prisma.ArticleWhereInput = {};

  // Time window
  const windowMs = TIME_WINDOWS_MS[timeKey] ?? null;
  if (windowMs !== null) {
    // eslint-disable-next-line react-hooks/purity -- server component, fresh render per request
    where.publishedAt = { gte: new Date(Date.now() - windowMs) };
  }

  // Search
  if (q) {
    where.headline = { contains: q, mode: "insensitive" };
  }

  // Ticker scope
  if (ticker !== "all") {
    where.articleStock = { some: { stock: { ticker } } };
  } else if (hasWatchlist) {
    // Default to user's watchlist if they have one
    where.articleStock = {
      some: { stock: { userStocks: { some: { userId: user!.id } } } },
    };
  }

  // Fetch enough to filter on mood in-memory; mood filter is applied after fetch.
  // 4× when mood-filtered so we have headroom after dropping non-matching rows.
  const takeFromDb = Math.min(MAX_LIMIT * 4, moodFilter === "all" ? limit : limit * 4);

  const articles = await db.article.findMany({
    where,
    include: {
      articleStock: {
        include: {
          stock: {
            include: { sentiments: { orderBy: { date: "desc" }, take: 1 } },
          },
        },
      },
    },
    orderBy: { publishedAt: "desc" },
    take: takeFromDb,
  });

  // Fallback: if user has no watchlist AND no ticker filter chose, show general news
  // (already covered by the "no ticker scope" branch above — `where.articleStock` is undefined,
  // so we get all articles).

  // In-memory mood filter
  const enriched = articles.map((article) => {
    const tickers = article.articleStock.map((as) => as.stock);
    const topSentiment = tickers
      .flatMap((s) => s.sentiments)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];
    return { article, tickers, topSentiment };
  });

  const filtered = moodFilter === "all"
    ? enriched
    : enriched.filter((e) => moodBucket(e.topSentiment?.score) === moodFilter);

  const finalList = filtered.slice(0, limit);
  const hasMore = finalList.length >= limit && limit < MAX_LIMIT;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">News Feed</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {hasWatchlist
            ? "Latest news for your watchlist stocks"
            : "Latest market news — add stocks to your watchlist to personalise this feed"}
        </p>
      </div>

      <NewsFilterBar tickers={watchlistTickers} />

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {finalList.length === 0
            ? "No results"
            : `${finalList.length} ${finalList.length === 1 ? "article" : "articles"}`}
          {moodFilter !== "all" && filtered.length > limit && ` (top ${limit} of ${filtered.length})`}
        </span>
      </div>

      {finalList.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            {q || timeKey !== "all" || moodFilter !== "all" || ticker !== "all"
              ? "No articles match these filters. Try widening the time window or clearing the search."
              : "No articles yet. Run the news pipeline to fetch the latest market news."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {finalList.map(({ article, tickers, topSentiment }) => (
            <Card key={article.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-col-reverse sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
                  <CardTitle className="text-base font-medium leading-snug">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {article.headline}
                    </a>
                  </CardTitle>
                  <div className="self-start">
                    <SentimentBadge score={topSentiment?.score} />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1">
                    <Newspaper className="h-3 w-3" />
                    {article.source}
                  </span>
                  <span>·</span>
                  <span>{formatDistanceToNow(article.publishedAt)}</span>
                  {tickers.length > 0 && (
                    <>
                      <span>·</span>
                      <div className="flex gap-1 flex-wrap">
                        {tickers.slice(0, 4).map((stock) => (
                          <Link key={stock.id} href={`/dashboard/stocks/${stock.ticker}`}>
                            <Badge variant="outline" className="text-xs px-1.5 py-0 hover:bg-muted cursor-pointer">
                              {stock.ticker}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {hasMore && <LoadMoreButton currentLimit={limit} />}
    </div>
  );
}
