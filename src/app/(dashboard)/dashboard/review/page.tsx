import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import { formatDistanceToNow } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import type { DailyReviewReport, Finding, Severity, StrategyStats } from "@/lib/daily-review";

export const metadata = { title: "Daily Review — TraderNews" };
export const dynamic = "force-dynamic";

const SEVERITY: Record<Severity, { label: string; className: string }> = {
  fail: { label: "Fail", className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20" },
  warn: { label: "Warn", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" },
  info: { label: "Info", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" },
};

const STATUS: Record<string, { label: string; blurb: string; className: string }> = {
  OK: {
    label: "OK",
    blurb: "Everything behaved as the rules say it should.",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  WARN: {
    label: "Warnings",
    blurb: "The books traded, but some checks want a look.",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  FAIL: {
    label: "Failures",
    blurb: "At least one check found the app doing something its own rules forbid.",
    className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  },
};

function money(v: number | null | undefined, digits = 2): string {
  if (v == null) return "—";
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(digits)}`;
}
function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function num(v: number | null | undefined, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const s = SEVERITY[f.severity] ?? SEVERITY.info;
  return (
    <li className="border-border/60 border-b py-3 last:border-0">
      <div className="flex items-start gap-3">
        <Badge variant="outline" className={cn("mt-0.5 shrink-0 text-[10px]", s.className)}>
          {s.label}
        </Badge>
        <div className="min-w-0">
          <div className="text-sm font-medium">{f.title}</div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{f.detail}</p>
          <div className="text-muted-foreground/70 mt-1 font-mono text-[10px]">{f.code}</div>
        </div>
      </div>
    </li>
  );
}

function StrategyTable({ strategies }: { strategies: StrategyStats[] }) {
  if (strategies.length === 0) {
    return <p className="text-muted-foreground text-sm">No closed trades in the lookback window yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-muted-foreground border-border/60 border-b text-xs">
          <tr>
            <th className="py-2 text-left font-medium">Book</th>
            <th className="py-2 text-right font-medium">Closed</th>
            <th className="py-2 text-right font-medium">Hit rate</th>
            <th className="py-2 text-right font-medium">Payoff</th>
            <th className="py-2 text-right font-medium">Avg hold</th>
            <th className="py-2 text-right font-medium">Net P&amp;L</th>
            <th className="py-2 text-left font-medium">Exit mix</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => (
            <tr key={s.strategy} className="border-border/40 border-b last:border-0">
              <td className="py-2 font-medium">{s.strategy}</td>
              <td className="py-2 text-right tabular-nums">{s.closed}</td>
              <td className="py-2 text-right tabular-nums">{pct(s.hitRate)}</td>
              <td className="py-2 text-right tabular-nums">{num(s.payoff)}</td>
              <td className="py-2 text-right tabular-nums">{s.avgHoldDays == null ? "—" : `${s.avgHoldDays.toFixed(1)}d`}</td>
              <td className={cn("py-2 text-right tabular-nums", s.totalPnl < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
                {money(s.totalPnl)}
              </td>
              <td className="text-muted-foreground py-2 text-xs">
                {Object.entries(s.exitMix)
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([rung, b]) => `${rung} ${b.count}`)
                  .join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ReviewPage() {
  const user = await getOrCreateUser();
  if (!user) notFound();
  if (!isAdmin(user)) notFound();

  const [latest, recent] = await Promise.all([
    db.dailyReview.findFirst({ where: { status: { not: null } }, orderBy: { date: "desc" } }),
    db.dailyReview.findMany({
      where: { status: { not: null } },
      orderBy: { date: "desc" },
      take: 21,
      select: { date: true, status: true, findingCount: true },
    }),
  ]);

  const report = (latest?.report ?? null) as DailyReviewReport | null;

  if (!report) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Daily Review</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            A post-close self-audit that asks whether the app did what its own rules say it should have done.
          </p>
        </div>
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No review has run yet. The review stage fires about an hour after the close on trading days.
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = STATUS[report.status] ?? STATUS.OK;
  const actionable = report.findings.filter((f) => f.severity !== "info");
  const tuning = report.findings.filter((f) => f.severity === "info");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Daily Review</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            A post-close self-audit that asks whether the app did what its own rules say it should have done.
          </p>
        </div>
        <div className="text-right">
          <Badge variant="outline" className={cn("text-xs", status.className)}>
            {status.label}
          </Badge>
          <div className="text-muted-foreground mt-1 text-xs">
            {report.date} · {formatDistanceToNow(new Date(report.generatedAt))}
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          <p className="text-sm">{status.blurb}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Failures" value={String(report.summary.fails)} />
            <Stat label="Warnings" value={String(report.summary.warns)} />
            <Stat label="Opened" value={String(report.summary.openedToday)} />
            <Stat label="Closed" value={String(report.summary.closedToday)} />
            <Stat label="Realized" value={money(report.summary.realizedToday)} />
            <Stat label="Open now" value={String(report.summary.openPositions)} />
            <Stat
              label="Decisions replayed"
              value={String(report.summary.replayed)}
              hint={report.summary.replayed === 0 ? "no run log" : undefined}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-5">
          <h2 className="mb-1 text-sm font-semibold">
            Findings{actionable.length > 0 ? ` (${actionable.length})` : ""}
          </h2>
          <p className="text-muted-foreground mb-2 text-xs">
            Correctness first: a failure means the persisted books and the strategy rules disagree.
          </p>
          {actionable.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">Nothing needed attention today.</p>
          ) : (
            <ul className="mt-2">
              {actionable.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} f={f} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {tuning.length > 0 && (
        <Card>
          <CardContent className="py-5">
            <h2 className="mb-1 text-sm font-semibold">Tuning signals ({tuning.length})</h2>
            <p className="text-muted-foreground mb-2 text-xs">
              Arguments for changing a knob, not bugs. Each names the knob and the evidence behind it.
            </p>
            <ul className="mt-2">
              {tuning.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} f={f} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-5">
          <h2 className="mb-3 text-sm font-semibold">Books, by exit rung</h2>
          <StrategyTable strategies={report.strategies} />
        </CardContent>
      </Card>

      {report.books.length > 0 && (
        <Card>
          <CardContent className="py-5">
            <h2 className="mb-3 text-sm font-semibold">Equity today</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-muted-foreground border-border/60 border-b text-xs">
                  <tr>
                    <th className="py-2 text-left font-medium">Book</th>
                    <th className="py-2 text-right font-medium">Equity</th>
                    <th className="py-2 text-right font-medium">Day change</th>
                    <th className="py-2 text-right font-medium">Realized</th>
                    <th className="py-2 text-right font-medium">Unrealized</th>
                    <th className="py-2 text-right font-medium">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {report.books.map((b) => (
                    <tr key={b.book} className="border-border/40 border-b last:border-0">
                      <td className="py-2 font-medium">{b.book}</td>
                      <td className="py-2 text-right tabular-nums">{money(b.equity, 0)}</td>
                      <td
                        className={cn(
                          "py-2 text-right tabular-nums",
                          b.dayChange == null ? "" : b.dayChange < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                        )}
                      >
                        {money(b.dayChange)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(b.realizedPnl, 0)}</td>
                      <td className="py-2 text-right tabular-nums">{money(b.unrealizedPnl, 0)}</td>
                      <td className="py-2 text-right tabular-nums">{b.openPositions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {report.notes.length > 0 && (
        <Card>
          <CardContent className="py-5">
            <h2 className="mb-2 text-sm font-semibold">What couldn&apos;t be checked</h2>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {report.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {recent.length > 1 && (
        <Card>
          <CardContent className="py-5">
            <h2 className="mb-3 text-sm font-semibold">Recent days</h2>
            <div className="flex flex-wrap gap-1.5">
              {recent.map((r) => {
                const s = STATUS[r.status ?? "OK"] ?? STATUS.OK;
                return (
                  <Badge
                    key={r.date.toISOString()}
                    variant="outline"
                    className={cn("text-[10px] tabular-nums", s.className)}
                    title={`${r.findingCount} finding(s)`}
                  >
                    {r.date.toISOString().slice(5, 10)}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
