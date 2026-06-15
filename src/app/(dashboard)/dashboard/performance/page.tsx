import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import { formatDistanceToNow } from "@/lib/format-date";
import { SIM_STARTING_EQUITY, STRATEGIES, STRATEGY_BOOK, type Strategy } from "@/lib/paper-trading";
import { PerformanceEquityChart } from "@/components/performance-equity-chart";
import { BOOK_META, type BookKey, type EquityPoint } from "@/lib/performance-books";

export const metadata = { title: "Signal Performance — TraderNews" };

const STRATEGY_LABEL: Record<Strategy, string> = {
  COMBINED: "Combined estimate",
  SENTIMENT: "Sentiment only",
  QUANT: "Quant only",
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
  // these books span the whole watched universe.
  const [snapshots, closedPositions, openPositions, recentOrders] = await Promise.all([
    db.paperEquitySnapshot.findMany({ orderBy: { date: "asc" } }),
    db.simPosition.findMany({ where: { status: "CLOSED" }, select: { strategy: true, realizedPnl: true } }),
    db.simPosition.findMany({
      where: { status: "OPEN" },
      select: {
        strategy: true,
        qty: true,
        entryPrice: true,
        lastMarkPrice: true,
        entryDate: true,
        stock: { select: { ticker: true } },
      },
    }),
    db.paperOrder.findMany({
      orderBy: { submittedAt: "desc" },
      take: 12,
      include: { stock: { select: { ticker: true } } },
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

  // Hit-rate + realized P&L per strategy from closed positions.
  const statsByStrategy = new Map<Strategy, { closed: number; wins: number; realized: number }>();
  for (const strat of STRATEGIES) statsByStrategy.set(strat, { closed: 0, wins: 0, realized: 0 });
  for (const p of closedPositions) {
    const st = statsByStrategy.get(p.strategy as Strategy);
    if (!st) continue;
    st.closed++;
    st.realized += p.realizedPnl ?? 0;
    if ((p.realizedPnl ?? 0) > 0) st.wins++;
  }
  const openCountByStrategy = new Map<Strategy, number>();
  for (const strat of STRATEGIES) openCountByStrategy.set(strat, 0);
  for (const p of openPositions) {
    openCountByStrategy.set(p.strategy as Strategy, (openCountByStrategy.get(p.strategy as Strategy) ?? 0) + 1);
  }

  const cards = orderedBooks.map((key) => {
    const meta = BOOK_META.find((b) => b.key === key)!;
    const latest = latestByBook.get(key)!;
    const isSim = key !== "ALPACA";
    const baseline = isSim ? SIM_STARTING_EQUITY : (snapshots.find((s) => s.book === key)?.equity ?? null);
    const returnPct = baseline && baseline !== 0 ? (latest.equity / baseline - 1) * 100 : null;
    return { key, meta, latest, returnPct };
  });

  const alpacaConfigured = booksPresent.has("ALPACA");

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
                {fmtPct(returnPct)} return
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
            <p className="text-sm font-medium">Equity curves</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Hypothetical equity of each signal source, sized by estimate confidence. Sim books start from{" "}
              {fmtUsd(SIM_STARTING_EQUITY)}.
            </p>
          </div>
          <PerformanceEquityChart data={chartData} books={orderedBooks} />
        </CardContent>
      </Card>

      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm font-medium mb-3">Hit rate by signal source</p>
          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs text-muted-foreground px-2">
              <span className="col-span-5">Signal source</span>
              <span className="col-span-2 text-right">Closed</span>
              <span className="col-span-2 text-right">Open</span>
              <span className="col-span-1 text-right">Win</span>
              <span className="col-span-2 text-right">Realized</span>
            </div>
            {STRATEGIES.map((strat) => {
              const st = statsByStrategy.get(strat)!;
              const hitRate = st.closed > 0 ? (st.wins / st.closed) * 100 : null;
              return (
                <div
                  key={strat}
                  className="grid grid-cols-12 items-center text-sm px-2 py-2 rounded-lg odd:bg-muted/40"
                >
                  <span className="col-span-5 flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: BOOK_META.find((b) => b.key === STRATEGY_BOOK[strat])!.color }}
                    />
                    {STRATEGY_LABEL[strat]}
                  </span>
                  <span className="col-span-2 text-right tabular-nums text-muted-foreground">{st.closed}</span>
                  <span className="col-span-2 text-right tabular-nums text-muted-foreground">
                    {openCountByStrategy.get(strat) ?? 0}
                  </span>
                  <span className="col-span-1 text-right tabular-nums font-medium">
                    {hitRate == null ? "—" : `${hitRate.toFixed(0)}%`}
                  </span>
                  <span
                    className={`col-span-2 text-right tabular-nums font-medium ${
                      st.realized > 0 ? "text-emerald-600" : st.realized < 0 ? "text-rose-600" : "text-muted-foreground"
                    }`}
                  >
                    {fmtUsd(st.realized)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Win rate is the share of closed positions that were profitable. Realized excludes open positions, which
            are still marked-to-market in the equity curve above.
          </p>
        </CardContent>
      </Card>

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
                        <Link href={`/dashboard/stocks/${p.stock.ticker}`} className="font-medium hover:underline">
                          {p.stock.ticker}
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
              <p className="text-sm font-medium">Recent paper orders</p>
              {!alpacaConfigured && (
                <span className="text-xs text-muted-foreground">Alpaca not configured</span>
              )}
            </div>
            {recentOrders.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No live orders yet — the combined book places real paper orders once Alpaca paper keys are set.
              </p>
            ) : (
              <div className="space-y-1.5">
                {recentOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between text-xs gap-2">
                    <Link href={`/dashboard/stocks/${o.stock.ticker}`} className="font-medium hover:underline">
                      {o.stock.ticker}
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
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Signal Performance</h1>
      <p className="text-muted-foreground text-sm mt-1">
        How predictive are our signals? Each book trades the app&apos;s own daily signals — sentiment, quant, and
        the combined estimate — long-only and confidence-weighted, so the equity curves show which source picks
        best.
      </p>
    </div>
  );
}
