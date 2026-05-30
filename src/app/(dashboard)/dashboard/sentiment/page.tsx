import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { mood } from "@/lib/mood";
import { SentimentSparkline } from "@/components/sentiment-sparkline";

export const metadata = { title: "Sentiment — TraderNews" };

function formatChartDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default async function SentimentPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          sentiments: { orderBy: { date: "desc" }, take: 30 },
        },
      },
    },
  });

  const stocks = userStocks
    .map(({ stock }) => ({
      id: stock.id,
      ticker: stock.ticker,
      name: stock.name,
      latest: stock.sentiments[0]
        ? {
            score: stock.sentiments[0].score,
            summary: stock.sentiments[0].summary,
            date: stock.sentiments[0].date.toISOString(),
          }
        : null,
      history: stock.sentiments
        .slice()
        .reverse()
        .map((s) => ({
          date: s.date.toISOString(),
          score: parseFloat(s.score.toFixed(3)),
          summary: s.summary,
        })),
    }))
    .sort((a, b) => (b.latest?.score ?? -Infinity) - (a.latest?.score ?? -Infinity));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sentiment</h1>
        <p className="text-muted-foreground text-sm mt-1">
          How the market feels about your stocks right now
        </p>
      </div>

      {stocks.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">📭</p>
            <p className="font-medium">No sentiment data yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add stocks to your watchlist and run the pipeline
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {stocks.map((stock) => {
            const score = stock.latest?.score ?? 0;
            const m = mood(score);
            const hasHistory = stock.history.length > 1;

            return (
              <Card key={stock.id} className="rounded-2xl overflow-hidden border-0 shadow-sm bg-card">
                <Link
                  href={`/dashboard/stocks/${stock.ticker}`}
                  className={`block bg-gradient-to-r ${m.gradient} p-5 hover:brightness-105 transition-all`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-white/80 text-sm font-medium">{stock.name}</p>
                      <p className="text-white text-2xl font-bold mt-0.5">{stock.ticker}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-4xl" aria-hidden>{m.emoji}</span>
                    </div>
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <p className="text-white text-4xl font-bold tabular-nums">{score.toFixed(2)}</p>
                      <p className="text-white/80 text-sm mt-0.5">{m.label}</p>
                    </div>
                    {stock.latest && (
                      <p className="text-white/70 text-xs">
                        {formatDistanceToNow(new Date(stock.latest.date))}
                      </p>
                    )}
                  </div>
                </Link>

                <CardContent className="p-4 space-y-3">
                  {stock.latest?.summary && (
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {stock.latest.summary}
                    </p>
                  )}

                  {hasHistory ? (
                    <div className="space-y-1">
                      <SentimentSparkline
                        data={stock.history}
                        color={m.chartColor}
                        gradientId={`grad-${stock.id}`}
                      />
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
                        <span>{formatChartDate(stock.history[0].date)}</span>
                        <span>{stock.history.length} readings</span>
                        <span>{formatChartDate(stock.history[stock.history.length - 1].date)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      Run the pipeline again to see trend history
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
