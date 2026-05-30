import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper, TrendingUp, TrendingDown, Star, Activity } from "lucide-react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { mood } from "@/lib/mood";

export default async function OverviewPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const watchlist = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: { sentiments: { orderBy: { date: "desc" }, take: 1 } },
      },
    },
  });

  const scored = watchlist
    .map((ws) => ({ stock: ws.stock, sentiment: ws.stock.sentiments[0] ?? null }))
    .filter((s): s is { stock: typeof s.stock; sentiment: NonNullable<typeof s.sentiment> } => s.sentiment !== null);

  const portfolioScore =
    scored.length > 0
      ? scored.reduce((acc, s) => acc + s.sentiment.score, 0) / scored.length
      : null;

  const topBullish = [...scored].sort((a, b) => b.sentiment.score - a.sentiment.score).slice(0, 3);
  const topBearish = [...scored].sort((a, b) => a.sentiment.score - b.sentiment.score).slice(0, 3);

  const userArticleFilter = {
    articleStock: { some: { stock: { userStocks: { some: { userId: user.id } } } } },
  };
  const hasWatchlistArticles =
    watchlist.length > 0 &&
    (await db.article.count({ where: userArticleFilter })) > 0;

  const recentArticles = await db.article.findMany({
    where: hasWatchlistArticles ? userArticleFilter : undefined,
    include: {
      articleStock: { include: { stock: { select: { id: true, ticker: true } } } },
    },
    orderBy: { publishedAt: "desc" },
    take: 5,
  });

  // eslint-disable-next-line react-hooks/purity -- server component, fresh render per request
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const articles24h = await db.article.count({
    where: {
      publishedAt: { gte: since24h },
      ...(hasWatchlistArticles ? userArticleFilter : {}),
    },
  });

  const lastSentiment = scored
    .map((s) => s.sentiment.date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const portfolioMood = portfolioScore !== null ? mood(portfolioScore) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground text-sm mt-1">
          A snapshot of your portfolio mood and the latest signals
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Watchlist" value={watchlist.length} icon={Star} href="/dashboard/watchlist" />
        <StatCard label="Articles (24h)" value={articles24h} icon={Newspaper} href="/dashboard/news" />
        <StatCard label="Sentiment readings" value={scored.length} icon={Activity} href="/dashboard/sentiment" />
        <StatCard label="Last update" value={lastSentiment ? formatDistanceToNow(lastSentiment) : "—"} small />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="rounded-2xl overflow-hidden border-0 shadow-sm">
          <div className={`bg-gradient-to-br ${portfolioMood?.gradient ?? "from-slate-200 to-slate-300"} p-6`}>
            <p className="text-white/80 text-sm font-medium">Portfolio Mood</p>
            <div className="mt-2 flex items-end justify-between">
              <div>
                <p className="text-white text-5xl font-bold tabular-nums">
                  {portfolioScore !== null ? portfolioScore.toFixed(2) : "—"}
                </p>
                <p className="text-white/90 mt-1 font-medium">
                  {portfolioMood?.label ?? "No data yet"}
                </p>
              </div>
              <span className="text-6xl">{portfolioMood?.emoji ?? "📊"}</span>
            </div>
          </div>
          <CardContent className="p-4 text-xs text-muted-foreground">
            Average sentiment across {scored.length} watched {scored.length === 1 ? "stock" : "stocks"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" /> Top bullish
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {topBullish.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3 text-center">No data yet</p>
            ) : (
              topBullish.map((s) => (
                <MoverRow key={s.stock.id} ticker={s.stock.ticker} name={s.stock.name} score={s.sentiment.score} />
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-red-500" /> Top bearish
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {topBearish.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3 text-center">No data yet</p>
            ) : (
              topBearish.map((s) => (
                <MoverRow key={s.stock.id} ticker={s.stock.ticker} name={s.stock.name} score={s.sentiment.score} />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent headlines</h2>
          <Link href="/dashboard/news" className="text-sm text-primary hover:underline">
            View all →
          </Link>
        </div>
        {recentArticles.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              {watchlist.length === 0
                ? "Add stocks to your watchlist to see news here."
                : "No articles yet. Run the news pipeline to fetch the latest."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentArticles.map((article) => (
              <Card key={article.id}>
                <CardContent className="py-3 px-4">
                  <div className="flex flex-col-reverse sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-sm leading-snug hover:underline"
                    >
                      {article.headline}
                    </a>
                    <div className="flex flex-wrap gap-1 sm:shrink-0">
                      {article.articleStock.slice(0, 3).map((as) => (
                        <Link
                          key={as.stock.id}
                          href={`/dashboard/stocks/${as.stock.ticker}`}
                        >
                          <Badge variant="outline" className="text-xs px-1.5 py-0 hover:bg-muted cursor-pointer">
                            {as.stock.ticker}
                          </Badge>
                        </Link>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {article.source} · {formatDistanceToNow(article.publishedAt)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  href,
  small,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  href?: string;
  small?: boolean;
}) {
  const card = (
    <Card className={href ? "hover:bg-muted/50 transition-colors cursor-pointer h-full" : "h-full"}>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
          {Icon && <Icon className="h-3.5 w-3.5" />}
          {label}
        </div>
        <p className={`${small ? "text-lg" : "text-2xl"} font-bold mt-1 tabular-nums`}>{value}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{card}</Link> : card;
}

function MoverRow({ ticker, name, score }: { ticker: string; name: string; score: number }) {
  const m = mood(score);
  return (
    <Link
      href={`/dashboard/stocks/${ticker}`}
      className="flex items-center justify-between gap-2 -mx-2 px-2 py-1 rounded-md hover:bg-muted transition-colors"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">{ticker}</p>
        <p className="text-xs text-muted-foreground truncate">{name}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm tabular-nums">{score.toFixed(2)}</span>
        <span className="text-lg">{m.emoji}</span>
      </div>
    </Link>
  );
}
