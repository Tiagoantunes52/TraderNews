// Pure alert-detection helpers. Each returns an AlertDraft when a watchable
// condition is met, or null otherwise. Side-effect free so they can be unit
// tested independently of the pipeline and database.

export type AlertType =
  | "SIGNAL_CHANGE"
  | "VELOCITY_SPIKE"
  | "RSI_EXTREME"
  | "INSIDER_CLUSTER_BUY"
  | "INSIDER_FLOW_SHIFT"
  | "INSIDER_CSUITE_BUY"
  // Account / trading-health alerts (issue #56) — not tied to a single stock.
  | "ACCOUNT_DRAWDOWN"
  | "ORDER_FAILURES"
  | "BROKER_UNREACHABLE"
  | "STALE_PIPELINE"
  | "MISSED_PAPER_DAYS";

export type AlertDraft = {
  type: AlertType;
  title: string;
  message: string;
  value: number | null;
};

// The ONLY per-stock alert types emailed to watchers: open-market insider buys.
// Every other per-stock alert (signal change, news spike, RSI extreme, and the
// bidirectional insider flow-shift) is still detected and persisted — so it shows in
// the dashboard's "Recent alerts" feed — but proved low-signal as an inbox alert.
// (Account / trading-health alerts are a separate admin path, unaffected by this.)
export const EMAIL_ALLOWED_ALERT_TYPES: ReadonlySet<AlertType> = new Set<AlertType>([
  "INSIDER_CLUSTER_BUY",
  "INSIDER_CSUITE_BUY",
]);

export const VELOCITY_SPIKE_THRESHOLD = 2.5;

const SIGNAL_RANK: Record<string, number> = {
  STRONG_SELL: 0,
  SELL: 1,
  NEUTRAL: 2,
  BUY: 3,
  STRONG_BUY: 4,
};

export function humanizeSignal(signal: string): string {
  return signal
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Fires when a stock's combined signal moves to a different category
 * (e.g. NEUTRAL → BUY). Requires a known previous signal — the first-ever
 * estimate doesn't count as a "change".
 */
export function detectSignalChange(
  ticker: string,
  prevSignal: string | null | undefined,
  newSignal: string
): AlertDraft | null {
  if (!prevSignal || prevSignal === newSignal) return null;
  const prevRank = SIGNAL_RANK[prevSignal];
  const newRank = SIGNAL_RANK[newSignal];
  if (prevRank == null || newRank == null) return null;

  const upgraded = newRank > prevRank;
  const arrow = upgraded ? "📈" : "📉";
  const direction = upgraded ? "upgraded" : "downgraded";
  return {
    type: "SIGNAL_CHANGE",
    title: `${ticker} ${direction} to ${humanizeSignal(newSignal)}`,
    message: `${arrow} ${ticker} signal moved from ${humanizeSignal(prevSignal)} to ${humanizeSignal(
      newSignal
    )}.`,
    value: null,
  };
}

/**
 * Today's coverage against the daily average over a trailing window.
 *
 * BOTH counts must be measured the same way. Until 2026-09-07 they were not: the
 * numerator was an uncapped `ArticleStock` count and the denominator was
 * `Sentiment.articleCount`, the post-slice count of what the LLM was shown, capped at
 * 10. That pinned the divisor at ~1.43/day for nine names in ten, so 56.6% of rows read
 * above the 2.5x threshold and `VELOCITY_SPIKE` became 64% of the entire alert stream.
 * A ratio is only meaningful when its two sides are the same unit, which is the whole
 * reason this is a function rather than an expression at the call site.
 *
 * Returns null when the window is empty — no baseline means no ratio, not a spike.
 */
export function newsVelocityRatio(
  last24hCount: number,
  windowCount: number,
  windowDays: number
): number | null {
  if (!Number.isFinite(last24hCount) || !Number.isFinite(windowCount) || windowDays <= 0) return null;
  if (windowCount <= 0) return null;
  return last24hCount / (windowCount / windowDays);
}

/**
 * Fires when article velocity (today's count vs. recent average) meets or
 * exceeds the threshold — an unusual surge in coverage.
 */
export function detectVelocitySpike(
  ticker: string,
  ratio: number | null | undefined,
  threshold: number = VELOCITY_SPIKE_THRESHOLD
): AlertDraft | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio < threshold) return null;
  return {
    type: "VELOCITY_SPIKE",
    title: `${ticker} news spike`,
    message: `📰 ${ticker} news volume is ${ratio.toFixed(1)}× its recent average.`,
    value: ratio,
  };
}

/**
 * Fires when RSI crosses into oversold (<30) or overbought (>70) territory.
 * Requires a known previous RSI so we only alert on the transition, not on
 * every run while the stock sits in the zone.
 */
export function detectRsiCross(
  ticker: string,
  prevRsi: number | null | undefined,
  newRsi: number | null | undefined
): AlertDraft | null {
  if (newRsi == null || prevRsi == null) return null;

  if (newRsi < 30 && prevRsi >= 30) {
    return {
      type: "RSI_EXTREME",
      title: `${ticker} oversold`,
      message: `🟢 ${ticker} RSI fell to ${newRsi.toFixed(0)} — oversold (below 30).`,
      value: newRsi,
    };
  }
  if (newRsi > 70 && prevRsi <= 70) {
    return {
      type: "RSI_EXTREME",
      title: `${ticker} overbought`,
      message: `🔴 ${ticker} RSI rose to ${newRsi.toFixed(0)} — overbought (above 70).`,
      value: newRsi,
    };
  }
  return null;
}

// ── Account / trading-health alerts (issue #56) ──────────────────────────────
// These watch the *trading account*, not a stock: drawdown breaches, order
// rejections / fill failures, broker reachability, and pipeline freshness. They
// carry no ticker (the Alert row's stockId is null) and notify admins, not the
// per-stock watchers. Pure builders so the pipeline stays a thin persistence layer.

const pct = (frac: number): string => `${(frac * 100).toFixed(1)}%`;

/**
 * Fires when a book's drawdown from its peak equity meets/exceeds `threshold`
 * (the kill-switch level) — capital protection has tripped and new buys are halted.
 */
export function detectDrawdownBreach(
  book: string,
  drawdown: number,
  threshold: number
): AlertDraft | null {
  if (!Number.isFinite(drawdown) || drawdown < threshold) return null;
  return {
    type: "ACCOUNT_DRAWDOWN",
    title: `${book} drawdown ${pct(drawdown)}`,
    message: `🛑 ${book} is down ${pct(drawdown)} from its peak (kill-switch at ${pct(
      threshold
    )}). New buys are halted until it recovers.`,
    value: drawdown,
  };
}

/**
 * Fires when one or more broker orders failed to submit / fill this run — order
 * rejections, fractional-stop rejects, or partial-fill failures the stage logged.
 */
export function detectOrderFailures(failures: number, threshold = 1): AlertDraft | null {
  if (!Number.isFinite(failures) || failures < threshold) return null;
  return {
    type: "ORDER_FAILURES",
    title: `${failures} order failure${failures === 1 ? "" : "s"}`,
    message: `⚠️ ${failures} broker order${failures === 1 ? "" : "s"} failed this run (rejections / fill failures). Check the trading account.`,
    value: failures,
  };
}

/** Fires when the broker (Alpaca) is unreachable — the trading path is blind. */
export function detectBrokerUnreachable(book = "Alpaca"): AlertDraft {
  return {
    type: "BROKER_UNREACHABLE",
    title: `${book} unreachable`,
    message: `📡 Could not reach ${book} this run — orders, fills and account equity may be stale.`,
    value: null,
  };
}

/**
 * Fires when the freshest pipeline data is older than `maxAgeHours` (or missing) —
 * a stalled cron / data source means signals and equity marks are stale.
 */
/**
 * Dead-man's check for the paper stage: fires when one or more trading days
 * between the previous equity snapshot and today produced NO snapshot — i.e. the
 * near-close scheduler missed the whole trade window that day (July 2–3 2026:
 * GH-cron drift past the close + an early-close Friday the fixed crons can't hit).
 *
 * `tradingDays` (YYYY-MM-DD) should come from the broker calendar when available
 * so holidays don't false-alarm; without it, UTC weekdays approximate. Runs on the
 * day's FIRST successful paper run, so it reports yesterday's miss, not today's.
 */
export function detectMissedPaperDays(
  prevSnapshotDate: Date | null | undefined,
  today: Date,
  tradingDays?: string[] | null
): AlertDraft | null {
  if (prevSnapshotDate == null) return null; // no history yet — nothing to miss
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const missed: string[] = [];
  for (
    let d = new Date(Date.UTC(prevSnapshotDate.getUTCFullYear(), prevSnapshotDate.getUTCMonth(), prevSnapshotDate.getUTCDate() + 1));
    dayKey(d) < dayKey(today);
    d = new Date(d.getTime() + 86_400_000)
  ) {
    const isWeekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
    const isTradingDay = tradingDays != null ? tradingDays.includes(dayKey(d)) : isWeekday;
    if (isTradingDay) missed.push(dayKey(d));
  }
  if (missed.length === 0) return null;
  const source = tradingDays != null ? "broker calendar" : "weekday approximation — holidays may false-alarm";
  return {
    type: "MISSED_PAPER_DAYS",
    title: `Paper stage missed ${missed.length} trading day${missed.length === 1 ? "" : "s"}`,
    message: `📅 No equity snapshot was written on ${missed.join(", ")} (${source}). The near-close scheduler likely missed the trade window — check the cron runs.`,
    value: missed.length,
  };
}

export function detectStalePipeline(
  latestDataAt: Date | null | undefined,
  now: Date,
  maxAgeHours: number
): AlertDraft | null {
  const ageHours = latestDataAt == null ? Infinity : (now.getTime() - latestDataAt.getTime()) / 3_600_000;
  if (ageHours < maxAgeHours) return null;
  const ageLabel = Number.isFinite(ageHours) ? `${Math.floor(ageHours)}h old` : "missing";
  return {
    type: "STALE_PIPELINE",
    title: `Pipeline data ${ageLabel}`,
    message: `🕒 The freshest signal data is ${ageLabel} (threshold ${maxAgeHours}h). The pipeline may have stalled.`,
    value: Number.isFinite(ageHours) ? ageHours : null,
  };
}
