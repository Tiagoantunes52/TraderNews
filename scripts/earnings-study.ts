import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Read-only: do trade losses cluster around earnings events?
//
// The pipeline has recorded Finnhub's 30-day-forward earnings calendar per stock
// per day (QuantAnalysis.nextEarningsDate) since June, but the only consumer is a
// confidence dampener at estimate time — there is no entry blackout and no
// pre-earnings exit. Before proposing either, measure whether earnings inside the
// holding period actually cost money on the closed trades we have.
//
// Method: reconstruct each stock's scheduled-earnings list from the distinct
// nextEarningsDate values it was tagged with, dedupe closed trades to unique
// (ticker, entryDay, exitDay) events (the same underlying trade appears in
// several books), and split by whether an earnings date fell inside the hold.
// Also: the blackout counterfactual — trades entered within N days BEFORE an
// earnings date, the set an entry blackout would have skipped.
//
// Caveats stated up front: descriptive and in-sample; earnings dates can shift
// after being recorded; the sample is one summer of mostly-rally tape.
//
// Usage: npx tsx scripts/earnings-study.ts

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const FROM = new Date("2026-06-01T00:00:00.000Z");
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

type TradeEvent = {
  ticker: string;
  entryDay: string;
  exitDay: string;
  ret: number;
  strategies: string[];
  exitReasons: Set<string>;
  earningsInHold: string | null;
  daysToNextEarningsAtEntry: number | null;
};

function stats(label: string, xs: TradeEvent[]) {
  if (xs.length === 0) {
    console.log(`  ${label.padEnd(26)} n=0`);
    return;
  }
  const rets = xs.map((t) => t.ret);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  console.log(
    `  ${label.padEnd(26)} n=${String(xs.length).padStart(4)}  win=${((wins.length / xs.length) * 100).toFixed(0).padStart(3)}%  ` +
      `mean=${pct(mean(rets)).padStart(7)}  meanLoss=${losses.length ? pct(mean(losses)).padStart(7) : "      -"}  ` +
      `worst=${pct(Math.min(...rets)).padStart(8)}`
  );
}

async function main() {
  const positions = await prisma.simPosition.findMany({
    where: { status: "CLOSED", entryDate: { gte: FROM }, exitDate: { not: null }, exitPrice: { not: null } },
    select: {
      strategy: true,
      entryDate: true,
      exitDate: true,
      entryPrice: true,
      exitPrice: true,
      exitReason: true,
      stock: { select: { ticker: true } },
    },
  });

  const earningsRows = await prisma.$queryRaw<{ ticker: string; e: Date }[]>`
    select distinct s.ticker, q."nextEarningsDate" e
    from "QuantAnalysis" q join "Stock" s on s.id = q."stockId"
    where q."nextEarningsDate" is not null`;
  const earningsByTicker = new Map<string, string[]>();
  for (const r of earningsRows) {
    const arr = earningsByTicker.get(r.ticker) ?? [];
    arr.push(dayKey(r.e));
    earningsByTicker.set(r.ticker, arr);
  }
  for (const arr of earningsByTicker.values()) arr.sort();
  console.log(
    `closed positions since ${dayKey(FROM)}: ${positions.length}; ` +
      `earnings dates known for ${earningsByTicker.size} tickers ` +
      `(${[...earningsByTicker.values()].reduce((a, v) => a + v.length, 0)} events)`
  );

  // Dedupe to unique underlying trades — same (ticker, entry, exit) across books
  // is one market event, and pooling it would count one earnings gap many times.
  const byEvent = new Map<string, TradeEvent>();
  for (const p of positions) {
    const ticker = p.stock.ticker;
    const entryDay = dayKey(p.entryDate);
    const exitDay = dayKey(p.exitDate!);
    const key = `${ticker}|${entryDay}|${exitDay}`;
    const dates = earningsByTicker.get(ticker) ?? [];
    let ev = byEvent.get(key);
    if (!ev) {
      const inHold = dates.find((e) => e >= entryDay && e <= exitDay) ?? null;
      const upcoming = dates.filter((e) => e >= entryDay);
      const daysToNext = upcoming.length
        ? Math.round((new Date(`${upcoming[0]}T00:00:00Z`).getTime() - new Date(`${entryDay}T00:00:00Z`).getTime()) / 86_400_000)
        : null;
      ev = {
        ticker,
        entryDay,
        exitDay,
        ret: p.exitPrice! / p.entryPrice - 1,
        strategies: [],
        exitReasons: new Set(),
        earningsInHold: inHold,
        daysToNextEarningsAtEntry: daysToNext,
      };
      byEvent.set(key, ev);
    }
    ev.strategies.push(p.strategy);
    if (p.exitReason) ev.exitReasons.add(p.exitReason);
  }
  const events = [...byEvent.values()];
  const covered = events.filter((e) => (earningsByTicker.get(e.ticker) ?? []).length > 0);
  console.log(`unique (ticker, entry, exit) trade events: ${events.length}; with earnings coverage: ${covered.length}\n`);

  // ── main split ──────────────────────────────────────────────────────────────
  console.log("== held through an earnings date vs not (unique events, coverage only) ==");
  const through = covered.filter((e) => e.earningsInHold != null);
  const clear = covered.filter((e) => e.earningsInHold == null);
  stats("held through earnings", through);
  stats("no earnings in hold", clear);

  // ── entry proximity: the blackout counterfactual ────────────────────────────
  console.log("\n== entered with N or fewer days to the next scheduled earnings ==");
  for (const n of [3, 5, 8]) {
    stats(
      `entered <= ${n}d before`,
      covered.filter((e) => e.daysToNextEarningsAtEntry != null && e.daysToNextEarningsAtEntry <= n)
    );
  }
  stats(
    "entered > 8d before / none",
    covered.filter((e) => e.daysToNextEarningsAtEntry == null || e.daysToNextEarningsAtEntry > 8)
  );

  // ── the loss tail ───────────────────────────────────────────────────────────
  console.log("\n== worst 12 unique trade events (earnings flagged) ==");
  const worst = [...covered].sort((a, b) => a.ret - b.ret).slice(0, 12);
  for (const e of worst) {
    console.log(
      `  ${e.ticker.padEnd(6)} ${e.entryDay} → ${e.exitDay}  ${pct(e.ret).padStart(8)}  ` +
        `${e.earningsInHold ? `EARNINGS ${e.earningsInHold}` : "no earnings in hold".padEnd(19)}  ` +
        `[${[...e.exitReasons].join(",") || "unlabelled"}] ${e.strategies.length} book(s)`
    );
  }

  // ── STOP exits specifically (labelled _RM sample) ───────────────────────────
  console.log("\n== labelled STOP exits: was there an earnings date in the hold? ==");
  const stops = covered.filter((e) => e.exitReasons.has("STOP"));
  stats("STOP with earnings", stops.filter((e) => e.earningsInHold != null));
  stats("STOP without earnings", stops.filter((e) => e.earningsInHold == null));
}

main().finally(() => prisma.$disconnect());
