import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { explainDay, formatDayExplanation, type DayInput } from "../src/lib/explain-day";
import type { PaperRunLog } from "../src/lib/daily-review";

// "What actually happened on day D?" — one command, one answer.
//
// The question kept costing a round-trip because answering it meant querying five
// tables and joining them on a day offset that was nowhere written down. Both halves of
// that are now fixed: QuantAnalysis.sessionDate records the session a row describes,
// PaperRunLog.pricing records how the run was marked, and this script reads BOTH rather
// than re-deriving either. All the judgement lives in the pure `lib/explain-day.ts`;
// this file only loads.
//
// Usage:
//   npx tsx scripts/explain-day.ts                 (the most recent run)
//   npx tsx scripts/explain-day.ts 2026-07-29
//   npx tsx scripts/explain-day.ts 2026-07-27 --days=3
//   npx tsx scripts/explain-day.ts 2026-07-29 --json

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

/** Sessions of bar history to load per stock — enough to spot a weekend-sized misalignment. */
const BAR_WINDOW_DAYS = 10;

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function parseArgs(argv: string[]) {
  let day: string | null = null;
  let days = 1;
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--days=")) days = Math.max(1, Number(a.slice(7)) || 1);
    else if (!a.startsWith("--")) day = a;
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.error(`Expected a YYYY-MM-DD date, got: ${day}`);
    process.exit(2);
  }
  return { day, days, json };
}

async function loadDay(day: Date): Promise<DayInput> {
  const next = new Date(day.getTime() + DAY_MS);
  const barsFrom = new Date(day.getTime() - BAR_WINDOW_DAYS * DAY_MS);

  const review = await prisma.dailyReview.findUnique({
    where: { date: day },
    select: { paperRun: true, status: true },
  });

  const quantRows = await prisma.quantAnalysis.findMany({
    where: { date: { gte: day, lt: next } },
    select: { stockId: true, price: true, sessionDate: true, stock: { select: { ticker: true } } },
  });

  // Only the stocks this run actually touched — the universe is ~120 names but a given
  // run's worklist can be a subset, and loading bars for names with no quant row would
  // be noise in a report about what happened.
  const stockIds = [...new Set(quantRows.map((q) => q.stockId))];

  const bars = stockIds.length
    ? await prisma.priceBar.findMany({
        where: { stockId: { in: stockIds }, date: { gte: barsFrom, lte: day } },
        select: { stockId: true, date: true, close: true },
      })
    : [];

  const positionSelect = {
    stockId: true,
    strategy: true,
    status: true,
    entryDate: true,
    exitDate: true,
    exitReason: true,
    qty: true,
    entryPrice: true,
    exitPrice: true,
    stock: { select: { ticker: true } },
  } as const;

  const [opened, closed, orders] = await Promise.all([
    prisma.simPosition.findMany({ where: { entryDate: { gte: day, lt: next } }, select: positionSelect }),
    prisma.simPosition.findMany({ where: { exitDate: { gte: day, lt: next } }, select: positionSelect }),
    prisma.paperOrder.findMany({
      where: { submittedAt: { gte: day, lt: next } },
      select: {
        stockId: true,
        side: true,
        status: true,
        filledQty: true,
        submittedAt: true,
        stock: { select: { ticker: true } },
      },
    }),
  ]);

  const toPosition = (p: (typeof opened)[number]) => ({
    stockId: p.stockId,
    ticker: p.stock.ticker,
    strategy: p.strategy,
    status: p.status,
    entryDate: dayKey(p.entryDate),
    exitDate: p.exitDate ? dayKey(p.exitDate) : null,
    exitReason: p.exitReason,
    qty: p.qty,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
  });

  return {
    day: dayKey(day),
    // The column is `Json?`; the shape is owned by the paper stage that writes it.
    run: (review?.paperRun as PaperRunLog | null) ?? null,
    reviewStatus: review?.status ?? null,
    quant: quantRows.map((q) => ({
      stockId: q.stockId,
      ticker: q.stock.ticker,
      price: q.price,
      sessionDate: q.sessionDate ? dayKey(q.sessionDate) : null,
    })),
    bars: bars.map((b) => ({ stockId: b.stockId, date: dayKey(b.date), close: b.close })),
    opened: opened.map(toPosition),
    closed: closed.map(toPosition),
    orders: orders.map((o) => ({
      stockId: o.stockId,
      ticker: o.stock.ticker,
      side: o.side,
      status: o.status,
      filledQty: o.filledQty,
      submittedAt: o.submittedAt.toISOString(),
    })),
  };
}

async function main() {
  const { day, days, json } = parseArgs(process.argv.slice(2));

  let end: Date;
  if (day) {
    end = new Date(`${day}T00:00:00.000Z`);
  } else {
    const latest = await prisma.dailyReview.findFirst({ orderBy: { date: "desc" }, select: { date: true } });
    if (!latest) {
      console.error("No DailyReview rows exist — nothing to explain.");
      process.exit(1);
    }
    end = startOfUtcDay(latest.date);
  }

  const results = [];
  for (let i = days - 1; i >= 0; i--) {
    results.push(explainDay(await loadDay(new Date(end.getTime() - i * DAY_MS))));
  }

  if (json) {
    console.log(JSON.stringify(days === 1 ? results[0] : results, null, 2));
  } else {
    console.log(results.map(formatDayExplanation).join("\n\n"));
  }

  // Exit non-zero on a `fail`, so this is usable as a check and not only as a report.
  const failed = results.some((r) => r.disagreements.some((g) => g.severity === "fail"));
  process.exit(failed ? 1 : 0);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
