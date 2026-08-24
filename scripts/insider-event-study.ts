import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { CLUSTER_BUYERS_THRESHOLD, CLUSTER_WINDOW_DAYS } from "../src/lib/insider-detect";

// Insider cluster-buy event study (read-only).
//
// The ship-dark insider event book (issue #57) buys on an INSIDER_CLUSTER_BUY alert
// (>= CLUSTER_BUYERS_THRESHOLD distinct open-market buyers inside a trailing
// CLUSTER_WINDOW_DAYS window) and holds ~56 calendar days, betting on a
// research-backed 20-60 session drift. Until 2026-08-24 the corpus could not test
// that (1,821 transactions over 17 names); the Form 4 backfill makes it ~112k rows
// over ~100 names back to 2021. This study asks: does the drift exist HERE?
//
// Event reconstruction mirrors live operation, not hindsight: the app windows by
// transactionDate but only ever sees a transaction once FILED, so the event day is
// the filing day on which the windowed distinct-buyer count first reaches the
// threshold, counting only transactions already filed. A 56-day per-stock cooldown
// mirrors the book's hold (it cannot re-enter while holding). Entry is the NEXT
// session's OPEN — executable, same frame the research harness now scores.
//
// Abnormal return = stock return minus an equal-weight daily-rebalanced index of
// the whole bar corpus over the same window. Honesty devices, in the house style:
//   - t across EVENT MONTHS as well as across events (events cluster in time and
//     40-60 session windows overlap heavily; the month-level t is the honest one);
//   - a SELL-cluster control (literature says sales are mostly uninformative —
//     a "drift" that shows up there too is regime, not signal);
//   - a placebo at eventDay - 180 calendar days (same names, same construction —
//     must read ~0 or the plumbing is broken).
//
// Caveats stated up front: survivorship (today's watchlist tested back to 2021 —
// insider buys in names that later survived inflate the drift); Finnhub carries no
// roles, so the C-suite variant is untestable here; the exit is an idealised close.
//
// Usage: npx tsx scripts/insider-event-study.ts

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const HORIZONS = [5, 10, 20, 40, 60] as const;
const COOLDOWN_DAYS = 56;
const MAX_ENTRY_LAG_DAYS = 7;
const PLACEBO_SHIFT_DAYS = 180;
const DAY_MS = 86_400_000;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function tStat(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd === 0 ? null : m / (sd / Math.sqrt(xs.length));
}

type Txn = { stockId: string; insiderName: string; transactionDate: Date; filingDate: Date };
type BarLite = { date: string; open: number; close: number };

/** Filing-day event detection with per-stock cooldown. Returns event day keys. */
function detectEvents(txns: Txn[], threshold: number): Map<string, string[]> {
  const byStock = new Map<string, Txn[]>();
  for (const t of txns) {
    const arr = byStock.get(t.stockId) ?? [];
    arr.push(t);
    byStock.set(t.stockId, arr);
  }
  const events = new Map<string, string[]>();
  for (const [stockId, arr] of byStock) {
    arr.sort((a, b) => a.filingDate.getTime() - b.filingDate.getTime());
    const filingDays = [...new Set(arr.map((t) => dayKey(t.filingDate)))].sort();
    let cooldownUntil = "";
    const out: string[] = [];
    for (const day of filingDays) {
      if (day <= cooldownUntil) continue;
      const now = new Date(`${day}T00:00:00Z`);
      const windowStart = new Date(now.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS);
      const buyers = new Set(
        arr
          .filter((t) => t.filingDate <= now && t.transactionDate >= windowStart && t.transactionDate <= now)
          .map((t) => t.insiderName)
      );
      if (buyers.size >= threshold) {
        out.push(day);
        cooldownUntil = dayKey(new Date(now.getTime() + COOLDOWN_DAYS * DAY_MS));
      }
    }
    if (out.length) events.set(stockId, out);
  }
  return events;
}

type EventAr = { stockId: string; ticker: string; day: string; ar: Partial<Record<number, number>> };

function measure(
  events: Map<string, string[]>,
  series: Map<string, BarLite[]>,
  barIdx: Map<string, Map<string, number>>,
  idxLevel: Map<string, number>,
  tickerOf: Map<string, string>
): EventAr[] {
  const out: EventAr[] = [];
  for (const [stockId, days] of events) {
    const bars = series.get(stockId);
    const index = barIdx.get(stockId);
    if (!bars || !index) continue;
    for (const day of days) {
      // First bar strictly after the event day = the executable entry session.
      let lo = 0;
      let hi = bars.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid].date <= day) lo = mid + 1;
        else hi = mid;
      }
      const entryIdx = lo;
      const entry = bars[entryIdx];
      if (!entry || entry.open <= 0) continue;
      if (new Date(`${entry.date}T00:00:00Z`).getTime() - new Date(`${day}T00:00:00Z`).getTime() > MAX_ENTRY_LAG_DAYS * DAY_MS)
        continue; // the name had left the bar corpus by then
      const ar: Partial<Record<number, number>> = {};
      for (const h of HORIZONS) {
        const exit = bars[entryIdx + h];
        if (!exit) continue;
        const stockRet = exit.close / entry.open - 1;
        const b0 = idxLevel.get(entry.date);
        const b1 = idxLevel.get(exit.date);
        if (b0 == null || b1 == null) continue;
        ar[h] = stockRet - (b1 / b0 - 1);
      }
      if (Object.keys(ar).length) out.push({ stockId, ticker: tickerOf.get(stockId) ?? stockId, day, ar });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

function report(label: string, events: EventAr[]) {
  console.log(`\n== ${label}: ${events.length} events ==`);
  console.log("  h     n     meanAR      hit    t(events)  t(months)  nMonths");
  for (const h of HORIZONS) {
    const ars = events.map((e) => e.ar[h]).filter((x): x is number => x != null);
    if (ars.length === 0) continue;
    const byMonth = new Map<string, number[]>();
    for (const e of events) {
      const v = e.ar[h];
      if (v == null) continue;
      const m = e.day.slice(0, 7);
      const arr = byMonth.get(m) ?? [];
      arr.push(v);
      byMonth.set(m, arr);
    }
    const monthMeans = [...byMonth.values()].map(mean);
    console.log(
      `  ${String(h).padEnd(4)}${String(ars.length).padStart(4)}  ` +
        `${((mean(ars) * 100).toFixed(2) + "%").padStart(8)}  ` +
        `${((ars.filter((x) => x > 0).length / ars.length) * 100).toFixed(0).padStart(5)}%  ` +
        `${(tStat(ars)?.toFixed(2) ?? "-").padStart(9)}  ${(tStat(monthMeans)?.toFixed(2) ?? "-").padStart(9)}  ${String(monthMeans.length).padStart(6)}`
    );
  }
}

async function main() {
  const [txns, bars, stocks] = await Promise.all([
    prisma.$queryRaw<(Txn & { txnType: string })[]>`
      select "stockId", "insiderName", "transactionDate", "filingDate", "txnType"
      from "InsiderTransaction"
      where "txnType" in ('OPEN_MARKET_BUY', 'OPEN_MARKET_SELL')`,
    prisma.priceBar.findMany({ select: { stockId: true, date: true, open: true, close: true }, orderBy: { date: "asc" } }),
    prisma.stock.findMany({ select: { id: true, ticker: true } }),
  ]);
  const tickerOf = new Map(stocks.map((s) => [s.id, s.ticker]));
  const buys = txns.filter((t) => t.txnType === "OPEN_MARKET_BUY");
  const sells = txns.filter((t) => t.txnType === "OPEN_MARKET_SELL");
  console.log(`transactions: ${buys.length} open-market buys, ${sells.length} sells; bars: ${bars.length}`);

  // Per-stock bar series + date→index, and the equal-weight daily-rebalanced index.
  const series = new Map<string, BarLite[]>();
  for (const b of bars) {
    const arr = series.get(b.stockId) ?? [];
    arr.push({ date: dayKey(b.date), open: b.open, close: b.close });
    series.set(b.stockId, arr);
  }
  const barIdx = new Map<string, Map<string, number>>();
  for (const [id, arr] of series) barIdx.set(id, new Map(arr.map((b, i) => [b.date, i])));

  const closeBy = new Map<string, Map<string, number>>(); // session -> stockId -> close
  for (const b of bars) {
    const k = dayKey(b.date);
    const m = closeBy.get(k) ?? new Map<string, number>();
    m.set(b.stockId, b.close);
    closeBy.set(k, m);
  }
  const sessions = [...closeBy.keys()].sort();
  const idxLevel = new Map<string, number>();
  let level = 1;
  idxLevel.set(sessions[0], level);
  for (let i = 1; i < sessions.length; i++) {
    const prev = closeBy.get(sessions[i - 1])!;
    const cur = closeBy.get(sessions[i])!;
    const rets: number[] = [];
    for (const [id, c] of cur) {
      const p = prev.get(id);
      if (p != null && p > 0) rets.push(c / p - 1);
    }
    level *= 1 + (rets.length ? mean(rets) : 0);
    idxLevel.set(sessions[i], level);
  }

  // ── the thesis ──────────────────────────────────────────────────────────────
  const buyEvents = measure(detectEvents(buys, CLUSTER_BUYERS_THRESHOLD), series, barIdx, idxLevel, tickerOf);
  report(`CLUSTER_BUY (≥${CLUSTER_BUYERS_THRESHOLD} distinct buyers / ${CLUSTER_WINDOW_DAYS}d)`, buyEvents);

  // Year split at the book's own horizon (40 sessions ≈ the 56-day hold).
  console.log("\n== CLUSTER_BUY by event year (h=40) ==");
  for (const year of ["2021", "2022", "2023", "2024", "2025", "2026"]) {
    const ars = buyEvents.filter((e) => e.day.startsWith(year)).map((e) => e.ar[40]).filter((x): x is number => x != null);
    if (ars.length === 0) continue;
    console.log(
      `  ${year}  n=${String(ars.length).padStart(3)}  meanAR=${((mean(ars) * 100).toFixed(2) + "%").padStart(8)}  ` +
        `hit=${((ars.filter((x) => x > 0).length / ars.length) * 100).toFixed(0)}%  t=${tStat(ars)?.toFixed(2) ?? "-"}`
    );
  }

  // ── controls ────────────────────────────────────────────────────────────────
  const sellEvents = measure(detectEvents(sells, CLUSTER_BUYERS_THRESHOLD), series, barIdx, idxLevel, tickerOf);
  report("control: SELL clusters (same construction)", sellEvents);

  const placebo = new Map<string, string[]>();
  for (const e of buyEvents) {
    const d = dayKey(new Date(new Date(`${e.day}T00:00:00Z`).getTime() - PLACEBO_SHIFT_DAYS * DAY_MS));
    const arr = placebo.get(e.stockId) ?? [];
    arr.push(d);
    placebo.set(e.stockId, arr);
  }
  report(`control: placebo (buy events shifted -${PLACEBO_SHIFT_DAYS}d)`, measure(placebo, series, barIdx, idxLevel, tickerOf));

  // Biggest single-event tails at h=40, for the narrative.
  const withH40 = buyEvents.filter((e) => e.ar[40] != null).sort((a, b) => a.ar[40]! - b.ar[40]!);
  const fmt = (e: EventAr) => `${e.ticker} ${e.day} ${((e.ar[40] ?? 0) * 100).toFixed(1)}%`;
  console.log(`\nh=40 tails — worst: ${withH40.slice(0, 3).map(fmt).join("; ")}`);
  console.log(`         — best:  ${withH40.slice(-3).reverse().map(fmt).join("; ")}`);
}

main().finally(() => prisma.$disconnect());
