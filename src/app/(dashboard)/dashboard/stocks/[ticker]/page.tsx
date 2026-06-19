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
import { CongressTradeList } from "@/components/congress-trade-list";
import { Hint, HINT_TEXT } from "@/components/hint";
import { cn } from "@/lib/utils";
import { mood } from "@/lib/mood";
import { safeExternalHref } from "@/lib/normalize";
import { classifyRsi, isBollingerSqueeze, INDICATOR_HINTS } from "@/lib/signals";

// ETF fundamentals shown on this page — glossed for non-experts.
const ETF_HINTS = {
  expenseRatio:
    "The fund's annual fee as a % of assets — e.g. 0.20% is about $2 a year per $1,000 invested. Lower is cheaper to hold.",
  dividendYield:
    "Dividends paid over the trailing year as a % of the fund's price.",
  netAssets:
    "Total market value of everything the fund holds (assets under management). Larger funds tend to be more liquid.",
} as const;

export default async function StockDetailPage({ params }: PageProps<"/dashboard/stocks/[ticker]">) {
  const { ticker } = await params;
  const tickerUpper = decodeURIComponent(ticker).toUpperCase();

  const stock = await db.stock.findFirst({
    where: { ticker: { equals: tickerUpper, mode: "insensitive" } },
    include: {
      market: true,
      sentiments: { orderBy: { date: "desc" }, take: 30 },
      quantAnalyses: { orderBy: { date: "desc" }, take: 1 },
      stockEstimates: { orderBy: { date: "desc" }, take: 1 },
      etfProfile: true,
      congressTrades: { orderBy: { transactionDate: "desc" }, take: 10 },
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
  const latestAspects = Object.entries(
    (latest?.aspects as Record<string, { score: number; weight: number }> | null) ?? {}
  )
    .filter(([, a]) => a && typeof a.score === "number")
    .sort((a, b) => (b[1].weight ?? 0) - (a[1].weight ?? 0));
  const quant = stock.quantAnalyses[0] ?? null;
  const estimate = stock.stockEstimates[0] ?? null;

  const etf = stock.etfProfile;
  const etfSectors = (etf?.sectors as { sector: string; weight: number }[] | null) ?? [];
  const etfHoldings = (etf?.holdings as { symbol: string; description: string; weight: number }[] | null) ?? [];

  const history = stock.sentiments
    .slice()
    .reverse()
    .map((s) => ({
      date: s.date.toISOString(),
      score: parseFloat(s.score.toFixed(3)),
      summary: s.summary,
    }));

  // Map articleStock join records to articles with per-article sentimentScore
  const articles = stock.articleStock.map((as) => ({
    ...as.article,
    sentimentScore: as.sentimentScore,
  }));

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

      {/* Quantitative analysis */}
      {(quant || estimate) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Quantitative Analysis</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {quant?.price != null && (
              <div className="grid grid-cols-4 gap-3">
                <QuantStat label="Price" value={quant.price.toFixed(2)} />
                <QuantStat
                  label="1d"
                  value={quant.change1d != null ? `${quant.change1d >= 0 ? "+" : ""}${quant.change1d.toFixed(1)}%` : "—"}
                  positive={quant.change1d != null ? quant.change1d >= 0 : undefined}
                />
                <QuantStat
                  label="7d"
                  value={quant.change7d != null ? `${quant.change7d >= 0 ? "+" : ""}${quant.change7d.toFixed(1)}%` : "—"}
                  positive={quant.change7d != null ? quant.change7d >= 0 : undefined}
                />
                <QuantStat
                  label="30d"
                  value={quant.change30d != null ? `${quant.change30d >= 0 ? "+" : ""}${quant.change30d.toFixed(1)}%` : "—"}
                  positive={quant.change30d != null ? quant.change30d >= 0 : undefined}
                />
              </div>
            )}

            {quant?.rsi14 != null && (
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <Hint text={INDICATOR_HINTS.rsi} className={cn(HINT_TEXT, "text-muted-foreground")}>
                  RSI {quant.rsi14.toFixed(0)}
                </Hint>
                {classifyRsi(quant.rsi14) === "bullish" && (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">Oversold</Badge>
                )}
                {classifyRsi(quant.rsi14) === "bearish" && (
                  <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">Overbought</Badge>
                )}
                {quant.sma20 != null && quant.price != null && (
                  <Hint
                    text={INDICATOR_HINTS.sma20}
                    className={cn(HINT_TEXT, "text-xs", quant.price > quant.sma20 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400")}
                  >
                    {quant.price > quant.sma20 ? "↑ Above" : "↓ Below"} SMA20
                  </Hint>
                )}
                {quant.sma50 != null && quant.price != null && (
                  <Hint
                    text={INDICATOR_HINTS.sma50}
                    className={cn(HINT_TEXT, "text-xs", quant.price > quant.sma50 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400")}
                  >
                    {quant.price > quant.sma50 ? "↑ Above" : "↓ Below"} SMA50
                  </Hint>
                )}
                {quant.bollingerPctB != null && (
                  <Hint text={INDICATOR_HINTS.pctB} className={cn(HINT_TEXT, "text-xs text-muted-foreground")}>
                    %B {(quant.bollingerPctB * 100).toFixed(0)}
                  </Hint>
                )}
                {isBollingerSqueeze(quant.bollingerWidth) && (
                  <Hint text={INDICATOR_HINTS.bollingerSqueeze}>
                    <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 cursor-help">BB squeeze</Badge>
                  </Hint>
                )}
                {quant.atrPct != null && (
                  <Hint text={INDICATOR_HINTS.atr} className={cn(HINT_TEXT, "text-xs text-muted-foreground")}>
                    ATR {quant.atrPct.toFixed(1)}%
                  </Hint>
                )}
                {quant.daysToEarnings != null && quant.daysToEarnings <= 7 && (
                  <Hint text={INDICATOR_HINTS.earnings}>
                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 cursor-help">
                      Earnings in {quant.daysToEarnings}d
                    </Badge>
                  </Hint>
                )}
              </div>
            )}

            {estimate && (
              <div className="space-y-1.5 pt-1 border-t">
                <p className="text-xs text-muted-foreground pt-2">Combined estimate</p>
                {/* Data warnings (includes earnings proximity warning from pipeline) */}
                {estimate.dataWarnings.length > 0 && (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 space-y-0.5">
                    {estimate.dataWarnings.map((w) => (
                      <p key={w} className="text-xs text-amber-700 dark:text-amber-400">⚠ {w}</p>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs">
                  <Hint text={INDICATOR_HINTS.sentimentScore} className={cn(HINT_TEXT, "text-muted-foreground w-20 shrink-0")}>
                    Sentiment
                  </Hint>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.round(((estimate.sentimentScore + 1) / 2) * 100)}%` }} />
                  </div>
                  <span className={`tabular-nums w-12 text-right font-medium ${estimate.sentimentScore >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                    {estimate.sentimentScore >= 0 ? "+" : ""}{estimate.sentimentScore.toFixed(2)}
                  </span>
                </div>
                {estimate.quantScore != null && (
                  <div className="flex items-center gap-2 text-xs">
                    <Hint text={INDICATOR_HINTS.quantScore} className={cn(HINT_TEXT, "text-muted-foreground w-20 shrink-0")}>
                      Quant
                    </Hint>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.round(((estimate.quantScore + 1) / 2) * 100)}%` }} />
                    </div>
                    <span className={`tabular-nums w-12 text-right font-medium ${estimate.quantScore >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                      {estimate.quantScore >= 0 ? "+" : ""}{estimate.quantScore.toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs">
                  <Hint text={INDICATOR_HINTS.combinedScore} className={cn(HINT_TEXT, "text-muted-foreground w-20 shrink-0 font-medium")}>
                    Combined
                  </Hint>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.round(((estimate.combinedScore + 1) / 2) * 100)}%`, backgroundColor: mood(estimate.combinedScore).chartColor }} />
                  </div>
                  <span className={`tabular-nums w-12 text-right font-medium ${estimate.combinedScore >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                    {estimate.combinedScore >= 0 ? "+" : ""}{estimate.combinedScore.toFixed(2)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground pt-1">
                  <Hint text={INDICATOR_HINTS.signal} className={HINT_TEXT}>Signal</Hint>:{" "}
                  <span className="font-medium text-foreground">{estimate.signal.replace("_", " ")}</span>
                  {estimate.quantScore == null && " (sentiment only — no price data)"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ETF profile */}
      {etf && (etfHoldings.length > 0 || etfSectors.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">ETF Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              {etf.expenseRatio != null && (
                <EtfStat label="Expense ratio" value={`${asPct(etf.expenseRatio).toFixed(2)}%`} hint={ETF_HINTS.expenseRatio} />
              )}
              {etf.dividendYield != null && (
                <EtfStat label="Dividend yield" value={`${asPct(etf.dividendYield).toFixed(2)}%`} hint={ETF_HINTS.dividendYield} />
              )}
              {etf.netAssets != null && (
                <EtfStat label="Net assets" value={formatLargeUsd(etf.netAssets)} hint={ETF_HINTS.netAssets} />
              )}
            </div>

            {etfHoldings.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Top holdings</p>
                <div className="space-y-1.5">
                  {etfHoldings.slice(0, 10).map((h) => (
                    <div key={h.symbol} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 font-semibold">{h.symbol}</span>
                      <span className="flex-1 truncate text-muted-foreground" title={h.description}>
                        {h.description}
                      </span>
                      <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(asPct(h.weight), 100)}%` }} />
                      </div>
                      <span className="w-12 text-right tabular-nums shrink-0">{asPct(h.weight).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {etfSectors.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Sector weights</p>
                <div className="flex flex-wrap gap-1.5">
                  {etfSectors
                    .slice()
                    .sort((a, b) => b.weight - a.weight)
                    .slice(0, 6)
                    .map((s) => (
                      <Badge key={s.sector} variant="outline" className="text-xs font-normal">
                        {s.sector} <span className="ml-1 tabular-nums text-muted-foreground">{asPct(s.weight).toFixed(0)}%</span>
                      </Badge>
                    ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sentiment summary */}
      {latest?.summary && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">Latest summary</CardTitle>
              {latest.confidence != null && (
                <Hint text={INDICATOR_HINTS.confidence}>
                  <Badge variant="outline" className="text-xs shrink-0 cursor-help">
                    {Math.round(latest.confidence * 100)}% confidence
                  </Badge>
                </Hint>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">{latest.summary}</p>
            {latest.keyDriver && (
              <p className="text-xs text-muted-foreground">
                <Hint text={INDICATOR_HINTS.keyDriver} className={cn(HINT_TEXT, "font-medium text-foreground")}>
                  Key driver
                </Hint>
                : {latest.keyDriver}
              </p>
            )}
            {latestAspects.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <Hint text={INDICATOR_HINTS.aspects} className={cn(HINT_TEXT, "text-xs font-medium text-muted-foreground")}>
                  Sentiment by aspect
                </Hint>
                {latestAspects.map(([key, a]) => (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground w-32 shrink-0 capitalize">
                      {key.replace(/_/g, " ")}
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${a.score >= 0 ? "bg-green-500" : "bg-red-500"}`}
                        style={{ width: `${Math.round(Math.abs(a.score) * 100)}%` }}
                      />
                    </div>
                    <span className={`tabular-nums w-10 text-right ${a.score >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                      {a.score >= 0 ? "+" : ""}{a.score.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
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

      {/* Congress activity — hidden unless this ticker has disclosed trades */}
      {stock.congressTrades.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">Congress activity</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {stock.congressTrades.length} disclosure{stock.congressTrades.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              US lawmakers&apos; reported trades in {stock.ticker} (STOCK Act)
            </p>
          </CardHeader>
          <CardContent>
            <CongressTradeList
              trades={stock.congressTrades.map((t) => ({
                id: t.id,
                politician: t.politician,
                party: t.party,
                state: t.state,
                txnType: t.txnType,
                amountRange: t.amountRange,
                transactionDate: t.transactionDate.toISOString(),
                disclosureDate: t.disclosureDate.toISOString(),
                ptrLink: t.ptrLink,
              }))}
            />
          </CardContent>
        </Card>
      )}

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
                      href={safeExternalHref(article.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-sm leading-snug hover:underline"
                    >
                      {article.headline}
                    </a>
                    <div className="self-start">
                      {/* Use per-article sentimentScore when available, fall back to stock-level score */}
                      <ArticleSentimentBadge score={article.sentimentScore ?? latest?.score} />
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

function ArticleSentimentBadge({ score }: { score?: number | null }) {
  if (score == null) return null;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 shrink-0 text-xs"><TrendingUp className="h-3 w-3 mr-1" />Bullish</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 shrink-0 text-xs"><TrendingDown className="h-3 w-3 mr-1" />Bearish</Badge>;
  return <Badge variant="secondary" className="shrink-0 text-xs"><Minus className="h-3 w-3 mr-1" />Neutral</Badge>;
}

function QuantStat({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-bold tabular-nums mt-0.5 ${
          positive === true
            ? "text-green-600 dark:text-green-400"
            : positive === false
            ? "text-red-500 dark:text-red-400"
            : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
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

// Alpha Vantage returns weights/ratios as fractions (0–1); some fields arrive
// already as percentages. Normalize defensively to a percentage number.
function asPct(value: number): number {
  return value <= 1 ? value * 100 : value;
}

function formatLargeUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toLocaleString()}`;
}

function EtfStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      {hint ? (
        <Hint text={hint} className={cn(HINT_TEXT, "text-xs text-muted-foreground")}>
          {label}
        </Hint>
      ) : (
        <p className="text-xs text-muted-foreground">{label}</p>
      )}
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
