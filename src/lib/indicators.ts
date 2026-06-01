// All functions expect arrays in chronological order (oldest first).

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

// Today's volume divided by the N-day average of prior days' volume
export function calcVolumeRatio(volumes: number[], period = 10): number | null {
  if (volumes.length < period + 1) return null;
  const priorVolumes = volumes.slice(-period - 1, -1);
  const avg = priorVolumes.reduce((a, b) => a + b, 0) / period;
  if (avg === 0) return null;
  return volumes[volumes.length - 1] / avg;
}

// Derives a single score in [−1, 1] from available indicators.
// Missing components are excluded and remaining weights are rescaled.
//
// Components and their weights when all are present:
//   RSI(14)         35% — oversold → positive, overbought → negative
//   7d momentum     35% — crypto-aware normalisation (±40% vs ±20% for equities)
//   SMA(20) position 15% — continuous distance from moving average
//   Volume ratio     15% — elevated volume confirms the trend direction
//
// After scoring, a volatility dampener reduces the magnitude in high-vol regimes.
export function calcQuantScore({
  rsi14,
  change7d,
  sma20,
  price,
  volatility30d,
  volumeRatio10d,
  isCrypto = false,
}: {
  rsi14?: number | null;
  change7d?: number | null;
  sma20?: number | null;
  price?: number | null;
  volatility30d?: number | null;
  volumeRatio10d?: number | null;
  isCrypto?: boolean;
}): number {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  let score = 0;
  let totalWeight = 0;

  if (rsi14 != null) {
    // Oversold (low RSI) → positive; overbought (high RSI) → negative
    score += clamp((50 - rsi14) / 50, -1, 1) * 0.35;
    totalWeight += 0.35;
  }

  if (change7d != null) {
    // Crypto swings ±40% routinely; equities use ±20% as the extreme
    const normFactor = isCrypto ? 40 : 20;
    score += clamp(change7d / normFactor, -1, 1) * 0.35;
    totalWeight += 0.35;
  }

  if (sma20 != null && price != null) {
    // Continuous distance from SMA: 10% deviation = ±1 for equities, 20% for crypto
    const devFactor = isCrypto ? 20 : 10;
    score += clamp((price - sma20) / sma20 * devFactor, -1, 1) * 0.15;
    totalWeight += 0.15;
  }

  if (volumeRatio10d != null && sma20 != null && price != null) {
    // Volume above average confirms the trend direction; below average adds nothing
    const direction = price > sma20 ? 1 : -1;
    const volSignal = clamp((volumeRatio10d - 1) / 2, 0, 1) * direction;
    score += volSignal * 0.15;
    totalWeight += 0.15;
  }

  if (totalWeight === 0) return 0;

  const rawScore = clamp(score / totalWeight, -1, 1);

  // Volatility dampener: high vol regimes produce unreliable signals; scale toward 0
  // vol 20% → multiplier 1.0 (full confidence), vol 60%+ → multiplier 0.3 (low confidence)
  if (volatility30d != null) {
    const dampener = clamp(1 - (volatility30d - 0.20) / 0.60, 0.3, 1.0);
    return clamp(rawScore * dampener, -1, 1);
  }

  return rawScore;
}

export function scoreToSignal(score: number): string {
  if (score > 0.6) return "STRONG_BUY";
  if (score > 0.2) return "BUY";
  if (score > -0.2) return "NEUTRAL";
  if (score > -0.6) return "SELL";
  return "STRONG_SELL";
}
