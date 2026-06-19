import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { isInsiderEligible } from "@/lib/insider-sources";
import { CongressTradeList, type CongressTradeView } from "@/components/congress-trade-list";
import { Hint, HINT_TEXT } from "@/components/hint";

export const metadata = { title: "Insider Trades — TraderNews" };

const TXN_LABELS: Record<string, string> = {
  OPEN_MARKET_BUY: "Bought",
  OPEN_MARKET_SELL: "Sold",
  GRANT: "Granted",
  OPTION_EXERCISE: "Exercised",
  TAX_WITHHOLDING: "Tax withheld",
  GIFT: "Gift",
  CONVERSION: "Converted",
  OTHER: "Other",
};

// What each Form 4 transaction type means and how strong a signal it is.
const TXN_HINTS: Record<string, string> = {
  OPEN_MARKET_BUY: "Insider bought shares on the open market with their own money — the strongest bullish insider signal.",
  OPEN_MARKET_SELL: "Insider sold shares on the open market. Often routine (diversification, taxes), so a weaker signal than a buy.",
  GRANT: "Shares awarded as compensation, not bought — no directional signal.",
  OPTION_EXERCISE: "Insider converted stock options into shares. Mechanical, usually not a market view.",
  TAX_WITHHOLDING: "Shares withheld to cover taxes on vesting/grants — administrative, not a sell decision.",
  GIFT: "Shares gifted away — no market view.",
  CONVERSION: "Shares converted from another security class — mechanical, no signal.",
  OTHER: "Other Form 4 transaction type.",
};

// What each detected insider signal flags. Falls back to the badge's own detail text.
const SIGNAL_HINTS: Record<string, string> = {
  CLUSTER_BUY: "Three or more different insiders bought on the open market within 14 days — clustered buying is a strong conviction signal.",
  CSUITE_BUY: "A CEO/CFO/COO bought a sizeable amount ($100k+) on the open market in the last 14 days — the highest-signal insider buy.",
  LARGE_BUY: "An insider materially grew their personal stake.",
  NET_BUYING: "Insiders bought more than they sold over the last 90 days (net dollars).",
  NET_SELLING: "Insiders sold more than they bought over the last 90 days (net dollars).",
};

const MSPR_HINT =
  "Monthly Share Purchase Ratio (Finnhub), −100 to +100. Positive means insider buying dominated recent months; negative means selling. It feeds the conviction ranking.";

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function fmtShares(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "+";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

/** Short role tag for an insider, when EDGAR role data is present (Finnhub omits it). */
function roleLabel(t: { officerTitle: string | null; isOfficer: boolean; isDirector: boolean; isTenPctOwner: boolean }): string | null {
  if (t.officerTitle) return t.officerTitle;
  if (t.isOfficer) return "Officer";
  if (t.isDirector) return "Director";
  if (t.isTenPctOwner) return "10% owner";
  return null;
}

type Signal = { type: string; detail: string; value: number | null };

function parseSignals(raw: unknown): Signal[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is Signal => !!s && typeof s === "object" && "type" in s && "detail" in s);
}

type InsiderTxnView = {
  id: string;
  insiderName: string;
  officerTitle: string | null;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPctOwner: boolean;
  txnType: string;
  shares: number;
  value: number | null;
  filingDate: string;
};

type InsiderRow = {
  id: string;
  ticker: string;
  name: string;
  eligible: boolean;
  summary: {
    convictionScore: number;
    netValue90d: number;
    buyCount90d: number;
    sellCount90d: number;
    distinctBuyers90d: number;
    distinctSellers90d: number;
    distinctBuyers14d: number;
    csuiteBuyValue14d: number;
    mspr: number | null;
    signals: Signal[];
    date: string;
  } | null;
  txns: InsiderTxnView[];
};

export default async function InsiderPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          insiderSummaries: { orderBy: { date: "desc" }, take: 1 },
          insiderTransactions: { orderBy: { filingDate: "desc" }, take: 6 },
        },
      },
    },
  });

  const rows: InsiderRow[] = userStocks.map(({ stock }) => {
    const s = stock.insiderSummaries[0];
    return {
      id: stock.id,
      ticker: stock.ticker,
      name: stock.name,
      eligible: isInsiderEligible(stock.ticker),
      summary: s
        ? {
            convictionScore: s.convictionScore,
            netValue90d: s.netValue90d,
            buyCount90d: s.buyCount90d,
            sellCount90d: s.sellCount90d,
            distinctBuyers90d: s.distinctBuyers90d,
            distinctSellers90d: s.distinctSellers90d,
            distinctBuyers14d: s.distinctBuyers14d,
            csuiteBuyValue14d: s.csuiteBuyValue14d,
            mspr: s.mspr,
            signals: parseSignals(s.signals),
            date: s.date.toISOString(),
          }
        : null,
      txns: stock.insiderTransactions.map((t) => ({
        id: t.id,
        insiderName: t.insiderName,
        officerTitle: t.officerTitle,
        isOfficer: t.isOfficer,
        isDirector: t.isDirector,
        isTenPctOwner: t.isTenPctOwner,
        txnType: t.txnType,
        shares: t.shares,
        value: t.value,
        filingDate: t.filingDate.toISOString(),
      })),
    };
  });

  const covered = rows
    .filter((r) => r.eligible)
    .sort((a, b) => (b.summary?.convictionScore ?? -2) - (a.summary?.convictionScore ?? -2));
  const uncovered = rows.filter((r) => !r.eligible);

  // Most recent congressional disclosures across the whole watchlist (any ticker,
  // incl. ETFs/class shares that insider data skips). Each row links to its stock.
  const congressTrades = await db.congressTrade.findMany({
    where: { stock: { userStocks: { some: { userId: user.id } } } },
    orderBy: { transactionDate: "desc" },
    take: 8,
    include: { stock: { select: { ticker: true } } },
  });
  const congressViews: CongressTradeView[] = congressTrades.map((t) => ({
    id: t.id,
    ticker: t.stock.ticker,
    politician: t.politician,
    party: t.party,
    state: t.state,
    txnType: t.txnType,
    amountRange: t.amountRange,
    transactionDate: t.transactionDate.toISOString(),
    disclosureDate: t.disclosureDate.toISOString(),
    ptrLink: t.ptrLink,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Insider Trades</h1>
        <p className="text-muted-foreground text-sm mt-1">
          What company insiders are doing with their own shares — buys speak louder than sells.
        </p>
      </div>

      {covered.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">🕵️</p>
            <p className="font-medium">No insider data yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add US-listed stocks to your watchlist and run the insider pipeline
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {covered.map((row) => (
            <InsiderCard key={row.id} row={row} />
          ))}
        </div>
      )}

      {congressViews.length > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="py-4 space-y-3">
            <div>
              <p className="text-sm font-medium">Congress activity</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Recent STOCK Act disclosures across your watchlist
              </p>
            </div>
            <CongressTradeList trades={congressViews} />
          </CardContent>
        </Card>
      )}

      {uncovered.length > 0 && (
        <Card className="rounded-2xl border-dashed">
          <CardContent className="py-4">
            <p className="text-sm font-medium text-muted-foreground">No insider coverage</p>
            <p className="text-xs text-muted-foreground mt-1">
              Insider (Form&nbsp;4) filings exist only for US-listed equities. These are skipped:{" "}
              {uncovered.map((r) => r.ticker).join(", ")}.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function InsiderCard({ row }: { row: InsiderRow }) {
  const s = row.summary;
  const net = s?.netValue90d ?? 0;
  const tone = !s ? "flat" : net > 0 ? "buy" : net < 0 ? "sell" : "flat";
  const gradient =
    tone === "buy"
      ? "from-emerald-500 to-green-600"
      : tone === "sell"
        ? "from-rose-500 to-red-600"
        : "from-slate-400 to-slate-500";
  const flowLabel = !s ? "No recent activity" : net > 0 ? "Net buying" : net < 0 ? "Net selling" : "Flat";

  return (
    <Card className="rounded-2xl overflow-hidden border-0 shadow-sm bg-card">
      <Link
        href={`/dashboard/stocks/${row.ticker}`}
        className={`block bg-gradient-to-r ${gradient} p-5 hover:brightness-105 transition-all`}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white/80 text-sm font-medium">{row.name}</p>
            <p className="text-white text-2xl font-bold mt-0.5">{row.ticker}</p>
          </div>
          <div className="text-right">
            <p className="text-white text-xl font-bold tabular-nums">{s ? fmtUsd(net) : "—"}</p>
            <p className="text-white/80 text-xs mt-0.5">{flowLabel}</p>
          </div>
        </div>
      </Link>

      <CardContent className="p-4 space-y-3">
        {s ? (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">
                {s.distinctBuyers90d} buyer{s.distinctBuyers90d === 1 ? "" : "s"} · {s.buyCount90d} buys
              </Badge>
              <Badge variant="outline">
                {s.distinctSellers90d} seller{s.distinctSellers90d === 1 ? "" : "s"} · {s.sellCount90d} sells
              </Badge>
              {s.mspr != null && (
                <Hint text={MSPR_HINT}>
                  <Badge variant="outline" className="cursor-help">MSPR {s.mspr.toFixed(0)}</Badge>
                </Hint>
              )}
            </div>

            {s.signals.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {s.signals.map((sig, i) => (
                  <Hint key={i} text={SIGNAL_HINTS[sig.type] ?? sig.detail}>
                    <Badge
                      className={`cursor-help ${
                        sig.type === "CSUITE_BUY"
                          ? "bg-emerald-600 text-white hover:bg-emerald-600"
                          : sig.type === "CLUSTER_BUY" || sig.type === "LARGE_BUY" || sig.type === "NET_BUYING"
                            ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
                            : sig.type === "NET_SELLING"
                              ? "bg-rose-100 text-rose-800 hover:bg-rose-100"
                              : ""
                      }`}
                    >
                      {sig.detail}
                    </Badge>
                  </Hint>
                ))}
              </div>
            )}

            {row.txns.length > 0 ? (
              <div className="space-y-1.5">
                {row.txns.map((t) => {
                  const txTone =
                    t.txnType === "OPEN_MARKET_BUY"
                      ? "text-emerald-600"
                      : t.txnType === "OPEN_MARKET_SELL"
                        ? "text-rose-600"
                        : "text-muted-foreground";
                  const role = roleLabel(t);
                  return (
                    <div key={t.id} className="flex items-center justify-between text-xs gap-2">
                      <span className="truncate min-w-0" title={role ? `${t.insiderName} — ${role}` : t.insiderName}>
                        <span className="text-muted-foreground">{t.insiderName}</span>
                        {role && <span className="text-muted-foreground/60"> · {role}</span>}
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <Hint
                          text={TXN_HINTS[t.txnType] ?? "Form 4 transaction."}
                          className={`${HINT_TEXT} font-medium ${txTone}`}
                        >
                          {TXN_LABELS[t.txnType] ?? t.txnType}
                        </Hint>
                        <span className="tabular-nums text-muted-foreground">{fmtShares(t.shares)}</span>
                        {t.value != null && (
                          <span className="tabular-nums text-muted-foreground">{fmtUsd(t.value)}</span>
                        )}
                        <span className="text-muted-foreground/70">{formatDistanceToNow(new Date(t.filingDate))}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">No transactions in the last 90 days</p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-3">
            Run the insider pipeline to populate this stock
          </p>
        )}
      </CardContent>
    </Card>
  );
}
