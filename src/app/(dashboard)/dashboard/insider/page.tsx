import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { isInsiderEligible } from "@/lib/insider-sources";

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

type Signal = { type: string; detail: string; value: number | null };

function parseSignals(raw: unknown): Signal[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is Signal => !!s && typeof s === "object" && "type" in s && "detail" in s);
}

type InsiderTxnView = {
  id: string;
  insiderName: string;
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
            mspr: s.mspr,
            signals: parseSignals(s.signals),
            date: s.date.toISOString(),
          }
        : null,
      txns: stock.insiderTransactions.map((t) => ({
        id: t.id,
        insiderName: t.insiderName,
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
              {s.mspr != null && <Badge variant="outline">MSPR {s.mspr.toFixed(0)}</Badge>}
            </div>

            {s.signals.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {s.signals.map((sig, i) => (
                  <Badge
                    key={i}
                    className={
                      sig.type === "CLUSTER_BUY" || sig.type === "LARGE_BUY" || sig.type === "NET_BUYING"
                        ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
                        : sig.type === "NET_SELLING"
                          ? "bg-rose-100 text-rose-800 hover:bg-rose-100"
                          : ""
                    }
                  >
                    {sig.detail}
                  </Badge>
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
                  return (
                    <div key={t.id} className="flex items-center justify-between text-xs gap-2">
                      <span className="truncate text-muted-foreground" title={t.insiderName}>
                        {t.insiderName}
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className={`font-medium ${txTone}`}>
                          {TXN_LABELS[t.txnType] ?? t.txnType}
                        </span>
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
