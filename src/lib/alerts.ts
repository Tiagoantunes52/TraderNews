// Pure alert-detection helpers. Each returns an AlertDraft when a watchable
// condition is met, or null otherwise. Side-effect free so they can be unit
// tested independently of the pipeline and database.

export type AlertType = "SIGNAL_CHANGE" | "VELOCITY_SPIKE" | "RSI_EXTREME";

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
