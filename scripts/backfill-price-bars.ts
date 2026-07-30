import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDailyPrices, DEFAULT_PRICE_SOURCES, type PriceSource } from "../src/lib/price-sources";
import { toPriceBarRows, describeRejections, type PriceBarRow } from "../src/lib/price-bars";
import { isPaperTradeEligible } from "../src/lib/paper-trading";
import { processWithBudget } from "../src/lib/concurrency";

// Backfill historical daily OHLCV into PriceBar.
//
// A SCRIPT, not a pipeline stage. Stages run on serverless invocations with a ~300s
// ceiling (STAGE_BUDGET_MS is 240s) and are built to be resumed across many runs; this
// is a one-off that wants to run to completion in a single pass and be re-runnable by
// hand. It also writes years of history, which no stage should ever do implicitly.
//
// Cost is far lower than it looks: every adapter takes a `since` and returns the whole
// range in ONE response, so a five-year backfill of the US universe is ~119 HTTP
// requests, not 119 x 5 years of them.
//
// Idempotent by construction. PriceBar's primary key is (stockId, date) and every
// insert uses skipDuplicates, so re-running costs nothing and resumes wherever it left
// off. That also means an already-stored bar is NEVER rewritten — use --rewrite to
// replace a ticker's range when a bar was written on a bad adjustment basis.
//
// Usage:
//   npx tsx scripts/backfill-price-bars.ts --dry-run          (start here)
//   npx tsx scripts/backfill-price-bars.ts
//   npx tsx scripts/backfill-price-bars.ts --verify
//   npx tsx scripts/backfill-price-bars.ts --tickers=AAPL,SPY --rewrite

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const DEFAULT_YEARS = 5;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DEADLINE_MIN = 15;
// Yahoo's rate limit is undocumented and IP-enforced. Two lanes at ~2 req/s each is
// well inside anything observed, and the whole job is ~119 requests regardless.
const INTER_REQUEST_MS = 500;
const RETRY_DELAYS_MS = [2_000, 8_000, 32_000];

type Args = {
  from: Date;
  tickers: string[] | null;
  concurrency: number;
  source: string | null;
  dryRun: boolean;
  verify: boolean;
  rewrite: boolean;
  deadlineMin: number;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const has = (name: string) => argv.includes(`--${name}`);

  const fromRaw = get("from");
  const from = fromRaw
    ? new Date(`${fromRaw}T00:00:00.000Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear() - DEFAULT_YEARS, new Date().getUTCMonth(), new Date().getUTCDate()));
  if (Number.isNaN(from.getTime())) throw new Error(`--from must be YYYY-MM-DD, got "${fromRaw}"`);

  return {
    from,
    tickers: get("tickers")?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) ?? null,
    concurrency: Number(get("concurrency")) || DEFAULT_CONCURRENCY,
    source: get("source")?.toLowerCase() ?? null,
    dryRun: has("dry-run"),
    verify: has("verify"),
    rewrite: has("rewrite"),
    deadlineMin: Number(get("deadline-min")) || DEFAULT_DEADLINE_MIN,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient-looking failures worth retrying: rate limits and upstream unavailability. */
function isRetryable(e: unknown): boolean {
  const msg = String(e);
  return /\b(429|500|502|503|504)\b/.test(msg) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(msg);
}

async function fetchWithBackoff(ticker: string, from: Date, sources: PriceSource[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await getDailyPrices(ticker, from, sources);
      // getDailyPrices swallows per-source failures into `errors` and returns empty
      // rather than throwing, so a rate-limited run looks like "no data". Retry when
      // nothing came back AND a recorded error looks transient — otherwise a 429 storm
      // would silently write zero bars for half the universe.
      if (res.prices.length === 0 && res.errors.some(isRetryable) && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return res;
    } catch (e) {
      if (!isRetryable(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function resolveSources(name: string | null): PriceSource[] {
  if (!name) return DEFAULT_PRICE_SOURCES;
  const picked = DEFAULT_PRICE_SOURCES.filter((s) => s.name.toLowerCase() === name);
  if (picked.length === 0) {
    throw new Error(`--source must be one of ${DEFAULT_PRICE_SOURCES.map((s) => s.name).join(", ")}`);
  }
  return picked;
}

async function loadStocks(args: Args) {
  const stocks = await prisma.stock.findMany({ select: { id: true, ticker: true } });
  // US equities only. The other adapters (CoinGecko has no true O/H/L; international
  // listings carry currency and holiday-calendar complications) deserve their own pass
  // once something actually consumes them.
  const eligible = stocks.filter((s) => isPaperTradeEligible(s.ticker));
  return args.tickers ? eligible.filter((s) => args.tickers!.includes(s.ticker)) : eligible;
}

async function backfill(args: Args) {
  const sources = resolveSources(args.source);
  const stocks = await loadStocks(args);
  // Exclusive upper bound, same rule the quant stage uses: never persist the session
  // that hasn't finished yet.
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  console.log(
    `${args.dryRun ? "[DRY RUN] " : ""}Backfilling ${stocks.length} US tickers from ${args.from.toISOString().slice(0, 10)} ` +
      `via ${sources.map((s) => s.name).join(" → ")} at concurrency ${args.concurrency}`
  );
  if (args.rewrite && !args.dryRun) console.log("--rewrite: existing bars in range will be DELETED and re-inserted");

  let inserted = 0;
  let wouldInsert = 0;
  let tickersWithData = 0;
  const problems: string[] = [];

  const outcome = await processWithBudget(
    stocks,
    async (stock) => {
      try {
        await sleep(INTER_REQUEST_MS);
        const { prices, provider, errors } = await fetchWithBackoff(stock.ticker, args.from, sources);
        if (prices.length === 0 || !provider) {
          problems.push(`${stock.ticker}: no data${errors.length ? ` (${errors[0]})` : ""}`);
          return;
        }

        const { rows, rejected } = toPriceBarRows(stock.id, prices, provider, todayUTC);
        const dropped = describeRejections(rejected);
        if (dropped) problems.push(`${stock.ticker} (${provider}): ${dropped}`);
        if (rows.length === 0) return;
        tickersWithData++;

        if (args.dryRun) {
          wouldInsert += rows.length;
          const span = `${rows[0].date.toISOString().slice(0, 10)}..${rows[rows.length - 1].date.toISOString().slice(0, 10)}`;
          console.log(`  ${stock.ticker.padEnd(6)} ${String(rows.length).padStart(5)} bars  ${span}  ${provider}`);
          return;
        }

        if (args.rewrite) {
          await prisma.priceBar.deleteMany({
            where: { stockId: stock.id, date: { gte: rows[0].date, lte: rows[rows.length - 1].date } },
          });
        }
        // Chunked: a five-year window is ~1,250 rows per ticker, and a single
        // createMany of that size is a needlessly large statement.
        for (let i = 0; i < rows.length; i += 500) {
          const chunk: PriceBarRow[] = rows.slice(i, i + 500);
          const res = await prisma.priceBar.createMany({ data: chunk, skipDuplicates: true });
          inserted += res.count;
        }
      } catch (e) {
        problems.push(`${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: args.concurrency, deadline: Date.now() + args.deadlineMin * 60_000 }
  );

  console.log(
    `\n${args.dryRun ? "Would insert" : "Inserted"} ${args.dryRun ? wouldInsert : inserted} bars ` +
      `across ${tickersWithData} tickers (${outcome.processed} processed, ${outcome.remaining} not reached).`
  );
  if (!outcome.done) console.log(`Budget exhausted — re-run to resume (already-stored bars are skipped).`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
    if (problems.length > 40) console.log(`  … ${problems.length - 40} more`);
  }
}

/**
 * Cross-check backfilled bars against the closes the app recorded live.
 *
 * PriceBar and QuantAnalysis.price come from the same adapters, so where they describe
 * the same session they should agree to floating-point noise. The check is which
 * SESSION a QuantAnalysis row describes, and the answer is not the one its own date
 * suggests.
 *
 * The quant stage stamps `date` with now() and stores the last close in the window it
 * fetched. It runs off the 3-hourly pipeline cron, and the per-day dedup means the
 * first invocation after UTC midnight does the work — observed at ~02:15-02:50 UTC.
 * At that hour the most recent completed session is the PREVIOUS day's. So a
 * QuantAnalysis row dated D almost always carries the close of session D-1, and a
 * naive same-day comparison is misaligned by one session by construction (it reported
 * 82% disagreement on a corpus that turned out to match to the cent).
 *
 * Rather than hard-code the offset, score each row against both the same-day bar and
 * the previous session's and report which matched. That keeps working if the schedule
 * moves — and the offset distribution is itself worth seeing, because everything
 * downstream that treats QuantAnalysis.date as the observation date inherits it.
 *
 * Rows matching NEITHER are the real signal. A few are expected where a corporate
 * action landed after the QuantAnalysis row was written: the stored close is
 * unadjusted-as-of-then, the backfilled bar is adjusted-as-of-now. Broad disagreement
 * would mean the backfill pulled a different series than the app has been trading
 * against, and every conclusion drawn from these bars would be about the wrong asset.
 */
async function verify(args: Args) {
  const stocks = await loadStocks(args);
  const TOLERANCE = 0.005; // 0.5% — absorbs rounding, catches a wrong series

  let compared = 0;
  let sameDay = 0;
  let prevSession = 0;
  const unexplained: { ticker: string; date: string; bar: number | null; prev: number | null; quant: number; diff: number }[] = [];

  for (const stock of stocks) {
    const [bars, quants] = await Promise.all([
      prisma.priceBar.findMany({ where: { stockId: stock.id }, orderBy: { date: "asc" }, select: { date: true, close: true } }),
      prisma.quantAnalysis.findMany({
        where: { stockId: stock.id, price: { not: null } },
        select: { date: true, price: true },
      }),
    ]);
    if (bars.length === 0) continue;
    const days = bars.map((b) => b.date.toISOString().slice(0, 10));
    const indexByDay = new Map(days.map((d, i) => [d, i]));

    for (const q of quants) {
      if (q.price == null || q.price <= 0) continue;
      const day = q.date.toISOString().slice(0, 10);

      // Same-day bar if the session exists, plus whatever session preceded that day.
      const sameIdx = indexByDay.get(day);
      let prevIdx: number | null = null;
      if (sameIdx != null) prevIdx = sameIdx > 0 ? sameIdx - 1 : null;
      else {
        // No bar on that calendar day (weekend/holiday stamp): walk back to the last
        // session strictly before it.
        let lo = 0;
        let hi = days.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (days[mid] < day) {
            found = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        prevIdx = found >= 0 ? found : null;
      }
      const sameClose = sameIdx != null ? bars[sameIdx].close : null;
      const prevClose = prevIdx != null ? bars[prevIdx].close : null;
      if (sameClose == null && prevClose == null) continue;

      compared++;
      const dSame = sameClose != null ? Math.abs(sameClose - q.price) / q.price : Infinity;
      const dPrev = prevClose != null ? Math.abs(prevClose - q.price) / q.price : Infinity;

      if (dPrev <= TOLERANCE) prevSession++;
      else if (dSame <= TOLERANCE) sameDay++;
      else {
        unexplained.push({
          ticker: stock.ticker,
          date: day,
          bar: sameClose,
          prev: prevClose,
          quant: q.price,
          diff: Math.min(dSame, dPrev),
        });
      }
    }
  }

  const bad = unexplained.length;
  const pct = compared > 0 ? (bad / compared) * 100 : 0;
  console.log(`Compared ${compared} QuantAnalysis rows against bars across ${stocks.length} tickers.`);
  console.log(`  matched the PREVIOUS session's close: ${prevSession} (${((prevSession / Math.max(compared, 1)) * 100).toFixed(1)}%)`);
  console.log(`  matched the SAME day's close:         ${sameDay} (${((sameDay / Math.max(compared, 1)) * 100).toFixed(1)}%)`);
  console.log(`  matched neither beyond ${(TOLERANCE * 100).toFixed(1)}%:        ${bad} (${pct.toFixed(2)}%)`);

  // Rolled up per ticker, because concentration is the whole diagnosis: a corporate
  // action hits one name on every day of its history (and at a near-constant ratio),
  // while a genuinely wrong series is spread thin across many names.
  if (unexplained.length > 0) {
    const byTicker = new Map<string, { n: number; ratios: number[] }>();
    for (const u of unexplained) {
      const entry = byTicker.get(u.ticker) ?? { n: 0, ratios: [] };
      entry.n++;
      const ref = u.prev ?? u.bar;
      if (ref != null && ref > 0) entry.ratios.push(u.quant / ref);
      byTicker.set(u.ticker, entry);
    }
    console.log(`\nUnexplained rows by ticker (${byTicker.size} name(s)):`);
    for (const [ticker, e] of [...byTicker].sort((a, b) => b[1].n - a[1].n)) {
      const sorted = [...e.ratios].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
      // A tight ratio across many days is a corporate action; a scattered one is not.
      const spread = sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] : 0;
      console.log(
        `  ${ticker.padEnd(6)} ${String(e.n).padStart(4)} rows  quant/bar median ${median.toFixed(3)}  spread ${spread.toFixed(3)}`
      );
    }
  }

  if (compared === 0) {
    console.log("\nNothing to compare — run the backfill first.");
  } else if (pct > 5) {
    console.log(`\nFAIL: >5% disagreement. Expect a few split names; this is too broad to be corporate actions.`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK: within the range explainable by post-hoc corporate-action adjustment.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.verify) await verify(args);
    else await backfill(args);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("BACKFILL_ERROR:", e);
  process.exit(1);
});
