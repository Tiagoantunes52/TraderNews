import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Layers, Activity, GitCompare, Bell } from "lucide-react";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { mood } from "@/lib/mood";
import { sectorForTicker } from "@/lib/sectors";
import { pearson } from "@/lib/stats";
import { formatDistanceToNow } from "@/lib/format-date";
import { SentimentSparkline, type SparklinePoint } from "@/components/sentiment-sparkline";

export const metadata = { title: "Portfolio — TraderNews" };
export const dynamic = "force-dynamic";

const HISTORY = 60; // records pulled per stock for history-based views
const CONCENTRATION_THRESHOLD = 0.4; // flag a sector above 40% of watchlist

type Cell = "bullish" | "bearish" | "neutral" | null;

function dayStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

function cellClass(c: Cell): string {
  switch (c) {
    case "bullish":
      return "bg-green-500/80 text-white";
    case "bearish":
      return "bg-red-500/80 text-white";
    case "neutral":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted/40 text-muted-foreground/50";
  }
}

export default async function PortfolioPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          sentiments: { orderBy: { date: "desc" }, take: HISTORY },
          quantAnalyses: { orderBy: { date: "desc" }, take: HISTORY },
          stockEstimates: { orderBy: { date: "desc" }, take: 1 },
        },
      },
    },
  });

  const stocks = userStocks.map(({ stock }) => ({
    id: stock.id,
    ticker: stock.ticker,
    name: stock.name,
    sentiments: stock.sentiments, // desc
    quants: stock.quantAnalyses, // desc
    estimate: stock.stockEstimates[0] ?? null,
    latestSentiment: stock.sentiments[0] ?? null,
    latestQuant: stock.quantAnalyses[0] ?? null,
  }));

  // Recent alert events across the watchlist (last 14 days)
  const stockIds = stocks.map((s) => s.id);
  const tickerById = new Map(stocks.map((s) => [s.id, s.ticker]));
  // eslint-disable-next-line react-hooks/purity -- server component, fresh render per request
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentAlerts =
    stockIds.length > 0
      ? await db.alert.findMany({
          where: { stockId: { in: stockIds }, createdAt: { gte: since14d } },
          orderBy: { createdAt: "desc" },
          take: 12,
        })
      : [];

  const withSentiment = stocks.filter((s) => s.latestSentiment !== null);

  // ── View 1: Aggregate sentiment drift ──────────────────────────────────
  // Current weighted average (by article count, falling back to simple mean).
  const weightedNow = weightedSentiment(
    withSentiment.map((s) => ({ score: s.latestSentiment!.score, weight: s.latestSentiment!.articleCount }))
  );

  // 30-day portfolio history: group every stock's readings by day, then take a
  // weighted average per day across whichever stocks have a reading that day.
  const byDay = new Map<string, { score: number; weight: number }[]>();
  for (const s of withSentiment) {
    for (const sen of s.sentiments) {
      const key = dayStr(sen.date);
      const arr = byDay.get(key) ?? [];
      arr.push({ score: sen.score, weight: sen.articleCount });
      byDay.set(key, arr);
    }
  }
  const driftPoints: SparklinePoint[] = [...byDay.entries()]
    .map(([day, entries]) => ({
      date: `${day}T00:00:00.000Z`,
      score: weightedSentiment(entries) ?? 0,
      summary: `${entries.length} ${entries.length === 1 ? "stock" : "stocks"} reporting`,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  const driftFrom = driftPoints.length > 1 ? driftPoints[0].score : null;
  const drift = weightedNow !== null && driftFrom !== null ? weightedNow - driftFrom : null;
  const m = weightedNow !== null ? mood(weightedNow) : null;

  // ── View 2: Signal agreement heatmap ───────────────────────────────────
  const heatRows = stocks
    .map((s) => {
      const q = s.latestQuant;
      const sentScore = s.estimate?.sentimentScore ?? s.latestSentiment?.score ?? null;
      const cells = {
        sentiment: signFromScore(sentScore, 0.1),
        rsi: rsiCell(q?.rsi14 ?? null),
        macd: signFromScore(q?.macdHistogram ?? null, 0),
        momentum: signFromScore(q?.change7d ?? null, 0.5),
      };
      const vals = Object.values(cells);
      const bull = vals.filter((c) => c === "bullish").length;
      const bear = vals.filter((c) => c === "bearish").length;
      return { ...s, cells, bull, bear, hasData: vals.some((c) => c !== null) };
    })
    .filter((r) => r.hasData)
    .sort((a, b) => b.bull - b.bear - (a.bull - a.bear));

  // ── View 3: Sector concentration ───────────────────────────────────────
  const sectorCounts = new Map<string, string[]>();
  for (const s of stocks) {
    const sector = sectorForTicker(s.ticker);
    const arr = sectorCounts.get(sector) ?? [];
    arr.push(s.ticker);
    sectorCounts.set(sector, arr);
  }
  const total = stocks.length;
  const sectors = [...sectorCounts.entries()]
    .map(([name, tickers]) => ({
      name,
      tickers,
      count: tickers.length,
      pct: total > 0 ? tickers.length / total : 0,
    }))
    .sort((a, b) => b.count - a.count);
  const overweight = sectors.filter((s) => s.pct > CONCENTRATION_THRESHOLD);

  // ── View 4: Sentiment-vs-price correlation ─────────────────────────────
  const correlations = stocks
    .map((s) => {
      // Pair sentiment on day D with the next available next-day return.
      const sens = [...s.sentiments].sort((a, b) => a.date.getTime() - b.date.getTime());
      const quants = [...s.quants]
        .filter((q) => q.change1d != null)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      const xs: number[] = [];
      const ys: number[] = [];
      for (const sen of sens) {
        const d = dayStr(sen.date);
        const next = quants.find((q) => dayStr(q.date) > d);
        if (next) {
          xs.push(sen.score);
          ys.push(next.change1d!);
        }
      }
      return { ticker: s.ticker, name: s.name, r: pearson(xs, ys), pairs: xs.length };
    })
    .filter((c) => c.r !== null)
    .sort((a, b) => (b.r ?? 0) - (a.r ?? 0));

  const empty = stocks.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Watchlist-wide signals: drift, agreement, concentration, and model quality
        </p>
      </div>

      {empty ? (
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">🧭</p>
            <p className="font-medium">Your watchlist is empty</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add stocks to your watchlist to see portfolio-level views
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Recent alerts */}
          {recentAlerts.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Bell className="h-4 w-4 text-muted-foreground" /> Recent alerts
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {recentAlerts.map((a) => {
                  const ticker = tickerById.get(a.stockId);
                  return (
                    <div key={a.id} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium leading-snug">{a.title}</p>
                        <p className="text-xs text-muted-foreground leading-snug">{a.message}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        {ticker && (
                          <Link
                            href={`/dashboard/stocks/${ticker}`}
                            className="text-xs font-semibold hover:underline"
                          >
                            {ticker}
                          </Link>
                        )}
                        <p className="text-[11px] text-muted-foreground">
                          {formatDistanceToNow(a.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* View 1 — Aggregate sentiment drift */}
          <Card className="rounded-2xl overflow-hidden border-0 shadow-sm">
            <div className={`bg-gradient-to-br ${m?.gradient ?? "from-slate-200 to-slate-300"} p-6`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white/80 text-sm font-medium flex items-center gap-1.5">
                    <Activity className="h-4 w-4" /> Aggregate sentiment
                  </p>
                  <p className="text-white text-5xl font-bold tabular-nums mt-2">
                    {weightedNow !== null ? weightedNow.toFixed(2) : "—"}
                  </p>
                  <p className="text-white/90 mt-1 font-medium">{m?.label ?? "No data yet"}</p>
                </div>
                <div className="text-right">
                  <span className="text-5xl">{m?.emoji ?? "📊"}</span>
                  {drift !== null && (
                    <p className="text-white/90 text-sm mt-2 tabular-nums">
                      {drift >= 0 ? "▲" : "▼"} {drift >= 0 ? "+" : ""}
                      {drift.toFixed(2)} <span className="text-white/70">30d drift</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
            <CardContent className="p-4">
              {driftPoints.length > 1 ? (
                <SentimentSparkline
                  data={driftPoints}
                  color={m?.chartColor ?? "#64748b"}
                  gradientId="portfolio-drift"
                />
              ) : (
                <p className="text-xs text-muted-foreground text-center py-6">
                  Not enough history yet — drift appears once the pipeline has run on multiple days
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Article-count-weighted average across {withSentiment.length}{" "}
                {withSentiment.length === 1 ? "stock" : "stocks"}
              </p>
            </CardContent>
          </Card>

          {/* View 3 — Sector concentration */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" /> Sector concentration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {overweight.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-amber-800 dark:text-amber-300">
                    {overweight.map((s) => `${s.name} is ${Math.round(s.pct * 100)}%`).join(", ")} of
                    your watchlist — consider diversifying (threshold{" "}
                    {Math.round(CONCENTRATION_THRESHOLD * 100)}%).
                  </p>
                </div>
              )}
              <div className="space-y-2">
                {sectors.map((s) => {
                  const over = s.pct > CONCENTRATION_THRESHOLD;
                  return (
                    <div key={s.name} className="flex items-center gap-2 text-xs">
                      <span className="w-40 shrink-0 truncate" title={s.tickers.join(", ")}>
                        {s.name}{" "}
                        <span className="text-muted-foreground">({s.count})</span>
                      </span>
                      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${over ? "bg-amber-500" : "bg-primary"}`}
                          style={{ width: `${Math.round(s.pct * 100)}%` }}
                        />
                      </div>
                      <span className="tabular-nums w-10 text-right text-muted-foreground">
                        {Math.round(s.pct * 100)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* View 2 — Signal agreement heatmap */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <GitCompare className="h-4 w-4 text-muted-foreground" /> Signal agreement
              </CardTitle>
            </CardHeader>
            <CardContent>
              {heatRows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No signal data yet — run the pipeline
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-separate border-spacing-1">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-medium px-1">Stock</th>
                        <th className="font-medium px-1">Sentiment</th>
                        <th className="font-medium px-1">RSI</th>
                        <th className="font-medium px-1">MACD</th>
                        <th className="font-medium px-1">Momentum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {heatRows.map((r) => (
                        <tr key={r.id}>
                          <td className="px-1">
                            <Link
                              href={`/dashboard/stocks/${r.ticker}`}
                              className="font-semibold hover:underline"
                            >
                              {r.ticker}
                            </Link>
                          </td>
                          {(["sentiment", "rsi", "macd", "momentum"] as const).map((k) => (
                            <td key={k} className="px-0.5">
                              <div
                                className={`h-7 rounded-md flex items-center justify-center font-medium ${cellClass(
                                  r.cells[k]
                                )}`}
                              >
                                {cellGlyph(r.cells[k])}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex items-center gap-3 mt-3 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="h-3 w-3 rounded bg-green-500/80 inline-block" /> Bullish
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-3 w-3 rounded bg-red-500/80 inline-block" /> Bearish
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-3 w-3 rounded bg-muted inline-block" /> Neutral
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* View 4 — Sentiment-vs-price correlation */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" /> Sentiment → price correlation
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                How well each stock&apos;s daily sentiment predicts the <em>next</em> day&apos;s price
                move. Positive = sentiment leads price (model is informative). Needs ≥ 5 paired days.
              </p>
              {correlations.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  Not enough paired history yet
                </p>
              ) : (
                <div className="space-y-2">
                  {correlations.map((c) => {
                    const r = c.r!;
                    const pos = r >= 0;
                    const pct = Math.round((Math.abs(r) / 1) * 100);
                    return (
                      <div key={c.ticker} className="flex items-center gap-2 text-xs">
                        <Link
                          href={`/dashboard/stocks/${c.ticker}`}
                          className="w-16 shrink-0 font-semibold hover:underline"
                        >
                          {c.ticker}
                        </Link>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pos ? "bg-green-500" : "bg-red-500"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span
                          className={`tabular-nums w-12 text-right font-medium ${
                            pos ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
                          }`}
                        >
                          {pos ? "+" : ""}
                          {r.toFixed(2)}
                        </span>
                        <span className="w-20 shrink-0 text-right text-muted-foreground">
                          {corrLabel(r)} · {c.pairs}d
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function weightedSentiment(entries: { score: number; weight: number }[]): number | null {
  if (entries.length === 0) return null;
  const totalW = entries.reduce((a, e) => a + e.weight, 0);
  if (totalW <= 0) {
    // No article counts — fall back to a simple mean.
    return entries.reduce((a, e) => a + e.score, 0) / entries.length;
  }
  return entries.reduce((a, e) => a + e.score * e.weight, 0) / totalW;
}

function signFromScore(v: number | null | undefined, threshold: number): Cell {
  if (v == null) return null;
  if (v > threshold) return "bullish";
  if (v < -threshold) return "bearish";
  return "neutral";
}

function rsiCell(rsi: number | null): Cell {
  if (rsi == null) return null;
  if (rsi < 30) return "bullish"; // oversold → mean-reversion upside
  if (rsi > 70) return "bearish"; // overbought
  return "neutral";
}

function cellGlyph(c: Cell): string {
  switch (c) {
    case "bullish":
      return "▲";
    case "bearish":
      return "▼";
    case "neutral":
      return "–";
    default:
      return "·";
  }
}

function corrLabel(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.6) return "strong";
  if (a >= 0.3) return "moderate";
  if (a >= 0.1) return "weak";
  return "none";
}
