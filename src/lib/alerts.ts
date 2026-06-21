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
  | "STALE_PIPELINE";

export type AlertDraft = {
  type: AlertType;
  title: string;
  message: string;
  value: number | null;
};

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
