import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import {
  isPaperTradingConfigured,
  getAccountSummary,
  getPortfolioPositions,
  getPortfolioHistory,
  getClock,
  type AlpacaAccountSummary,
  type AlpacaPortfolioPosition,
  type AlpacaEquityPoint,
} from "@/lib/alpaca-trading";
import { PortfolioValueChart } from "@/components/portfolio-value-chart";
import { cn } from "@/lib/utils";

export const metadata = { title: "Portfolio — TraderNews" };
export const dynamic = "force-dynamic";

// Chart range toggles → Alpaca portfolio-history `period`. All use a 1-day
// timeframe so the curve stays consistent across ranges (and avoids Alpaca's
// "intraday timeframe ⇒ period ≤ 30d" restriction). "1A" is Alpaca's one-year code.
const RANGES = [
  { key: "1W", label: "1W", period: "1W" },
  { key: "1M", label: "1M", period: "1M" },
  { key: "3M", label: "3M", period: "3M" },
  { key: "1Y", label: "1Y", period: "1A" },
  { key: "ALL", label: "All", period: "all" },
] as const;
const DEFAULT_RANGE = "1M";

function resolveRange(raw: string | string[] | undefined): (typeof RANGES)[number] {
  return RANGES.find((r) => r.key === raw) ?? RANGES.find((r) => r.key === DEFAULT_RANGE)!;
}

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedUsd(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `frac` is a ratio (0.05 → +5.00%). */
function fmtPct(frac: number | null): string {
  if (frac == null) return "—";
  return `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(2)}%`;
}

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

function toneClass(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : "text-rose-600";
}

function PageHeader({ marketOpen }: { marketOpen: boolean | null }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your live Alpaca paper account — current holdings and account value, valued at the latest prices.
        </p>
      </div>
      {marketOpen != null && (
        <Badge variant="outline" className="shrink-0 gap-1.5 font-normal text-muted-foreground bg-muted/30">
          <span className={`inline-block h-2 w-2 rounded-full ${marketOpen ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
          {marketOpen ? "Market open" : "Market closed"}
        </Badge>
      )}
    </div>
  );
}

// Segmented control of links — server-rendered, drives the chart range via the
// `?range=` searchParam (soft nav re-renders the page with the new window).
function RangeToggle({ active }: { active: string }) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border bg-muted/30 p-0.5 text-xs">
      {RANGES.map((r) => (
        <Link
          key={r.key}
          href={`/dashboard/portfolio?range=${r.key}`}
          scroll={false}
          aria-current={r.key === active ? "true" : undefined}
          className={cn(
            "px-2.5 py-1 rounded-md font-medium transition-colors",
            r.key === active
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="py-16 text-center">
        <p className="text-4xl mb-3">💼</p>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground text-sm mt-1 max-w-md mx-auto">{body}</p>
      </CardContent>
    </Card>
  );
}

export default async function PortfolioPage({ searchParams }: PageProps<"/dashboard/portfolio">) {
  const user = await getOrCreateUser();
  // The Alpaca paper account is a single app-level book (not per-user), so this is
  // an operator view — gated like /dashboard/performance.
  if (!isAdmin(user)) notFound();

  const range = resolveRange((await searchParams).range);

  if (!isPaperTradingConfigured()) {
    return (
      <div className="space-y-6">
        <PageHeader marketOpen={null} />
        <EmptyState
          title="Alpaca paper account not configured"
          body="Set ALPACA_PAPER_API_KEY_ID and ALPACA_PAPER_API_SECRET_KEY to connect the paper account and see live holdings here."
        />
      </div>
    );
  }

  let account: AlpacaAccountSummary | null = null;
  let positions: AlpacaPortfolioPosition[] = [];
  let history: { points: AlpacaEquityPoint[]; baseValue: number | null } = { points: [], baseValue: null };
  let failed = false;
  try {
    [account, positions, history] = await Promise.all([
      getAccountSummary(),
      getPortfolioPositions(),
      getPortfolioHistory(range.period),
    ]);
  } catch {
    failed = true;
  }
  // Market clock is non-essential; never let it sink the page.
  let marketOpen: boolean | null = null;
  try {
    marketOpen = (await getClock()).isOpen;
  } catch {
    // leave null
  }

  if (failed || !account) {
    return (
      <div className="space-y-6">
        <PageHeader marketOpen={marketOpen} />
        <EmptyState
          title="Couldn’t reach Alpaca"
          body="The paper account is configured but didn’t respond just now. Refresh in a moment — this view reads live data on each load."
        />
      </div>
    );
  }

  const todayChange =
    account.equity != null && account.lastEquity != null ? account.equity - account.lastEquity : null;
  const todayPct =
    todayChange != null && account.lastEquity ? account.equity! / account.lastEquity - 1 : null;
  const totalUnrealized = positions.reduce((s, p) => s + (p.unrealizedPl ?? 0), 0);
  const sorted = [...positions].sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));

  return (
    <div className="space-y-6">
      <PageHeader marketOpen={marketOpen} />

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium">Portfolio value</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{fmtUsd(account.equity)}</p>
            <p className="text-xs text-muted-foreground mt-1">{fmtUsd(account.cash)} cash</p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium">Today</p>
            <p className={`text-2xl font-bold tabular-nums mt-1 ${toneClass(todayChange)}`}>{fmtSignedUsd(todayChange)}</p>
            <p className={`text-xs mt-1 tabular-nums ${toneClass(todayChange)}`}>{fmtPct(todayPct)} vs last close</p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium">Unrealized P&amp;L</p>
            <p className={`text-2xl font-bold tabular-nums mt-1 ${toneClass(totalUnrealized)}`}>{fmtSignedUsd(totalUnrealized)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              across {positions.length} {positions.length === 1 ? "position" : "positions"}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium">Buying power</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{fmtUsd(account.buyingPower)}</p>
            <p className="text-xs text-muted-foreground mt-1">{fmtUsd(account.longMarketValue)} in positions</p>
          </CardContent>
        </Card>
      </div>

      {/* Account value over time */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Account value</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Account value over time, priced by Alpaca from real market data. The dashed line is the starting value.
              </p>
            </div>
            <RangeToggle active={range.key} />
          </div>
          <PortfolioValueChart data={history.points} baseValue={history.baseValue} />
        </CardContent>
      </Card>

      {/* Holdings */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm font-medium mb-3">Holdings</p>
          {sorted.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              No open positions — the combined book opens positions as its signals turn BUY.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-separate border-spacing-y-1">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left font-medium px-2">Symbol</th>
                    <th className="text-right font-medium px-2">Qty</th>
                    <th className="text-right font-medium px-2 hidden sm:table-cell">Avg cost</th>
                    <th className="text-right font-medium px-2">Price</th>
                    <th className="text-right font-medium px-2">Mkt value</th>
                    <th className="text-right font-medium px-2">Unrealized P&amp;L</th>
                    <th className="text-right font-medium px-2 hidden sm:table-cell">Today</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => (
                    <tr key={p.symbol} className="odd:bg-muted/40">
                      <td className="px-2 py-2 rounded-l-lg">
                        <Link href={`/dashboard/stocks/${p.symbol}`} className="font-semibold hover:underline">
                          {p.symbol}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtQty(p.qty)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                        {fmtUsd(p.avgEntryPrice)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtUsd(p.currentPrice)}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">{fmtUsd(p.marketValue)}</td>
                      <td className={`px-2 py-2 text-right tabular-nums font-medium ${toneClass(p.unrealizedPl)}`}>
                        {fmtSignedUsd(p.unrealizedPl)}
                        <span className="block text-xs font-normal">{fmtPct(p.unrealizedPlpc)}</span>
                      </td>
                      <td className={`px-2 py-2 text-right tabular-nums rounded-r-lg hidden sm:table-cell ${toneClass(p.changeToday)}`}>
                        {fmtPct(p.changeToday)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
