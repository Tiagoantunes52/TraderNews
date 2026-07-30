import type { DailyPrice } from "@/lib/tiingo-prices";

// Daily OHLCV bars → `PriceBar` rows. Pure: the callers (the quant stage going
// forward, the backfill script going backwards) do the I/O.
//
// The quant stage has always fetched a 60-day window and discarded it once the
// indicators were computed. Keeping it is what lets anything downstream ask
// "would this order have filled?" — a question decided by the next bar's open and
// low, neither of which `QuantAnalysis` records.

export type PriceBarRow = {
  stockId: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
};

export type BarRejection =
  /** A price was missing, non-finite, or ≤ 0. */
  | "INVALID_PRICE"
  /** high < low, or the close sat outside [low, high] — the bar contradicts itself. */
  | "INCONSISTENT_OHLC"
  /** Unparseable `date`. */
  | "INVALID_DATE"
  /** Dated at/after `before` — the session hadn't finished when this was fetched. */
  | "IN_PROGRESS";

export type BarConversion = {
  rows: PriceBarRow[];
  /** Count per reason. Surfaced by callers rather than swallowed: a source that starts
   *  failing validation is a data-quality regression, and silence is how the Yahoo
   *  adjusted/raw mix survived unnoticed for as long as it did. */
  rejected: Record<BarRejection, number>;
};

function emptyRejections(): Record<BarRejection, number> {
  return { INVALID_PRICE: 0, INCONSISTENT_OHLC: 0, INVALID_DATE: 0, IN_PROGRESS: 0 };
}

/** `YYYY-MM-DD` → UTC midnight, matching how every other date column is stored. */
export function barDate(date: string): Date | null {
  const d = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Why a bar is rejected rather than repaired.
 *
 * A bar whose `low` sits above its `close` is not a rounding artefact — it means the
 * four legs came from different adjustment bases (the defect the Yahoo adapter carried
 * until the fix alongside this module). Persisting it would poison exactly the
 * question these rows exist to answer, because a fill model reading `low <= stop`
 * concludes every such bar stopped out. Clamping would hide the corruption behind
 * plausible numbers; dropping keeps the corpus trustworthy and leaves a countable
 * trace. A dropped bar costs one session out of thousands — a wrong one costs the
 * conclusion.
 */
function validate(p: DailyPrice): BarRejection | null {
  const prices = [p.open, p.high, p.low, p.close];
  if (prices.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) return "INVALID_PRICE";
  if (!Number.isFinite(p.volume) || p.volume < 0) return "INVALID_PRICE";
  // `>` not `>=`: high === low === close is legitimate (a limit-up session, and how
  // CoinGecko's daily series reports every bar since it publishes no true O/H/L).
  if (p.high < p.low) return "INCONSISTENT_OHLC";
  if (p.close > p.high || p.close < p.low) return "INCONSISTENT_OHLC";
  if (p.open > p.high || p.open < p.low) return "INCONSISTENT_OHLC";
  return null;
}

/**
 * Convert an adapter's price window into insertable rows.
 *
 * `before` is an EXCLUSIVE upper bound and should be the current UTC midnight. The
 * stage runs minutes before the US close and crypto never closes at all, so the most
 * recent bar a provider returns is routinely an unfinished session. Rows are written
 * with `skipDuplicates`, so a partial bar persisted once would never be corrected —
 * it would sit in the record forever as if it were the settled session. Excluding it
 * costs a one-day lag that the next run closes, which is the cheaper mistake.
 */
export function toPriceBarRows(
  stockId: string,
  prices: DailyPrice[],
  source: string,
  before: Date
): BarConversion {
  const rows: PriceBarRow[] = [];
  const rejected = emptyRejections();

  for (const p of prices) {
    const date = barDate(p.date);
    if (date == null) {
      rejected.INVALID_DATE++;
      continue;
    }
    if (date.getTime() >= before.getTime()) {
      rejected.IN_PROGRESS++;
      continue;
    }
    const bad = validate(p);
    if (bad) {
      rejected[bad]++;
      continue;
    }
    rows.push({
      stockId,
      date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: p.volume,
      source,
    });
  }

  return { rows, rejected };
}

/** True when any bar was dropped for a reason other than the in-progress session. */
export function hasQualityRejections(rejected: Record<BarRejection, number>): boolean {
  return rejected.INVALID_PRICE > 0 || rejected.INCONSISTENT_OHLC > 0 || rejected.INVALID_DATE > 0;
}

/** Compact `"INVALID_PRICE=2, INCONSISTENT_OHLC=1"` for error strings; "" when clean. */
export function describeRejections(rejected: Record<BarRejection, number>): string {
  return (Object.entries(rejected) as [BarRejection, number][])
    .filter(([reason, n]) => n > 0 && reason !== "IN_PROGRESS")
    .map(([reason, n]) => `${reason}=${n}`)
    .join(", ");
}
