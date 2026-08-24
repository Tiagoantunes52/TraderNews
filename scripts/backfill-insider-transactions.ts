import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { finnhubInsiderSource, isInsiderEligible } from "../src/lib/insider-sources";

// Backfill historical insider (Form 4) transactions across the whole universe.
//
// The insider stage's rolling 90-day window has accumulated 1,821 transactions over
// only 17 stocks — far too thin a cross-section to judge the insider event book's
// thesis (a 20-60 day drift after cluster buys) against. Finnhub serves per-symbol
// history in one call, so a five-year backfill of ~100 names is ~100 requests.
//
// Finnhub EXPLICITLY, not the source chain: EDGAR walks one HTTP fetch per filing
// and caps at INSIDER_EDGAR_MAX_FILINGS — fine for a daily window, hopeless for
// five years. dedupKey is source-agnostic (ticker/name/date/code/shares/price), so
// rows the daily stage later re-fetches via either source land as no-ops.
//
// Idempotent via the unique dedupKey + skipDuplicates. Writes ONLY raw
// InsiderTransaction rows — summaries and alerts stay the daily stage's job, and
// its cold-start rule (no previous summary -> no alert) is untouched.
//
// Usage:
//   npx tsx scripts/backfill-insider-transactions.ts --dry-run
//   npx tsx scripts/backfill-insider-transactions.ts
//   npx tsx scripts/backfill-insider-transactions.ts --from=2021-07-30 --tickers=AAPL,MSFT

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

// PriceBar's corpus start — insider events before the first bar can't be studied.
const DEFAULT_FROM = "2021-07-30";
// Finnhub free tier: 60 req/min. One lane at ~1.1s spacing stays inside it.
const INTER_REQUEST_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv: string[]) {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    from: new Date(`${get("from") ?? DEFAULT_FROM}T00:00:00.000Z`),
    tickers: get("tickers")?.split(",").filter(Boolean) ?? null,
    dryRun: argv.includes("--dry-run"),
  };
}

async function main() {
  const { from, tickers, dryRun } = parseArgs(process.argv.slice(2));
  if (!finnhubInsiderSource.configured()) throw new Error("FINNHUB_API_KEY not set");

  const stocks = (
    await prisma.stock.findMany({
      where: {
        AND: [{ NOT: { ticker: { contains: "." } } }, { NOT: { ticker: { endsWith: "-USD" } } }],
        ...(tickers ? { ticker: { in: tickers } } : {}),
      },
      select: { id: true, ticker: true },
      orderBy: { ticker: "asc" },
    })
  ).filter((s) => isInsiderEligible(s.ticker));

  console.log(
    `Backfilling insider transactions for ${stocks.length} names from ${from.toISOString().slice(0, 10)}` +
      `${dryRun ? " (dry run)" : ""}`
  );

  let total = 0;
  let written = 0;
  for (const stock of stocks) {
    try {
      const txns = await finnhubInsiderSource.fetch(stock.ticker, from);
      total += txns.length;
      const earliest = txns.reduce<Date | null>(
        (a, t) => (a == null || t.transactionDate < a ? t.transactionDate : a),
        null
      );
      let inserted = 0;
      if (!dryRun && txns.length > 0) {
        const res = await prisma.insiderTransaction.createMany({
          data: txns.map((t) => ({
            stockId: stock.id,
            insiderName: t.insiderName,
            officerTitle: t.officerTitle,
            isOfficer: t.isOfficer,
            isDirector: t.isDirector,
            isTenPctOwner: t.isTenPctOwner,
            transactionCode: t.transactionCode,
            txnType: t.txnType,
            isPlanned: t.isPlanned,
            isDerivative: t.isDerivative,
            shares: t.shares,
            price: t.price,
            value: t.value,
            sharesAfter: t.sharesAfter,
            pctHoldingsChg: t.pctHoldingsChg,
            transactionDate: t.transactionDate,
            filingDate: t.filingDate,
            accessionId: t.accessionId,
            dedupKey: t.dedupKey,
          })),
          skipDuplicates: true,
        });
        inserted = res.count;
        written += inserted;
      }
      console.log(
        `  ${stock.ticker.padEnd(6)} ${String(txns.length).padStart(5)} txns` +
          `${earliest ? `  earliest ${earliest.toISOString().slice(0, 10)}` : ""}` +
          `${dryRun ? "" : `  inserted ${inserted}`}`
      );
    } catch (e) {
      console.error(`  ${stock.ticker.padEnd(6)} FAILED: ${String(e)}`);
    }
    await sleep(INTER_REQUEST_MS);
  }
  console.log(`\n${total} transactions fetched${dryRun ? "" : `, ${written} new rows written`}.`);
}

main().finally(() => prisma.$disconnect());
