import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper, Activity, Calendar, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { WatchlistToggleButton } from "@/components/watchlist-toggle-button";
import { SentimentHistoryChart } from "@/components/sentiment-history-chart";
import { mood } from "@/lib/mood";

export default async function StockDetailPage({ params }: PageProps<"/dashboard/stocks/[ticker]">) {
  const { ticker } = await params;
  const tickerUpper = decodeURIComponent(ticker).toUpperCase();

  const stock = await db.stock.findFirst({
    where: { ticker: { equals: tickerUpper, mode: "insensitive" } },
    include: {
      market: true,
      sentiments: { orderBy: { date: "desc" }, take: 30 },
      articleStock: {
        include: { article: true },
        orderBy: { article: { publishedAt: "desc" } },
        take: 20,
      },
    },
  });

  if (!stock) notFound();

  const user = await getOrCreateUser();
  const followed = user
    ? (await db.userStock.count({
        where: { userId: user.id, stockId: stock.id },
      })) > 0
    : false;

  const latest = stock.sentiments[0] ?? null;
  const m = latest ? mood(latest.score) : null;

  const history = stock.sentiments
    .slice()
    .reverse()
    .map((s) => ({
      date: s.date.toISOString(),
      score: parseFloat(s.score.toFixed(3)),
      summary: s.summary,
    }));

  const articles = stock.articleStock.map((as) => as.article);

  return (
    <div className="space-y-6">
      <BackLink fallbackHref="/dashboard" label="Back" />

      {/* Header card with mood */}
      <Card className="rounded-2xl overflow-hidden border-0 shadow-sm">
        <div className={`bg-gradient-to-br ${m?.gradient ?? "from-slate-300 to-slate-400"} p-6`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-white/80 text-sm font-medium">{stock.market.name}</p>
              <h1 className="text-white text-4xl font-bold mt-1">{stock.ticker}</h1>
              <p className="text-white/90 text-sm mt-1">{stock.name}</p>
            </div>
            <div className="text-right">
              <p className="text-white text-5xl font-bold tabular-nums">
                {latest ? latest.score.toFixed(2) : "—"}
              </p>
              <p className="text-white/90 text-sm mt-1 font-medium">
                {m?.label ?? "No sentiment data"} {m && <span className="ml-1">{m.emoji}</span>}
              </p>
            </div>
          </div>
        </div>
        <CardContent className="p-4 flex items-center justify-between flex-wrap gap-3">
          <p className="text-sm text-muted-foreground">
            {latest
              ? `Last updated ${formatDistanceToNow(new Date(latest.date))}`
              : "Run the pipeline to generate sentiment for this stock"}
          </p>
          {user && <WatchlistToggleButton stockId={stock.id} ticker={stock.ticker} initialFollowed={followed} />}
        </CardContent>
      </Card>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Articles" value={articles.length} icon={Newspaper} />
        <StatCard label="Sentiment readings" value={stock.sentiments.length} icon={Activity} />
        <StatCard
          label="First reading"
          value={
            stock.sentiments.length > 0
              ? formatDistanceToNow(stock.sentiments[stock.sentiments.length - 1].date)
              : "—"
          }
          icon={Calendar}
          small
        />
      </div>

      {/* Sentiment summary */}
      {latest?.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Latest summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-muted-foreground">{latest.summary}</p>
          </CardContent>
        </Card>
      )}

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Sentiment trend</CardTitle>
        </CardHeader>
        <CardContent>
          <SentimentHistoryChart data={history} color={m?.chartColor ?? "#64748b"} />
        </CardContent>
      </Card>

      {/* Recent headlines */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent headlines</h2>
        {articles.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No articles linked to this stock yet.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {articles.map((article) => (
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
                    <div className="self-start">
                      <ArticleSentimentBadge score={latest?.score} />
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

export const dynamic = "force-dynamic";

function ArticleSentimentBadge({ score }: { score?: number }) {
  if (score === undefined) return null;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 shrink-0 text-xs"><TrendingUp className="h-3 w-3 mr-1" />Bullish</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 shrink-0 text-xs"><TrendingDown className="h-3 w-3 mr-1" />Bearish</Badge>;
  return <Badge variant="secondary" className="shrink-0 text-xs"><Minus className="h-3 w-3 mr-1" />Neutral</Badge>;
}

function StatCard({
  label,
  value,
  icon: Icon,
  small,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  small?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </div>
        <p className={`${small ? "text-lg" : "text-2xl"} font-bold mt-1 tabular-nums`}>{value}</p>
      </CardContent>
    </Card>
  );
}
