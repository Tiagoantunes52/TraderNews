import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Newspaper, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";

function SentimentBadge({ score }: { score?: number }) {
  if (score === undefined) return null;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 shrink-0"><TrendingUp className="h-3 w-3 mr-1" />Bullish</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 shrink-0"><TrendingDown className="h-3 w-3 mr-1" />Bearish</Badge>;
  return <Badge variant="secondary" className="shrink-0"><Minus className="h-3 w-3 mr-1" />Neutral</Badge>;
}

export default async function DashboardPage() {
  const user = await getOrCreateUser();

  // Fetch articles linked to stocks the user follows
  let articles = user
    ? await db.article.findMany({
        where: {
          articleStock: {
            some: {
              stock: { userStocks: { some: { userId: user.id } } },
            },
          },
        },
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
        take: 50,
      })
    : [];

  // Fall back to latest general articles if user has no followed stocks
  if (articles.length === 0) {
    articles = await db.article.findMany({
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
      take: 50,
    });
  }

  const hasFollowedStocks = user
    ? (await db.userStock.count({ where: { userId: user.id } })) > 0
    : false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">News Feed</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {hasFollowedStocks
            ? "Latest news for your watchlist stocks"
            : "Latest market news — add stocks to your watchlist to personalise this feed"}
        </p>
      </div>

      {articles.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">
            No articles yet. Run the news pipeline to fetch the latest market news.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {articles.map((article) => {
            const tickers = article.articleStock.map((as) => as.stock);
            const topSentiment = tickers
              .flatMap((s) => s.sentiments)
              .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0];

            return (
              <a key={article.id} href={article.url} target="_blank" rel="noopener noreferrer">
                <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-4">
                      <CardTitle className="text-base font-medium leading-snug">
                        {article.headline}
                      </CardTitle>
                      <SentimentBadge score={topSentiment?.score} />
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
                              <Badge key={stock.id} variant="outline" className="text-xs px-1.5 py-0">
                                {stock.ticker}
                              </Badge>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
