import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDailyPrices } from "../src/lib/price-sources";
import { DEFAULT_RISK_CONFIG, riskDistancePct } from "../src/lib/paper-trading";

// Exit-ladder attribution study (read-only).
//
// The strategy thread in OPEN-FINDINGS.md flagged a cut-winners-short signature
// (hit rate 55-62%, payoff 0.54-0.66) but could not attribute it to a rung because
// exitReason only began persisting 2026-07-21. This script re-runs the question
// against the labelled sample: per rung it reports trade outcomes, how much of each
// trade's peak gain was banked (MFE capture, from the persisted peakPrice), and
// post-exit drift vs SPY over the next 5/10 sessions (did the rung sell names that
// kept running?).
//
// Statistics discipline, learned the hard way in signal-health.ts: same-day exits
// are one market move, not independent observations, so drift t-stats are computed
// across exit SESSIONS (per-session means), never pooled per trade. With n this
// small every t is underpowered - the numbers are for attribution direction, not
// significance claims.
//
// Usage: npx tsx scripts/exit-ladder-study.ts

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const RM_BOOKS = ["COMBINED_RM", "SENTIMENT_RM", "QUANT_RM"];
const DRIFT_HORIZONS = [5, 10];

interface Trade {
  strategy: string;
  ticker: string;
  stockId: string;
  entryDate: Date;
  exitDate: Date;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  realizedPnl: number;
  exitReason: string;
  peakPrice: number | null;
  entryAtrPct: number | null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** One-sample t of the mean against zero; null when it cannot be computed. */
function tStat(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd === 0 ? null : m / (sd / Math.sqrt(xs.length));
}

/** Per-stock bar closes sorted by date, with a date -> index lookup. */
interface BarSeries {
  dates: string[];
  closes: number[];
  index: Map<string, number>;
}

function toSeries(rows: { date: Date; close: number }[]): BarSeries {
  const sorted = rows.slice().sort((a, b) => a.date.getTime() - b.date.getTime());
  const dates = sorted.map((r) => dayKey(r.date));
  return { dates, closes: sorted.map((r) => r.close), index: new Map(dates.map((d, i) => [d, i])) };
}

/**
 * Return over the k sessions following `day` in this series: base = the bar ON
 * `day` (fall back up to 3 earlier sessions - an exit written on a holiday or
 * from a live quote may not have a same-day bar), target = k bars later.
 * Null when the series does not extend far enough yet.
 */
function forwardReturn(s: BarSeries, day: string, k: number): number | null {
  let i = s.index.get(day);
  if (i == null) {
    const j = s.dates.findLastIndex((d) => d < day);
    if (j < 0) return null;
    i = j;
  }
  if (i + k >= s.dates.length) return null;
  return s.closes[i + k] / s.closes[i] - 1;
}

interface RungRow {
  reason: string;
  trades: Trade[];
  rets: number[];
  drift: Record<number, { excess: number[]; sessions: Map<string, number[]> }>;
}

function fmtRow(cells: (string | number)[], widths: number[]): string {
  return cells.map((c, i) => String(c).padStart(widths[i])).join("  ");
}

async function main() {
  const raw = await prisma.simPosition.findMany({
    where: { status: "CLOSED", strategy: { in: RM_BOOKS }, exitReason: { not: null } },
    include: { stock: { select: { ticker: true } } },
  });
  const trades: Trade[] = raw
    .filter((p) => p.exitDate && p.exitPrice != null)
    .map((p) => ({
      strategy: p.strategy,
      ticker: p.stock.ticker,
      stockId: p.stockId,
      entryDate: p.entryDate,
      exitDate: p.exitDate!,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice!,
      qty: p.qty,
      realizedPnl: p.realizedPnl ?? p.qty * (p.exitPrice! - p.entryPrice),
      exitReason: p.exitReason!,
      peakPrice: p.peakPrice,
      entryAtrPct: p.entryAtrPct,
    }));

  console.log(`labelled _RM closes: ${trades.length}`);
  const uniquePairs = new Set(trades.map((t) => `${t.ticker}|${dayKey(t.exitDate)}`));
  console.log(`unique (ticker, exit day) pairs: ${uniquePairs.size} (overlap across books inflates pooled n)\n`);

  // Bars for every involved stock, from a month before the first entry. SPY comes
  // from the app's own price-source chain rather than PriceBar: SPY left the
  // tracked universe on 2026-07-29 so its stored bars end there, while exits run
  // three weeks past that.
  const from = new Date(Math.min(...trades.map((t) => t.entryDate.getTime())) - 40 * 86_400_000);
  const stockIds = [...new Set(trades.map((t) => t.stockId))];
  const bars = await prisma.priceBar.findMany({
    where: { stockId: { in: stockIds }, date: { gte: from } },
    select: { stockId: true, date: true, close: true },
  });
  const byStock = new Map<string, { date: Date; close: number }[]>();
  for (const b of bars) {
    const arr = byStock.get(b.stockId) ?? [];
    arr.push(b);
    byStock.set(b.stockId, arr);
  }
  const series = new Map<string, BarSeries>();
  for (const [id, rows] of byStock) series.set(id, toSeries(rows));

  const spyFetch = await getDailyPrices("SPY", from);
  if (spyFetch.prices.length === 0) throw new Error(`SPY fetch failed: ${spyFetch.errors.join("; ")}`);
  const spy = toSeries(spyFetch.prices.map((p) => ({ date: new Date(p.date), close: p.close })));
  console.log(
    `bars loaded for ${series.size} stocks; SPY via ${spyFetch.provider} through ${spy.dates.at(-1)}\n`
  );

  // ── assemble per-rung rows (pooled across the three books) ──────────────────
  const rungs = new Map<string, RungRow>();
  for (const t of trades) {
    const r = rungs.get(t.exitReason) ?? {
      reason: t.exitReason,
      trades: [],
      rets: [],
      drift: Object.fromEntries(
        DRIFT_HORIZONS.map((h) => [h, { excess: [], sessions: new Map() }])
      ) as RungRow["drift"],
    };
    r.trades.push(t);
    r.rets.push(t.exitPrice / t.entryPrice - 1);
    const day = dayKey(t.exitDate);
    const s = series.get(t.stockId);
    for (const h of DRIFT_HORIZONS) {
      const stockFwd = s ? forwardReturn(s, day, h) : null;
      const spyFwd = forwardReturn(spy, day, h);
      if (stockFwd != null && spyFwd != null) {
        const ex = stockFwd - spyFwd;
        r.drift[h].excess.push(ex);
        const sess = r.drift[h].sessions.get(day) ?? [];
        sess.push(ex);
        r.drift[h].sessions.set(day, sess);
      }
    }
    rungs.set(t.exitReason, r);
  }

  const order = ["STOP", "TRAIL", "SIGNAL", "DECAY", "TIME"];
  const sorted = [...rungs.values()].sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason));

  // ── table 1: outcomes per rung ──────────────────────────────────────────────
  console.log("== outcomes per rung (pooled across _RM books) ==");
  const w1 = [7, 4, 6, 9, 9, 9, 9, 10, 7];
  console.log(fmtRow(["rung", "n", "win%", "meanRet", "medRet", "meanWin", "meanLoss", "totalPnl$", "holdD"], w1));
  for (const r of sorted) {
    const wins = r.rets.filter((x) => x > 0);
    const losses = r.rets.filter((x) => x <= 0);
    const holdDays = r.trades.map((t) => (t.exitDate.getTime() - t.entryDate.getTime()) / 86_400_000);
    console.log(
      fmtRow(
        [
          r.reason,
          r.rets.length,
          ((wins.length / r.rets.length) * 100).toFixed(0),
          pct(mean(r.rets)),
          pct(median(r.rets)),
          wins.length ? pct(mean(wins)) : "-",
          losses.length ? pct(mean(losses)) : "-",
          r.trades.reduce((a, t) => a + t.realizedPnl, 0).toFixed(0),
          mean(holdDays).toFixed(0),
        ],
        w1
      )
    );
  }

  // ── table 2: MFE capture per rung ───────────────────────────────────────────
  // mfe = peak/entry - 1 (max favourable excursion the book SAW - daily closes,
  // so intraday peaks are understated for everyone equally). capture = ret/mfe,
  // only meaningful when the trade actually had a peak worth capturing (mfe >= 2%).
  console.log("\n== MFE capture per rung (peakPrice-based) ==");
  const w2 = [7, 4, 9, 10, 12, 12];
  console.log(fmtRow(["rung", "n", "meanMFE", "giveback", "n(mfe>=2%)", "medCapture"], w2));
  for (const r of sorted) {
    const withPeak = r.trades.filter((t) => t.peakPrice != null && t.peakPrice > 0);
    const mfes = withPeak.map((t) => t.peakPrice! / t.entryPrice - 1);
    const givebacks = withPeak.map((t) => t.exitPrice / t.peakPrice! - 1);
    const capturable = withPeak.filter((t) => t.peakPrice! / t.entryPrice - 1 >= 0.02);
    const captures = capturable.map((t) => (t.exitPrice / t.entryPrice - 1) / (t.peakPrice! / t.entryPrice - 1));
    console.log(
      fmtRow(
        [
          r.reason,
          withPeak.length,
          mfes.length ? pct(mean(mfes)) : "-",
          givebacks.length ? pct(mean(givebacks)) : "-",
          capturable.length,
          captures.length ? median(captures).toFixed(2) : "-",
        ],
        w2
      )
    );
  }

  // ── table 3: post-exit drift per rung ───────────────────────────────────────
  console.log("\n== post-exit drift vs SPY (positive = the name kept running after we sold) ==");
  const w3 = [7, 12, 10, 8, 6, 12, 10, 8, 6];
  console.log(fmtRow(["rung", "5d excess", "t(sess)", "nTrade", "nSess", "10d excess", "t(sess)", "nTrade", "nSess"], w3));
  const driftRow = (label: string, drift: RungRow["drift"]) => {
    const cells: (string | number)[] = [label];
    for (const h of DRIFT_HORIZONS) {
      const d = drift[h];
      const sessMeans = [...d.sessions.values()].map(mean);
      const t = tStat(sessMeans);
      cells.push(
        d.excess.length ? pct(mean(d.excess)) : "-",
        t != null ? t.toFixed(2) : "-",
        d.excess.length,
        sessMeans.length
      );
    }
    console.log(fmtRow(cells, w3));
  };
  for (const r of sorted) driftRow(r.reason, r.drift);
  // Aggregate row for continuity with the register's -2.97% (all rungs pooled).
  const allDrift = Object.fromEntries(
    DRIFT_HORIZONS.map((h) => [h, { excess: [] as number[], sessions: new Map<string, number[]>() }])
  ) as RungRow["drift"];
  for (const r of sorted)
    for (const h of DRIFT_HORIZONS) {
      allDrift[h].excess.push(...r.drift[h].excess);
      for (const [day, xs] of r.drift[h].sessions) {
        const sess = allDrift[h].sessions.get(day) ?? [];
        sess.push(...xs);
        allDrift[h].sessions.set(day, sess);
      }
    }
  driftRow("ALL", allDrift);

  // ── table 4: per-book × rung return means (overlap check) ───────────────────
  console.log("\n== mean return by book × rung (n) ==");
  const w4 = [14, ...order.map(() => 16)];
  console.log(fmtRow(["book", ...order], w4));
  for (const book of RM_BOOKS) {
    const cells: (string | number)[] = [book];
    for (const reason of order) {
      const rets = trades.filter((t) => t.strategy === book && t.exitReason === reason).map((t) => t.exitPrice / t.entryPrice - 1);
      cells.push(rets.length ? `${pct(mean(rets))} (${rets.length})` : "-");
    }
    console.log(fmtRow(cells, w4));
  }

  // ── continuity: aggregate payoff on the labelled sample ─────────────────────
  const all = trades.map((t) => t.exitPrice / t.entryPrice - 1);
  const wins = all.filter((x) => x > 0);
  const losses = all.filter((x) => x <= 0);
  console.log(
    `\naggregate (labelled only): n=${all.length} win=${((wins.length / all.length) * 100).toFixed(1)}% ` +
      `meanWin=${pct(mean(wins))} meanLoss=${pct(mean(losses))} payoff=${(mean(wins) / -mean(losses)).toFixed(2)} ` +
      `mean/trade=${pct(mean(all))}`
  );

  // Per-trade detail on the two rungs where the aggregates point at a leak:
  // TRAIL (low capture, positive post-exit drift) and STOP (post-stop recovery).
  for (const reason of ["TRAIL", "STOP"]) {
    console.log(`\n== ${reason} trades in detail ==`);
    const rows = trades
      .filter((t) => t.exitReason === reason)
      .sort((a, b) => a.exitDate.getTime() - b.exitDate.getTime());
    for (const t of rows) {
      const day = dayKey(t.exitDate);
      const s = series.get(t.stockId);
      const f5 = s ? forwardReturn(s, day, 5) : null;
      const f10 = s ? forwardReturn(s, day, 10) : null;
      const b5 = forwardReturn(spy, day, 5);
      const b10 = forwardReturn(spy, day, 10);
      const peak = t.peakPrice ? t.peakPrice / t.entryPrice - 1 : null;
      const ratchet = peak != null && peak >= 0.15 ? " RATCHET" : "";
      console.log(
        `  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} ${dayKey(t.entryDate)} → ${day}  ` +
          `ret ${pct(t.exitPrice / t.entryPrice - 1).padStart(8)}  peak ${peak != null ? pct(peak).padStart(7) : "      -"}  ` +
          `drift5 ${f5 != null && b5 != null ? pct(f5 - b5).padStart(7) : "      -"}  ` +
          `drift10 ${f10 != null && b10 != null ? pct(f10 - b10).padStart(7) : "      -"}${ratchet}`
      );
    }
  }

  // ── counterfactual: TRAIL exits held on under a full-width trail ────────────
  // Replaying whole trades from entry is not possible from bars alone: the
  // book's price stream lags the bar sessions (a recorded entryPrice matches the
  // PREVIOUS session's close), runs can skip a name (the missing-fresh-estimate
  // gap), and the price sources differ. So the counterfactual starts from the
  // recorded exit-day state instead - entryPrice and peakPrice are ground truth
  // on the closed row - and walks only the bars AFTER the actual exit, asking
  // when a full-width trail (trailRatchetFrac = 1) from the same peak would have
  // fired. Only the price rungs are modelled; a still-open counterfactual is
  // marked at the name's last stored bar (names that leave the universe stop
  // updating, so those deltas are truncated, not final).
  console.log("\n== counterfactual: TRAIL exits held on under a full-width (no-ratchet) trail ==");
  const cfg = DEFAULT_RISK_CONFIG;
  const deltas: number[] = [];
  for (const t of trades
    .filter((x) => x.exitReason === "TRAIL" && x.peakPrice != null)
    .sort((a, b) => a.exitDate.getTime() - b.exitDate.getTime())) {
    const s = series.get(t.stockId);
    const exitDay = dayKey(t.exitDate);
    // A counterfactual needs bars AFTER the exit; a name whose series ends at or
    // before its exit day has nothing to say (marking it at a pre-exit bar would
    // fabricate a delta out of the price-basis gap between book and bars).
    if (!s || (s.dates.at(-1) ?? "") <= exitDay) {
      console.log(`  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} actual @${exitDay} - no post-exit bars, excluded`);
      continue;
    }
    const stopDist = riskDistancePct(cfg, t.entryAtrPct, cfg.stopLossPct);
    const trailDist = riskDistancePct(cfg, t.entryAtrPct, cfg.trailPct);
    // Would the wide trail have fired on the actual exit day too? Then the
    // ratchet made no difference for this trade.
    if (t.exitPrice <= t.peakPrice! * (1 - trailDist)) {
      console.log(
        `  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} actual ${pct(t.exitPrice / t.entryPrice - 1).padStart(8)} @${exitDay}  ` +
          `wide trail fires same day (no ratchet effect)`
      );
      deltas.push(0);
      continue;
    }
    let peak = Math.max(t.peakPrice!, t.exitPrice);
    let outcome = "open";
    let cfRet: number | null = null;
    let cfDay = s.dates.at(-1) ?? exitDay;
    for (let i = 0; i < s.dates.length; i++) {
      if (s.dates[i] <= exitDay) continue;
      const close = s.closes[i];
      peak = Math.max(peak, close);
      if (close <= t.entryPrice * (1 - stopDist) || close <= peak * (1 - trailDist)) {
        outcome = close <= t.entryPrice * (1 - stopDist) ? "STOP" : "TRAIL";
        cfRet = close / t.entryPrice - 1;
        cfDay = s.dates[i];
        break;
      }
    }
    if (cfRet == null) cfRet = (s.closes.at(-1) ?? t.exitPrice) / t.entryPrice - 1;
    const actual = t.exitPrice / t.entryPrice - 1;
    deltas.push(cfRet - actual);
    console.log(
      `  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} actual ${pct(actual).padStart(8)} @${exitDay}  ` +
        `cf ${outcome.padEnd(5)} ${pct(cfRet).padStart(8)} @${cfDay}  delta ${pct(cfRet - actual).padStart(8)}`
    );
  }
  if (deltas.length)
    console.log(
      `  mean delta ${pct(mean(deltas))} over ${deltas.length} trades. "open" deltas are marks at the name's ` +
        `last stored bar, not realised exits - but the wide trail bounds any later exit at peak x (1 - trail).`
    );

  // Worst and best individual labelled trades, for the narrative.
  const byRet = trades.slice().sort((a, b) => a.exitPrice / a.entryPrice - b.exitPrice / b.entryPrice);
  console.log("\nworst 5 labelled trades:");
  for (const t of byRet.slice(0, 5))
    console.log(
      `  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} ${t.exitReason.padEnd(6)} ${pct(t.exitPrice / t.entryPrice - 1).padStart(8)}  ` +
        `${dayKey(t.entryDate)} → ${dayKey(t.exitDate)}  peak ${t.peakPrice ? pct(t.peakPrice / t.entryPrice - 1) : "-"}`
    );
  console.log("best 5 labelled trades:");
  for (const t of byRet.slice(-5).reverse())
    console.log(
      `  ${t.ticker.padEnd(6)} ${t.strategy.padEnd(13)} ${t.exitReason.padEnd(6)} ${pct(t.exitPrice / t.entryPrice - 1).padStart(8)}  ` +
        `${dayKey(t.entryDate)} → ${dayKey(t.exitDate)}  peak ${t.peakPrice ? pct(t.peakPrice / t.entryPrice - 1) : "-"}`
    );
}

main().finally(() => prisma.$disconnect());
