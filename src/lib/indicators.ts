// All functions expect closes in chronological order (oldest first).

export function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder's RSI
export function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // Seed with simple average over first `period` changes
  let avgGain =
    changes.slice(0, period).filter((c) => c > 0).reduce((a, b) => a + b, 0) / period;
  let avgLoss =
    changes.slice(0, period).filter((c) => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;

  // Smooth through remaining changes using Wilder's method
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Annualised volatility from log returns (√252 scaling)
export function calcVolatility(closes: number[], period = 30): number | null {
  const slice = closes.slice(-Math.min(period + 1, closes.length));
  if (slice.length < 2) return null;

  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(Math.log(slice[i] / slice[i - 1]));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

// % change over N days
export function calcMomentum(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((current - past) / past) * 100;
}

// Derives a single score in [−1, 1] from available indicators.
// Missing components are excluded and remaining weights are rescaled.
export function calcQuantScore({
  rsi14,
  change7d,
  sma20,
  price,
}: {
  rsi14?: number | null;
  change7d?: number | null;
  sma20?: number | null;
  price?: number | null;
}): number {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  let score = 0;
  let totalWeight = 0;

  if (rsi14 != null) {
    // Oversold (low RSI) → positive signal; overbought (high RSI) → negative
    score += clamp((50 - rsi14) / 50, -1, 1) * 0.4;
    totalWeight += 0.4;
  }

  if (change7d != null) {
    // ±20% 7-day move maps to ±1
    score += clamp(change7d / 20, -1, 1) * 0.4;
    totalWeight += 0.4;
  }

  if (sma20 != null && price != null) {
    score += (price > sma20 ? 1 : -1) * 0.2;
    totalWeight += 0.2;
  }

  if (totalWeight === 0) return 0;
  return clamp(score / totalWeight, -1, 1);
}

export function scoreToSignal(score: number): string {
  if (score > 0.6) return "STRONG_BUY";
  if (score > 0.2) return "BUY";
  if (score > -0.2) return "NEUTRAL";
  if (score > -0.6) return "SELL";
  return "STRONG_SELL";
}
