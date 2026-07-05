import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { formatDistanceToNow } from "@/lib/format-date";
import { isAdmin } from "@/lib/auth";
import { Hint, HINT_TEXT } from "@/components/hint";
import { cn } from "@/lib/utils";
import {
  loadCalibrationReport,
  PRIMARY_HORIZON,
  type CalibrationReport,
  type HorizonReport,
} from "@/lib/calibration-data";
import type { GateStatus } from "@/lib/calibration";

export const metadata = { title: "Signal Calibration — TraderNews" };
export const dynamic = "force-dynamic";

const BUCKET_LABEL: Record<string, string> = {
  STRONG_SELL: "Strong sell",
  SELL: "Sell",
  NEUTRAL: "Neutral",
  BUY: "Buy",
  STRONG_BUY: "Strong buy",
};

const HINTS = {
  gate:
    "A pre-registered, out-of-sample, net-of-cost checklist that must be fully green before real money is on the table. It defaults to INSUFFICIENT DATA until there's enough history to certify anything — which, this early, is the expected and correct verdict.",
  ic:
    "Information coefficient — the Spearman rank correlation between a score and the realized next-period return. ~0.02–0.05 is usable, >0.10 is strong; >0.15 on a daily horizon almost always means a bug or leakage. Computed on the non-overlapping subset.",
  componentIc:
    "IC of each raw indicator vs forward return. A negative RSI IC means mean-reversion is working (low RSI → up); a positive momentum/MACD IC means trend-following is working. If they have opposite signs, the quant blend is scoring them against each other.",
  bucket:
    "Mean NET forward return per signal bucket. The headline read is whether it rises monotonically from Strong sell to Strong buy — a clean gradient is more convincing at small N than a single IC number.",
  effectiveN:
    "Independent (non-overlapping) observations. Daily overlapping windows share most of their future days, so the raw count overstates how much evidence you actually have — significance is judged on this number.",
  reliability:
    "Does the confidence field mean what it says? For each confidence bin, the empirical hit-rate should match the bin's confidence. The Brier score must beat the base-rate benchmark, or confidence carries no usable information and sizing should be equal-weight.",
  sharpe:
    "Risk-adjusted return of the gated book, annualized, computed from its daily equity curve. A backtested Sharpe above ~1.2 on this little data should be assumed overfit. Note: the sim equity is gross — the gate judges edge on the net-of-cost per-trade measure instead.",
  edge:
    "Mean NET forward return of the trades the book actually takes (BUY/STRONG_BUY entries) at the gate horizon, with a one-sample t-stat over the non-overlapping subset. This — not the gross equity Sharpe — is the gate's risk-adjusted edge: it's genuinely net of modeled costs and is re-checked at 2× cost.",
  alphaT:
    "t-statistic of the regression alpha vs SPY, using Newey-West (HAC) standard errors so autocorrelated daily returns don't overstate significance. The gate wants ≥ 2.",
  netOfCost:
    "Every forward return is measured from the bar AFTER the signal (T+1, never the signal's own bar) and is net of a modeled round-trip transaction cost. This is what stops a backtest from manufacturing fake edge.",
} as const;

function pct(frac: number | null | undefined, digits = 2): string {
  if (frac == null) return "—";
  return `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(digits)}%`;
}
function ic(v: number | null): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
}
function num(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}
function tone(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-muted-foreground";
  return v > 0 ? "text-emerald-600" : "text-rose-600";
}

const GATE_BADGE: Record<GateStatus, { label: string; cls: string }> = {
  GO: { label: "GO", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  NO_GO: { label: "NO-GO", cls: "bg-rose-100 text-rose-800 border-rose-300" },
  INSUFFICIENT_DATA: { label: "Insufficient data", cls: "bg-amber-100 text-amber-800 border-amber-300" },
};

function CheckMark({ pass }: { pass: boolean | null }) {
  if (pass === true) return <span className="text-emerald-600">✓</span>;
  if (pass === false) return <span className="text-rose-600">✗</span>;
  return <span className="text-muted-foreground">—</span>;
}

function GateCard({ gate }: { gate: CalibrationReport["gate"] }) {
  const badge = GATE_BADGE[gate.status];
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <p className="text-sm font-medium">
            <Hint text={HINTS.gate}>
              <span className={HINT_TEXT}>Go-live gate</span>
            </Hint>
          </p>
          <Badge variant="outline" className={cn("font-semibold", badge.cls)}>
            {badge.label}
          </Badge>
        </div>
        <ul className="space-y-1.5 text-sm">
          {gate.checks.map((c) => (
            <li key={c.label} className="flex items-baseline justify-between gap-3">
              <span className="flex items-baseline gap-2">
                <CheckMark pass={c.pass} />
                <span className={c.pass === false ? "" : "text-foreground"}>{c.label}</span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">{c.detail}</span>
            </li>
          ))}
        </ul>
        {gate.status === "INSUFFICIENT_DATA" && (
          <p className="text-xs text-muted-foreground mt-4 border-t pt-3">
            Not enough history to certify edge yet. This is the expected verdict early on — it
            blocks a premature go-live rather than guessing.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground font-medium">
          {hint ? (
            <Hint text={hint}>
              <span className={HINT_TEXT}>{label}</span>
            </Hint>
          ) : (
            label
          )}
        </p>
        <p className={cn("text-2xl font-bold tabular-nums mt-1", valueClass)}>{value}</p>
      </CardContent>
    </Card>
  );
}

function HorizonSection({ h, primary }: { h: HorizonReport; primary: boolean }) {
  const r = h.reliability;
  const brierBeatsBase = r.brier != null && r.baseRateBrier != null ? r.brier < r.baseRateBrier : null;
  return (
    <Card className={cn("rounded-2xl", primary && "ring-1 ring-primary/30")}>
      <CardContent className="p-4 sm:p-6 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {h.horizon}-day horizon {primary && <span className="text-xs text-primary font-normal">(gate horizon)</span>}
          </p>
          <span className="text-xs text-muted-foreground">
            {h.totalObservations} obs ·{" "}
            <Hint text={HINTS.effectiveN}>
              <span className={HINT_TEXT}>{h.effectiveSample} effective</span>
            </Hint>
          </span>
        </div>

        {/* Information coefficients */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">
            <Hint text={HINTS.ic}>
              <span className={HINT_TEXT}>Information coefficient</span>
            </Hint>
          </p>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {(["combined", "sentiment", "quant"] as const).map((k) => (
              <div key={k} className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground capitalize">{k}</p>
                <p className={cn("font-semibold tabular-nums", tone(h.ic[k]))}>{ic(h.ic[k])}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Per-component IC */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">
            <Hint text={HINTS.componentIc}>
              <span className={HINT_TEXT}>Per-component IC</span>
            </Hint>
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
            {h.componentIc.map((c) => (
              <div key={c.key} className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={cn("font-semibold tabular-nums", tone(c.ic))}>{ic(c.ic)}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Bucket gradient */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-muted-foreground">
              <Hint text={HINTS.bucket}>
                <span className={HINT_TEXT}>Mean return by bucket</span>
              </Hint>
            </p>
            <Badge variant="outline" className={cn("text-xs", h.monotone ? "text-emerald-700 border-emerald-300" : "text-muted-foreground")}>
              {h.monotone ? "monotone ✓" : "not monotone"}
            </Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate border-spacing-y-1">
              <thead>
                <tr className="text-xs text-muted-foreground text-left">
                  <th className="font-medium px-2">Bucket</th>
                  <th className="font-medium px-2 text-right">N</th>
                  <th className="font-medium px-2 text-right">Mean return</th>
                  <th className="font-medium px-2 text-right">Win rate (95% CI)</th>
                </tr>
              </thead>
              <tbody>
                {h.buckets.map((b) => (
                  <tr key={b.bucket} className="odd:bg-muted/30">
                    <td className="px-2 py-1.5 rounded-l-lg font-medium">{BUCKET_LABEL[b.bucket]}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{b.count}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", tone(b.meanReturn))}>{pct(b.meanReturn)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums rounded-r-lg text-muted-foreground">
                      {b.winRate == null
                        ? "—"
                        : `${(b.winRate * 100).toFixed(0)}%  [${(b.winRateLo! * 100).toFixed(0)}–${(b.winRateHi! * 100).toFixed(0)}]`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Confidence reliability */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-muted-foreground">
              <Hint text={HINTS.reliability}>
                <span className={HINT_TEXT}>Confidence calibration</span>
              </Hint>
            </p>
            <span className="text-xs tabular-nums text-muted-foreground">
              Brier {num(r.brier, 3)} vs base {num(r.baseRateBrier, 3)}{" "}
              {brierBeatsBase != null && (
                <span className={brierBeatsBase ? "text-emerald-600" : "text-rose-600"}>
                  {brierBeatsBase ? "(informative)" : "(no edge)"}
                </span>
              )}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {r.bins.map((b) => (
              <div key={b.lo} className="rounded-lg bg-muted/40 px-2.5 py-1.5 min-w-[5rem]">
                <p className="text-muted-foreground">
                  {(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%
                </p>
                <p className="tabular-nums font-medium">
                  {b.hitRate == null ? "—" : `${(b.hitRate * 100).toFixed(0)}% · n=${b.count}`}
                </p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function CalibrationPage() {
  const user = await getOrCreateUser();
  // Operator view — the signals/books it audits are app-level, not per-user.
  if (!isAdmin(user)) notFound();

  // Serve the pipeline's daily snapshot (the calibrate stage refreshes it every
  // run); recomputing from all estimates + quant rows on page load is reserved
  // for the empty state before the first snapshot exists.
  const snapshot = await db.calibrationSnapshot.findFirst({
    orderBy: { date: "desc" },
    select: { report: true },
  });
  const report = snapshot
    ? (snapshot.report as unknown as CalibrationReport)
    : await loadCalibrationReport();

  if (report.estimateCount === 0) {
    return (
      <div className="space-y-6">
        <Header />
        <Card className="rounded-2xl">
          <CardContent className="py-16 text-center">
            <p className="text-4xl mb-3">📐</p>
            <p className="font-medium">No estimates yet</p>
            <p className="text-muted-foreground text-sm mt-1 max-w-md mx-auto">
              The harness measures signal edge from the daily estimate history. Once the pipeline has
              produced estimates, calibration metrics will appear here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const primary = report.horizons.find((h) => h.horizon === PRIMARY_HORIZON);
  const others = report.horizons.filter((h) => h.horizon !== PRIMARY_HORIZON);

  return (
    <div className="space-y-6">
      <Header />

      <p className="text-xs text-muted-foreground">
        Report computed {formatDistanceToNow(new Date(report.generatedAt))} by the pipeline&apos;s calibrate stage.
      </p>

      {/* Coverage summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Coverage" value={`${report.monthsCoverage.toFixed(1)} mo`} valueClass={report.monthsCoverage < 6 ? "text-amber-600" : undefined} />
        <Stat label="Stocks · estimates" value={`${report.stockCount} · ${report.estimateCount}`} />
        <Stat label="Gated book" value={report.gatedBook.replace("SIM_", "")} hint="The pre-registered book the go-live gate is judged on." />
        <Stat label="Closed trades" value={String(report.closedTrades)} />
      </div>

      <GateCard gate={report.gate} />

      {/* Portfolio metrics + benchmark */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm font-medium mb-3">
            Gated book vs SPY{" "}
            <span className="text-xs text-muted-foreground font-normal">({report.gatedBook.replace("SIM_", "")})</span>
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
            <Metric label="Sharpe" hint={HINTS.sharpe} value={num(report.book?.sharpe ?? null)} valueClass={tone(report.book?.sharpe ?? null)} />
            <Metric label="Sortino" value={num(report.book?.sortino ?? null)} valueClass={tone(report.book?.sortino ?? null)} />
            <Metric label="Max DD" value={pct(report.book?.maxDrawdown != null ? -report.book.maxDrawdown : null, 1)} valueClass="text-rose-600" />
            <Metric label="Total return" value={pct(report.book?.totalReturn ?? null, 1)} valueClass={tone(report.book?.totalReturn ?? null)} />
            <Metric label="SPY return" value={report.spy.available ? pct(report.spy.totalReturn, 1) : "n/a"} valueClass={tone(report.spy.totalReturn)} />
            <Metric label="Alpha (ann.)" value={report.alpha ? pct(report.alpha.alphaAnnualized, 1) : "n/a"} valueClass={tone(report.alpha?.alphaAnnualized ?? null)} />
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t pt-3">
            <Metric label="Net-of-cost edge" hint={HINTS.edge} value={pct(report.edge.meanNet, 2)} valueClass={tone(report.edge.meanNet)} />
            <Metric label="Edge t-stat" value={num(report.edge.tStat)} valueClass={tone(report.edge.tStat)} />
            <Metric label="Edge @ 2× cost" value={pct(report.edge.meanNetStressed, 2)} valueClass={tone(report.edge.meanNetStressed)} />
            <Metric label="Alpha t-stat" hint={HINTS.alphaT} value={num(report.alpha?.alphaT ?? null)} valueClass={tone(report.alpha?.alphaT ?? null)} />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Edge over {report.edge.n} non-overlapping {PRIMARY_HORIZON}-day entry trades
            {report.alpha != null && <> · beta to SPY {num(report.alpha.beta)}</>}
            {report.watchlistReturn != null && (
              <> · watchlist equal-weight {pct(report.watchlistReturn, 1)}</>
            )}
            {report.breadth.effectiveBets != null && (
              <>
                {" "}
                · {report.breadth.stocks} names ≈ {report.breadth.effectiveBets.toFixed(1)} independent
                bets (avg ρ {num(report.breadth.avgCorrelation, 2)})
              </>
            )}
            .
          </p>
        </CardContent>
      </Card>

      {/* Horizons */}
      {primary && <HorizonSection h={primary} primary />}
      {others.map((h) => (
        <HorizonSection key={h.horizon} h={h} primary={false} />
      ))}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Signal Calibration</h1>
      <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
        Does the app’s signal actually have edge?{" "}
        <Hint text={HINTS.netOfCost}>
          <span className={HINT_TEXT}>Every return is measured T+1 and net of costs</span>
        </Hint>
        , with significance on the non-overlapping sample — so the numbers can’t manufacture an edge
        that isn’t there.
      </p>
    </div>
  );
}

function Metric({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {hint ? (
          <Hint text={hint}>
            <span className={HINT_TEXT}>{label}</span>
          </Hint>
        ) : (
          label
        )}
      </p>
      <p className={cn("font-semibold tabular-nums", valueClass)}>{value}</p>
    </div>
  );
}
