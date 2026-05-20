"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { formatDistanceToNow } from "@/lib/format-date";

type SentimentPoint = { date: string; score: number; summary: string | null };
type StockSentiment = {
  id: string;
  ticker: string;
  name: string;
  latest: { score: number; summary: string | null; date: string } | null;
  history: SentimentPoint[];
};

function mood(score: number): { emoji: string; label: string; gradient: string; text: string; area: string } {
  if (score > 0.6)  return { emoji: "🚀", label: "Very Bullish",  gradient: "from-emerald-400 to-green-500",   text: "text-emerald-600 dark:text-emerald-400", area: "#22c55e" };
  if (score > 0.2)  return { emoji: "📈", label: "Bullish",       gradient: "from-green-300 to-emerald-400",   text: "text-green-600 dark:text-green-400",   area: "#4ade80" };
  if (score > -0.2) return { emoji: "😐", label: "Neutral",       gradient: "from-slate-300 to-slate-400",     text: "text-slate-500 dark:text-slate-400",   area: "#94a3b8" };
  if (score > -0.6) return { emoji: "📉", label: "Bearish",       gradient: "from-orange-300 to-red-400",      text: "text-orange-600 dark:text-orange-400", area: "#f97316" };
  return              { emoji: "🔻", label: "Very Bearish",  gradient: "from-red-400 to-rose-500",        text: "text-red-600 dark:text-red-400",       area: "#ef4444" };
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: SentimentPoint }[] }) {
  if (!active || !payload?.length) return null;
  const { score, summary, date } = payload[0].payload;
  const m = mood(score);
  return (
    <div className="bg-background border rounded-xl p-3 shadow-lg text-sm max-w-[200px]">
      <p className="font-semibold">{m.emoji} {score.toFixed(2)}</p>
      {summary && <p className="text-muted-foreground text-xs mt-1 leading-relaxed">{summary}</p>}
      <p className="text-muted-foreground text-xs mt-1">{formatDistanceToNow(new Date(date))}</p>
    </div>
  );
}

export default function SentimentPage() {
  const [stocks, setStocks] = useState<StockSentiment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sentiment")
      .then((r) => r.json())
      .then((data: StockSentiment[]) => {
        setStocks(data.sort((a, b) => (b.latest?.score ?? -Infinity) - (a.latest?.score ?? -Infinity)));
        setLoading(false);
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sentiment</h1>
        <p className="text-muted-foreground text-sm mt-1">
          How the market feels about your stocks right now
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56 w-full rounded-2xl" />)}
        </div>
      ) : stocks.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">📭</p>
            <p className="font-medium">No sentiment data yet</p>
            <p className="text-muted-foreground text-sm mt-1">Add stocks to your watchlist and run the pipeline</p>
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
                {/* Gradient header */}
                <div className={`bg-gradient-to-r ${m.gradient} p-5`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-white/80 text-sm font-medium">{stock.name}</p>
                      <p className="text-white text-2xl font-bold mt-0.5">{stock.ticker}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-4xl">{m.emoji}</span>
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
                </div>

                <CardContent className="p-4 space-y-3">
                  {stock.latest?.summary && (
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {stock.latest.summary}
                    </p>
                  )}

                  {hasHistory && (
                    <ResponsiveContainer width="100%" height={80}>
                      <AreaChart data={stock.history} margin={{ top: 4, right: 4, left: -30, bottom: 0 }}>
                        <defs>
                          <linearGradient id={`grad-${stock.id}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={m.area} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={m.area} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <ReferenceLine y={0} stroke="#e2e8f0" strokeDasharray="3 3" />
                        <Tooltip content={<CustomTooltip />} />
                        <Area
                          type="monotone"
                          dataKey="score"
                          stroke={m.area}
                          strokeWidth={2}
                          fill={`url(#grad-${stock.id})`}
                          dot={false}
                          activeDot={{ r: 4, fill: m.area }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}

                  {!hasHistory && (
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
