import { db } from "@/lib/db";
import { getEarningsCalendar } from "@/lib/finnhub";
import { getEtfProfile } from "@/lib/alphavantage";
import { isEtf } from "@/lib/etf";
import { getDailyPrices } from "@/lib/price-sources";
import { calcSMA, calcRSI, calcVolatility, calcMomentum, calcVolumeRatio, calcQuantScore, calcMACD, calcBollingerBands, calcATR } from "@/lib/indicators";
import { SECTOR_ETF } from "@/lib/sectors";
import { toPriceBarRows, describeRejections } from "@/lib/price-bars";
import { processWithBudget } from "@/lib/concurrency";
import { STAGE_BUDGET_MS, dateStr, startOfUtcDay, universeWhere, type BatchStageResult, type StageOptions } from "./shared";

const QUANT_CONCURRENCY = Number(process.env.PIPELINE_QUANT_CONCURRENCY) || 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Stage 3: Quant ──────────────────────────────────────────────────────────
//
// Price-history indicators for each watched stock lacking today's row. Shared
// benchmarks (SPY, earnings calendar, sector ETFs) are fetched once per
// invocation; per-stock work runs with bounded concurrency under a time budget.
// ETF profiles (weekly-refreshed) are topped up best-effort if budget remains.
export async function runQuantStage(opts: StageOptions = {}): Promise<BatchStageResult> {
  const errors: string[] = [];
  let created = 0;

  const to = new Date();
  const todayUTC = startOfUtcDay(to);
  const from60 = new Date(to.getTime() - 60 * 24 * 60 * 60 * 1000);
  const deadline = Date.now() + (opts.budgetMs ?? STAGE_BUDGET_MS);

  // The full universe (for benchmark/sector setup), and the US subset.
  const stocks = await db.stock.findMany({ where: universeWhere(), select: { id: true, ticker: true } });
  const usStocks = stocks.filter((s) => !s.ticker.includes(".") && !s.ticker.endsWith("-USD"));

  // SPY benchmark for relative strength
  let spyChange7d: number | null = null;
  try {
    const { prices: spyPrices } = await getDailyPrices("SPY", from60);
    if (spyPrices.length >= 8) spyChange7d = calcMomentum(spyPrices.map((p) => p.close), 7);
  } catch {
    /* benchmark failure doesn't block per-stock analysis */
  }

  // Next 30-day earnings calendar (one API call for all stocks)
  const earningsTo = new Date(to.getTime() + 30 * 24 * 60 * 60 * 1000);
  const earningsByTicker = new Map<string, Date>();
  try {
    const calendar = await getEarningsCalendar(dateStr(to), dateStr(earningsTo));
    for (const event of calendar) {
      if (!earningsByTicker.has(event.symbol)) {
        earningsByTicker.set(event.symbol, new Date(event.date));
      }
    }
  } catch {
    /* earnings fetch failure doesn't block quant */
  }

  // Sector ETF 7-day returns for the US watchlist
  const neededEtfs = new Set<string>();
  for (const s of usStocks) {
    const etf = SECTOR_ETF[s.ticker];
    if (etf) neededEtfs.add(etf);
  }
  const sectorChange7d = new Map<string, number>();
  for (const etf of neededEtfs) {
    try {
      const { prices: etfPrices } = await getDailyPrices(etf, from60);
      if (etfPrices.length >= 8) {
        const change = calcMomentum(etfPrices.map((p) => p.close), 7);
        if (change != null) sectorChange7d.set(etf, change);
      }
    } catch {
      /* sector ETF failure doesn't block */
    }
  }

  const worklist = await db.stock.findMany({
    where: { ...universeWhere(), quantAnalyses: { none: { date: { gte: todayUTC } } } },
    select: { id: true, ticker: true },
  });

  const outcome = await processWithBudget(
    worklist,
    async (stock) => {
      try {
        const { prices, provider, errors: priceErrors } = await getDailyPrices(stock.ticker, from60);
        errors.push(...priceErrors);

        // Persist the raw window before deriving anything from it. This is the same
        // 60 days the indicators below consume and the stage has always thrown away;
        // keeping it is what lets a fill model ask whether an order would have filled.
        // Append-only (skipDuplicates on the composite PK), so re-runs are free and an
        // already-stored bar is never rewritten — correcting one is the backfill
        // script's job, since it needs to know which `source` wrote it.
        if (prices.length > 0 && provider) {
          const { rows, rejected } = toPriceBarRows(stock.id, prices, provider, todayUTC);
          const dropped = describeRejections(rejected);
          // A bar failing validation means the provider handed back something
          // self-contradictory (mixed adjustment bases produce exactly this). Record
          // it — it's a data-quality regression, not a per-ticker hiccup.
          if (dropped) errors.push(`Price bars rejected for ${stock.ticker} (${provider}): ${dropped}`);
          if (rows.length > 0) {
            await db.priceBar.createMany({ data: rows, skipDuplicates: true });
          }
        }

        if (prices.length < 2) return; // insufficient data — attempted, skip gracefully

        const closes = prices.map((p) => p.close);
        const volumes = prices.map((p) => p.volume);
        const highs = prices.map((p) => p.high);
        const lows = prices.map((p) => p.low);
        const isCrypto = stock.ticker.endsWith("-USD");

        const price = closes[closes.length - 1];
        const open = prices[prices.length - 1].open;
        const change1d = calcMomentum(closes, 1);
        const change7d = calcMomentum(closes, 7);
        const change30d = calcMomentum(closes, 30);
        const rsi14 = calcRSI(closes);
        const sma20 = calcSMA(closes, 20);
        const sma50 = calcSMA(closes, 50);
        const volatility30d = calcVolatility(closes);
        const volumeRatio10d = calcVolumeRatio(volumes);

        const macdResult = calcMACD(closes);
        const macdHistogram = macdResult?.histogram ?? null;
        const high60d = Math.max(...closes);
        const low60d = Math.min(...closes);
        const priceVs60dHigh = price != null ? ((price - high60d) / high60d) * 100 : null;
        const priceVs60dLow = price != null ? ((price - low60d) / low60d) * 100 : null;
        const relativeStr7d = change7d != null && spyChange7d != null ? change7d - spyChange7d : null;

        const bollingerResult = calcBollingerBands(closes);
        const bollingerWidth = bollingerResult?.width ?? null;
        const bollingerPctB = bollingerResult?.percentB ?? null;

        const atr14 = calcATR(highs, lows, closes);
        const atrPct = atr14 != null && price != null ? (atr14 / price) * 100 : null;

        // Earnings date proximity (skip crypto — Finnhub only covers equities)
        const nextEarningsDate = !isCrypto ? earningsByTicker.get(stock.ticker) ?? null : null;
        const daysToEarnings = nextEarningsDate
          ? Math.ceil((nextEarningsDate.getTime() - to.getTime()) / (24 * 60 * 60 * 1000))
          : null;

        // Sector-relative strength (US equities only)
        const sectorEtf = SECTOR_ETF[stock.ticker];
        const sectorReturn = sectorEtf ? sectorChange7d.get(sectorEtf) ?? null : null;
        const relativeStrSector7d = change7d != null && sectorReturn != null ? change7d - sectorReturn : null;

        const score = calcQuantScore({ rsi14, change7d, sma20, price, volatility30d, volumeRatio10d, isCrypto, macdHistogram, relativeStr7d, bollingerPctB });

        await db.quantAnalysis.create({
          data: { stockId: stock.id, price, open, change1d, change7d, change30d, rsi14, sma20, sma50, volatility30d, volumeRatio10d, macdHistogram, priceVs60dHigh, priceVs60dLow, relativeStr7d, bollingerWidth, bollingerPctB, atr14, atrPct, nextEarningsDate, daysToEarnings, relativeStrSector7d, score },
        });

        created++;
      } catch (e) {
        errors.push(`Quant failed for ${stock.ticker}: ${String(e)}`);
      }
    },
    { concurrency: opts.concurrency ?? QUANT_CONCURRENCY, deadline }
  );

  // ETF profiles — holdings, sector weights, expense ratio (Alpha Vantage).
  // Refreshed at most weekly; best-effort, only while budget remains.
  if (process.env.ALPHAVANTAGE_API_KEY) {
    const staleBefore = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    for (const stock of stocks.filter((s) => isEtf(s.ticker))) {
      if (Date.now() >= deadline) break;
      try {
        const existing = await db.etfProfile.findUnique({
          where: { stockId: stock.id },
          select: { updatedAt: true },
        });
        if (existing && existing.updatedAt > staleBefore) continue; // still fresh

        const profile = await getEtfProfile(stock.ticker);
        if (!profile) continue;

        const data = {
          netAssets: profile.netAssets,
          expenseRatio: profile.expenseRatio,
          dividendYield: profile.dividendYield,
          inceptionDate: profile.inceptionDate ? new Date(profile.inceptionDate) : null,
          sectors: profile.sectors,
          holdings: profile.holdings,
        };
        await db.etfProfile.upsert({
          where: { stockId: stock.id },
          create: { stockId: stock.id, ...data },
          update: data,
        });

        await sleep(1000);
      } catch (e) {
        errors.push(`ETF profile failed for ${stock.ticker}: ${String(e)}`);
      }
    }
  }

  return {
    stage: "quant",
    attempted: outcome.processed,
    created,
    remaining: outcome.remaining,
    done: outcome.done,
    alerts: 0,
    errors,
  };
}
