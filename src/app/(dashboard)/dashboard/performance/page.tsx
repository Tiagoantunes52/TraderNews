import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import { formatDistanceToNow } from "@/lib/format-date";
import { SIM_STARTING_EQUITY, ALL_STRATEGIES, STRATEGY_BOOK, realizedFromFills, type Strategy, type ClosedTrade } from "@/lib/paper-trading";
import { isPaperTradingConfigured, getAccountActivities } from "@/lib/alpaca-trading";
import { PerformanceEquityChart } from "@/components/lazy-charts";
import { RefreshCountdown } from "@/components/refresh-countdown";
import { Hint, HINT_TEXT } from "@/components/hint";
import { BOOK_META, type BookKey, type EquityPoint } from "@/lib/performance-books";

// Plain-language glosses for the denser performance terms.
const PERF_HINTS = {
  book:
    "A self-contained simulated portfolio for one signal source. Each book starts from the same cash, sizes positions by the estimate's confidence, and is marked to market at each daily close — so the equity curves are directly comparable. '_RM' books add a price-aware risk overlay (stop-loss, trailing stop, time-stop).",
  equityCurve:
    "Each book's total account value over time. A rising curve means that signal's picks made money.",
  closed:
    "Positions that have been fully exited. Their profit/loss is locked in (realized).",
  open:
    "Positions still held. Their gain/loss is on paper (unrealized) and moves with the price until exit.",
  win:
    "Win rate — the share of closed positions that ended profitable.",
  realized:
    "Total profit/loss locked in from closed positions only; still-open positions aren't counted.",
  unrealized:
    "Paper profit/loss on still-open positions at the latest mark. This is the bridge to the cards: card equity = starting cash + realized + unrealized.",
  returnPct:
    "Change in the book's equity since it started, as a %.",
} as const;

export const metadata = { title: "Signal Performance — TraderNews" };

const STRATEGY_LABEL: Record<Strategy, string> = {
  COMBINED: "Combined estimate",
  SENTIMENT: "Sentiment only",
  QUANT: "Quant only",
  COMBINED_RM: "Combined (risk-managed)",
  SENTIMENT_RM: "Sentiment (risk-managed)",
  QUANT_RM: "Quant (risk-managed)",
  INSIDER: "Insider events",
};

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export default async function PerformancePage() {
  const user = await getOrCreateUser();
  // Operator-only: a single shared Alpaca paper account backs the combined book, so
  // this is an admin view, gated like /dashboard/admin.
  if (!isAdmin(user)) notFound();

  // Signal performance is a global property of the app's signals (not per-user), so
  // these books span the whole watched universe. Chart history is capped to a year
  // so the page doesn't grow unbounded; closed-position stats come from DB aggregates.
  // eslint-disable-next-line react-hooks/purity -- server component, fresh render per request
  const chartSince = new Date(Date.now() - 365 * 86_400_000);
  const [snapshots, firstAlpacaSnap, closedByStrategy, winsByStrategy, recentClosed, openPositions, recentOrders] = await Promise.all([
    db.paperEquitySnapshot.findMany({ where: { date: { gte: chartSince } }, orderBy: { date: "asc" } }),
    // The Alpaca card's return baseline is its first-ever snapshot, which the
    // capped chart window above may not include.
    db.paperEquitySnapshot.findFirst({ where: { book: "ALPACA" }, orderBy: { date: "asc" }, select: { equity: true } }),
    db.simPosition.groupBy({
      by: ["strategy"],
      where: { status: "CLOSED" },
      _count: { _all: true },
      _sum: { realizedPnl: true },
    }),
    db.simPosition.groupBy({
      by: ["strategy"],
      where: { status: "CLOSED", realizedPnl: { gt: 0 } },
      _count: { _all: true },
    }),
    db.simPosition.findMany({
      where: { status: "CLOSED" },
      orderBy: { exitDate: "desc" },
      take: 12,
      select: {
        strategy: true,
        qty: true,
        entryPrice: true,
        exitPrice: true,
        exitDate: true,
        realizedPnl: true,
        stock: { select: { ticker: true, name: true } },
      },
    }),
    db.simPosition.findMany({
      where: { status: "OPEN" },
      select: {
        strategy: true,
        qty: true,
        entryPrice: true,
        lastMarkPrice: true,
        entryDate: true,
        stock: { select: { ticker: true, name: true } },
      },
    }),
    db.paperOrder.findMany({
      orderBy: { submittedAt: "desc" },
      take: 12,
      include: { stock: { select: { ticker: true, name: true } } },
    }),
  ]);

  if (snapshots.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">📈</p>
            <p className="font-medium">No performance data yet</p>
            <p className="text-muted-foreground text-sm mt-1 max-w-md mx-auto">
              The performance stage simulates trades on the app&apos;s own daily signals and records one equity
              point per book per day. Once a US-listed watchlist stock turns BUY and the pipeline runs, books
              start here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Pivot snapshots → one chart row per date, each book as a series.
  const byDate = new Map<string, EquityPoint>();
  const booksPresent = new Set<BookKey>();
  for (const s of snapshots) {
    const day = s.date.toISOString().slice(0, 10);
    const row = byDate.get(day) ?? { date: day };
    (row as Record<string, number | string>)[s.book] = s.equity;
    byDate.set(day, row);
    booksPresent.add(s.book as BookKey);
  }
  const chartData = [...byDate.values()];
  const orderedBooks = BOOK_META.map((b) => b.key).filter((k) => booksPresent.has(k));

  // Latest snapshot per book for the summary cards.
  const latestByBook = new Map<BookKey, (typeof snapshots)[number]>();
  for (const s of snapshots) latestByBook.set(s.book as BookKey, s); // ascending → last wins

  // Hit-rate + realized P&L per strategy from the closed-position aggregates.
  const statsByStrategy = new Map<Strategy, { closed: number; wins: number; realized: number }>();
  for (const strat of ALL_STRATEGIES) statsByStrategy.set(strat, { closed: 0, wins: 0, realized: 0 });
  for (const row of closedByStrategy) {
    const st = statsByStrategy.get(row.strategy as Strategy);
    if (!st) continue;
    st.closed = row._count._all;
    st.realized = row._sum.realizedPnl ?? 0;
  }
  for (const row of winsByStrategy) {
    const st = statsByStrategy.get(row.strategy as Strategy);
    if (st) st.wins = row._count._all;
  }
  const openCountByStrategy = new Map<Strategy, number>();
  const unrealizedByStrategy = new Map<Strategy, number>();
  for (const strat of ALL_STRATEGIES) {
    openCountByStrategy.set(strat, 0);
    unrealizedByStrategy.set(strat, 0);
  }
  for (const p of openPositions) {
    const strat = p.strategy as Strategy;
    openCountByStrategy.set(strat, (openCountByStrategy.get(strat) ?? 0) + 1);
    const mark = p.lastMarkPrice ?? p.entryPrice;
    unrealizedByStrategy.set(strat, (unrealizedByStrategy.get(strat) ?? 0) + p.qty * (mark - p.entryPrice));
  }
  // Total realized P&L across every closed sim position (all books).
  const totalRealized = closedByStrategy.reduce((s, row) => s + (row._sum.realizedPnl ?? 0), 0);
  // Only rate strategies whose book has data — keeps the risk-managed rows hidden
  // until PAPER_RISK_BOOKS=1 has produced snapshots for them.
  const ratedStrategies = ALL_STRATEGIES.filter((s) => booksPresent.has(STRATEGY_BOOK[s]));

  const cards = orderedBooks.map((key) => {
    const meta = BOOK_META.find((b) => b.key === key)!;
    const latest = latestByBook.get(key)!;
    const isSim = key !== "ALPACA";
    const baseline = isSim ? SIM_STARTING_EQUITY : (firstAlpacaSnap?.equity ?? null);
    const returnPct = baseline && baseline !== 0 ? (latest.equity / baseline - 1) * 100 : null;
    return { key, meta, latest, returnPct };
  });

  const alpacaConfigured = isPaperTradingConfigured();

  // Realized P&L for the live Alpaca book, reconstructed from its fill history
  // (Alpaca has no closed-position endpoint). Best-effort: degrade to empty if the
  // account is unreachable so the rest of the page still renders.
  let alpacaClosed: { trades: ClosedTrade[]; totalRealized: number } = { trades: [], totalRealized: 0 };
  if (alpacaConfigured) {
    try {
      alpacaClosed = realizedFromFills(await getAccountActivities());
    } catch {
      // leave empty
    }
  }

  // Alpaca fills only carry tickers — look up names for the closed-trade list.
  const alpacaSymbols = [...new Set(alpacaClosed.trades.map((t) => t.symbol))];
  const alpacaNames = new Map<string, string>(
    alpacaSymbols.length > 0
      ? (
          await db.stock.findMany({ where: { ticker: { in: alpacaSymbols } }, select: { ticker: true, name: true } })
        ).map((s) => [s.ticker, s.name])
      : []
  );

  // Unified per-book performance rows: each simulated signal source + the live Alpaca book.
  type BookRow = { key: string; label: string; color: string; closed: number; open: number; wins: number; realized: number; unrealized: number };
  const bookRows: BookRow[] = ratedStrategies.map((strat) => {
    const st = statsByStrategy.get(strat)!;
    return {
      key: strat,
      label: STRATEGY_LABEL[strat],
      color: BOOK_META.find((b) => b.key === STRATEGY_BOOK[strat])!.color,
      closed: st.closed,
      open: openCountByStrategy.get(strat) ?? 0,
      wins: st.wins,
      realized: st.realized,
      unrealized: unrealizedByStrategy.get(strat) ?? 0,
    };
  });
  if (alpacaConfigured && (booksPresent.has("ALPACA") || alpacaClosed.trades.length > 0)) {
    const meta = BOOK_META.find((b) => b.key === "ALPACA")!;
    bookRows.push({
      key: "ALPACA",
      label: meta.label,
      color: meta.color,
      closed: alpacaClosed.trades.length,
      open: latestByBook.get("ALPACA")?.openPositions ?? 0,
      wins: alpacaClosed.trades.filter((t) => t.realizedPnl > 0).length,
      realized: alpacaClosed.totalRealized,
      unrealized: latestByBook.get("ALPACA")?.unrealizedPnl ?? 0,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ key, meta, latest, returnPct }) => (
          <Card key={key} className="rounded-2xl">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                <p className="text-sm font-medium">{meta.label}</p>
              </div>
              <p className="text-2xl font-bold tabular-nums mt-2">{fmtUsd(latest.equity)}</p>
              <p
                className={`text-sm font-medium tabular-nums ${
                  returnPct == null ? "text-muted-foreground" : returnPct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                {fmtPct(returnPct)} <Hint text={PERF_HINTS.returnPct} className={HINT_TEXT}>return</Hint>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {latest.openPositions} open · updated {formatDistanceToNow(latest.date)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <div className="mb-3">
            <p className="text-sm font-medium">
              <Hint text={PERF_HINTS.equityCurve} className={HINT_TEXT}>Equity curves</Hint>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each book&apos;s equity over time — the simulated signal books (sized by estimate confidence, starting
              from {fmtUsd(SIM_STARTING_EQUITY)}) and the live Alpaca paper account.
            </p>
          </div>
          <PerformanceEquityChart data={chartData} books={orderedBooks} />
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm font-medium mb-1">Hit rate &amp; P&amp;L by book</p>
          <p className="text-xs text-muted-foreground mb-3">
            Each signal source runs as its own simulated book; the live Alpaca paper account mirrors the combined
            signal with real orders. Win rate is the share of closed positions that were profitable. Realized +
            unrealized together explain the equity cards above: card equity = starting cash + realized + unrealized.
          </p>
          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs text-muted-foreground px-2">
              <span className="col-span-4"><Hint text={PERF_HINTS.book} className={HINT_TEXT}>Book</Hint></span>
              <span className="col-span-1 text-right"><Hint text={PERF_HINTS.closed} className={HINT_TEXT}>Closed</Hint></span>
              <span className="col-span-1 text-right"><Hint text={PERF_HINTS.open} className={HINT_TEXT}>Open</Hint></span>
              <span className="col-span-2 text-right"><Hint text={PERF_HINTS.win} className={HINT_TEXT}>Win</Hint></span>
              <span className="col-span-2 text-right"><Hint text={PERF_HINTS.realized} className={HINT_TEXT}>Realized</Hint></span>
              <span className="col-span-2 text-right"><Hint text={PERF_HINTS.unrealized} className={HINT_TEXT}>Unrealized</Hint></span>
            </div>
            {bookRows.map((row) => {
              const hitRate = row.closed > 0 ? (row.wins / row.closed) * 100 : null;
              return (
                <div key={row.key} className="grid grid-cols-12 items-center text-sm px-2 py-2 rounded-lg odd:bg-muted/40">
                  <span className="col-span-4 flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: row.color }} />
                    {row.label}
                  </span>
                  <span className="col-span-1 text-right tabular-nums text-muted-foreground">{row.closed}</span>
                  <span className="col-span-1 text-right tabular-nums text-muted-foreground">{row.open}</span>
                  <span className="col-span-2 text-right tabular-nums font-medium">
                    {hitRate == null ? "—" : `${hitRate.toFixed(0)}%`}
                  </span>
                  <span
                    className={`col-span-2 text-right tabular-nums font-medium ${
                      row.realized > 0 ? "text-emerald-600" : row.realized < 0 ? "text-rose-600" : "text-muted-foreground"
                    }`}
                  >
                    {fmtUsd(row.realized)}
                  </span>
                  <span
                    className={`col-span-2 text-right tabular-nums ${
                      row.unrealized > 0 ? "text-emerald-600/80" : row.unrealized < 0 ? "text-rose-600/80" : "text-muted-foreground"
                    }`}
                  >
                    {fmtUsd(row.unrealized)}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <SectionHeading
        title="Simulated signal books"
        desc="DB-only, marked-to-market against the daily close. These isolate which signal source predicts best — no real money or orders."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <p className="text-sm font-medium mb-3">Open positions</p>
            {openPositions.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No open positions.</p>
            ) : (
              <div className="space-y-1.5">
                {openPositions
                  .slice()
                  .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime())
                  .slice(0, 10)
                  .map((p, i) => {
                    const mark = p.lastMarkPrice ?? p.entryPrice;
                    const upnl = p.qty * (mark - p.entryPrice);
                    return (
                      <div key={i} className="flex items-center justify-between text-xs gap-2">
                        <Link
                          href={`/dashboard/stocks/${p.stock.ticker}`}
                          title={p.stock.ticker}
                          className="font-medium hover:underline truncate min-w-0"
                        >
                          {p.stock.name}
                        </Link>
                        <span className="flex items-center gap-2 shrink-0">
                          <Badge variant="outline" className="font-normal">
                            {STRATEGY_LABEL[p.strategy as Strategy]}
                          </Badge>
                          <span className={`tabular-nums ${upnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {fmtUsd(upnl)}
                          </span>
                          <span className="text-muted-foreground/70">{formatDistanceToNow(p.entryDate)}</span>
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">Closed positions</p>
              <span
                className={`text-xs font-medium tabular-nums ${
                  totalRealized > 0 ? "text-emerald-600" : totalRealized < 0 ? "text-rose-600" : "text-muted-foreground"
                }`}
              >
                {fmtUsd(totalRealized)} realized
              </span>
            </div>
            {recentClosed.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No closed positions yet.</p>
            ) : (
              <div className="space-y-1.5">
                {recentClosed.map((p, i) => {
                  const pnl = p.realizedPnl ?? 0;
                  const cost = p.qty * p.entryPrice;
                  const retPct = cost !== 0 ? (pnl / cost) * 100 : null;
                  return (
                    <div key={i} className="flex items-center justify-between text-xs gap-2">
                      <Link
                        href={`/dashboard/stocks/${p.stock.ticker}`}
                        title={p.stock.ticker}
                        className="font-medium hover:underline truncate min-w-0"
                      >
                        {p.stock.name}
                      </Link>
                      <span className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="font-normal">
                          {STRATEGY_LABEL[p.strategy as Strategy]}
                        </Badge>
                        <span className={`tabular-nums font-medium ${pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {fmtUsd(pnl)}
                        </span>
                        {retPct != null && (
                          <span className={`tabular-nums ${pnl >= 0 ? "text-emerald-600/80" : "text-rose-600/80"}`}>
                            {fmtPct(retPct)}
                          </span>
                        )}
                        {p.exitDate && <span className="text-muted-foreground/70">{formatDistanceToNow(p.exitDate)}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <SectionHeading
        title="Live paper account (Alpaca)"
        desc="Real orders on a single shared Alpaca paper account, mirroring the combined signal. Realized P&amp;L is reconstructed from the account's fills."
      />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">Recent paper orders</p>
              {!alpacaConfigured && <span className="text-xs text-muted-foreground">Alpaca not configured</span>}
            </div>
            {recentOrders.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No live orders yet — the combined book places real paper orders once Alpaca paper keys are set.
              </p>
            ) : (
              <div className="space-y-1.5">
                {recentOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between text-xs gap-2">
                    <Link
                      href={`/dashboard/stocks/${o.stock.ticker}`}
                      title={o.stock.ticker}
                      className="font-medium hover:underline truncate min-w-0"
                    >
                      {o.stock.name}
                    </Link>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className={`font-medium ${o.side === "BUY" ? "text-emerald-600" : "text-rose-600"}`}>
                        {o.side}
                      </span>
                      {o.notional != null && <span className="tabular-nums text-muted-foreground">{fmtUsd(o.notional)}</span>}
                      <Badge variant="outline" className="font-normal">
                        {o.status}
                      </Badge>
                      <span className="text-muted-foreground/70">{formatDistanceToNow(o.submittedAt)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">Closed Alpaca trades</p>
              {alpacaClosed.trades.length > 0 && (
                <span
                  className={`text-xs font-medium tabular-nums ${
                    alpacaClosed.totalRealized > 0
                      ? "text-emerald-600"
                      : alpacaClosed.totalRealized < 0
                        ? "text-rose-600"
                        : "text-muted-foreground"
                  }`}
                >
                  {fmtUsd(alpacaClosed.totalRealized)} realized
                </span>
              )}
            </div>
            {!alpacaConfigured ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Alpaca not configured.</p>
            ) : alpacaClosed.trades.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No closed Alpaca trades yet.</p>
            ) : (
              <div className="space-y-1.5">
                {alpacaClosed.trades.slice(0, 12).map((t, i) => {
                  const retPct = t.entryPrice !== 0 ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 : null;
                  return (
                    <div key={i} className="flex items-center justify-between text-xs gap-2">
                      <Link
                        href={`/dashboard/stocks/${t.symbol}`}
                        title={t.symbol}
                        className="font-medium hover:underline truncate min-w-0"
                      >
                        {alpacaNames.get(t.symbol) ?? t.symbol}
                      </Link>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="tabular-nums text-muted-foreground">
                          {Number.isInteger(t.qty) ? t.qty : t.qty.toFixed(2)} sh
                        </span>
                        <span className={`tabular-nums font-medium ${t.realizedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {fmtUsd(t.realizedPnl)}
                        </span>
                        {retPct != null && (
                          <span className={`tabular-nums ${t.realizedPnl >= 0 ? "text-emerald-600/80" : "text-rose-600/80"}`}>
                            {fmtPct(retPct)}
                          </span>
                        )}
                        <span className="text-muted-foreground/70">{formatDistanceToNow(new Date(t.closedAt))}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="pt-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">{desc}</p>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">Signal Performance</h1>
        <p className="text-muted-foreground text-sm mt-1">
          How predictive are our signals? Each book trades the app&apos;s own daily signals — sentiment, quant, and
          the combined estimate — long-only and confidence-weighted, so the equity curves show which source picks
          best.
        </p>
      </div>
      <RefreshCountdown kind="marketClose" className="mt-1 shrink-0" />
    </div>
  );
}
