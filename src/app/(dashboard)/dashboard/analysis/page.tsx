import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { mood } from "@/lib/mood";
import { classifyRsi, isBollingerSqueeze } from "@/lib/signals";

export const metadata = { title: "Analysis — TraderNews" };
export const dynamic = "force-dynamic";

function ChangePill({ value, label }: { value: number | null | undefined; label: string }) {
  if (value == null) return null;
  const pos = value >= 0;
  return (
    <Badge
      className={cn(
        "font-medium tabular-nums",
        pos
          ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
          : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
      )}
    >
      {pos ? "+" : ""}
      {value.toFixed(1)}% {label}
    </Badge>
  );
}

function ScoreBar({ label, score, color }: { label: string; score: number; color: string }) {
  const pct = Math.round(((score + 1) / 2) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span
        className={`tabular-nums w-12 text-right font-medium ${
          score >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
        }`}
      >
        {score >= 0 ? "+" : ""}
        {score.toFixed(2)}
      </span>
    </div>
  );
}

function RsiBadge({ rsi }: { rsi: number }) {
  const signal = classifyRsi(rsi);
  if (signal === "bullish") // oversold
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">Oversold</Badge>
    );
  if (signal === "bearish") // overbought
    return (
      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">Overbought</Badge>
    );
  return <Badge variant="secondary">Neutral</Badge>;
}

export default async function AnalysisPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          stockEstimates: { orderBy: { date: "desc" }, take: 1 },
          quantAnalyses: { orderBy: { date: "desc" }, take: 1 },
        },
      },
    },
  });

  const stocks = userStocks
    .map(({ stock }) => ({
      id: stock.id,
      ticker: stock.ticker,
      name: stock.name,
      estimate: stock.stockEstimates[0] ?? null,
      quant: stock.quantAnalyses[0] ?? null,
    }))
    .sort((a, b) => {
      const scoreA = a.estimate?.combinedScore ?? -Infinity;
      const scoreB = b.estimate?.combinedScore ?? -Infinity;
      return scoreB - scoreA;
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analysis</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Combined sentiment and quantitative estimate for your watchlist
        </p>
      </div>

      {stocks.length === 0 || stocks.every((s) => !s.estimate) ? (
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">📊</p>
            <p className="font-medium">No analysis data yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add stocks to your watchlist and run the pipeline
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {stocks.map((stock) => {
            const combined = stock.estimate?.combinedScore ?? 0;
            const m = mood(combined);
            const q = stock.quant;
            const hasEstimate = !!stock.estimate;

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
                    <span className="text-4xl" aria-hidden>{m.emoji}</span>
                  </div>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <p className="text-white text-4xl font-bold tabular-nums">
                        {hasEstimate ? combined.toFixed(2) : "—"}
                      </p>
                      <p className="text-white/80 text-sm mt-0.5">{m.label}</p>
                    </div>
                    {stock.estimate && (
                      <p className="text-white/70 text-xs">
                        {formatDistanceToNow(new Date(stock.estimate.date))}
                      </p>
                    )}
                  </div>
                </Link>

                <CardContent className="p-4 space-y-3">
                  {/* Price + % change row */}
                  {q?.price != null && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold tabular-nums text-sm">
                        {q.price.toFixed(2)}
                      </span>
                      <ChangePill value={q.change1d} label="1d" />
                      <ChangePill value={q.change7d} label="7d" />
                      <ChangePill value={q.change30d} label="30d" />
                    </div>
                  )}

                  {/* RSI + SMA + new signals row */}
                  {q?.rsi14 != null && (
                    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                      <span>RSI {q.rsi14.toFixed(0)}</span>
                      <RsiBadge rsi={q.rsi14} />
                      {q.sma20 != null && q.price != null && (
                        <span
                          className={
                            q.price > q.sma20
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-500 dark:text-red-400"
                          }
                        >
                          {q.price > q.sma20 ? "↑" : "↓"} SMA20
                        </span>
                      )}
                      {isBollingerSqueeze(q.bollingerWidth) && (
                        <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">BB squeeze</Badge>
                      )}
                      {q.atrPct != null && (
                        <span>{q.atrPct.toFixed(1)}% ATR</span>
                      )}
                      {q.daysToEarnings != null && q.daysToEarnings <= 7 && (
                        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                          Earnings in {q.daysToEarnings}d
                        </Badge>
                      )}
                    </div>
                  )}

                  {/* Score bars */}
                  {stock.estimate && (
                    <div className="space-y-1.5 pt-1">
                      <ScoreBar label="Sentiment" score={stock.estimate.sentimentScore} color="#3b82f6" />
                      {stock.estimate.quantScore != null && (
                        <ScoreBar label="Quant" score={stock.estimate.quantScore} color="#8b5cf6" />
                      )}
                      <ScoreBar label="Combined" score={stock.estimate.combinedScore} color={m.chartColor} />
                    </div>
                  )}

                  {!hasEstimate && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      Run the pipeline to generate analysis
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
