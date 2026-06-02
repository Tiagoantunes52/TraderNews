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

// Exponential Moving Average — returns array of length closes.length - period + 1.
// Seed is the SMA of the first `period` values; then applies k = 2/(period+1) smoothing.
// Returns [] if closes.length < period.
export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];

  const k = 2 / (period + 1);

  // Seed: SMA of first `period` values
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const ema: number[] = [seed];

  for (let i = period; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[ema.length - 1] * (1 - k));
  }

  return ema;
}

export type BollingerResult = {
  upper: number;
  lower: number;
  middle: number;  // SMA
  width: number;   // (upper - lower) / middle — squeeze when low
  percentB: number; // (price - lower) / (upper - lower); 0.5 = at SMA
};

export function calcBollingerBands(closes: number[], period = 20, stdDevs = 2): BollingerResult | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;

  // Population std dev (divide by N)
  const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  if (std === 0) {
    return { upper: sma, lower: sma, middle: sma, width: 0, percentB: 0.5 };
  }

  const upper = sma + stdDevs * std;
  const lower = sma - stdDevs * std;
  const width = sma !== 0 ? (upper - lower) / sma : 0;
  const price = closes[closes.length - 1];
  const percentB = (upper - lower) !== 0 ? (price - lower) / (upper - lower) : 0.5;

  return { upper, lower, middle: sma, width, percentB };
}

// Wilder-smoothed Average True Range
export function calcATR(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(hl, hc, lc));
  }

  // Seed: simple average of first `period` true ranges
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Smooth remaining with Wilder's method
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

export type MACDResult = { macd: number; signal: number; histogram: number };

// MACD calculation.
// Returns null if closes.length < slow + signal.
export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDResult | null {
  if (closes.length < slow + signal) return null;

  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);

  if (emaFast.length === 0 || emaSlow.length === 0) return null;

  // emaFast starts at index fast-1, emaSlow at slow-1.
  // offset = slow - fast; macdLine[i] = emaFast[offset + i] - emaSlow[i]
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[offset + i] - emaSlow[i]);
  }

  const signalLine = calcEMA(macdLine, signal);
  if (signalLine.length === 0) return null;

  const macdValue = macdLine[macdLine.length - 1];
  const signalValue = signalLine[signalLine.length - 1];
  const histogram = macdValue - signalValue;

  return { macd: macdValue, signal: signalValue, histogram };
}

// Derives a single score in [−1, 1] from available indicators.
// Missing components are excluded and remaining weights are rescaled.
//
// Components and their weights when all 5 are present:
//   RSI(14)              30% — oversold → positive, overbought → negative
//   7d momentum          30% — uses relativeStr7d if available; crypto-aware normalisation
//   SMA(20)/Bollinger %B 10% — when bollingerPctB provided, replaces SMA position component
//   Volume ratio         10% — elevated volume confirms the trend direction
//   MACD histogram       20% — momentum confirmation
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
  macdHistogram,
  relativeStr7d,
  bollingerPctB,
}: {
  rsi14?: number | null;
  change7d?: number | null;
  sma20?: number | null;
  price?: number | null;
  volatility30d?: number | null;
  volumeRatio10d?: number | null;
  isCrypto?: boolean;
  macdHistogram?: number | null;
  relativeStr7d?: number | null;
  bollingerPctB?: number | null;
}): number {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  let score = 0;
  let totalWeight = 0;

  if (rsi14 != null) {
    // Oversold (low RSI) → positive; overbought (high RSI) → negative
    score += clamp((50 - rsi14) / 50, -1, 1) * 0.30;
    totalWeight += 0.30;
  }

  // Momentum: use relativeStr7d (stock vs SPY) when available, else change7d
  const momentumValue = relativeStr7d != null ? relativeStr7d : change7d;
  if (momentumValue != null) {
    // Crypto swings ±40% routinely; equities use ±20% as the extreme
    const normFactor = isCrypto ? 40 : 20;
    score += clamp(momentumValue / normFactor, -1, 1) * 0.30;
    totalWeight += 0.30;
  }

  // SMA position / Bollinger %B: bollingerPctB takes priority when provided
  if (bollingerPctB != null) {
    // %B of 0.5 = at SMA (neutral), >0.5 = above (bullish), <0.5 = below (bearish)
    score += clamp((bollingerPctB - 0.5) * 2, -1, 1) * 0.10;
    totalWeight += 0.10;
  } else if (sma20 != null && price != null) {
    // Continuous distance from SMA: 10% deviation = ±1 for equities, 20% for crypto
    const devFactor = isCrypto ? 20 : 10;
    score += clamp((price - sma20) / sma20 * devFactor, -1, 1) * 0.10;
    totalWeight += 0.10;
  }

  if (volumeRatio10d != null && (bollingerPctB != null || (sma20 != null && price != null))) {
    // Volume above average confirms the trend direction; below average adds nothing
    // Use bollingerPctB to determine direction when available, else price vs sma20
    const direction = bollingerPctB != null
      ? (bollingerPctB > 0.5 ? 1 : -1)
      : (price! > sma20! ? 1 : -1);
    const volSignal = clamp((volumeRatio10d - 1) / 2, 0, 1) * direction;
    score += volSignal * 0.10;
    totalWeight += 0.10;
  }

  if (macdHistogram != null && price != null) {
    // Normalize by price: express histogram as % of price then scale by normFactor
    const normFactor = isCrypto ? 3 : 1;
    score += clamp(macdHistogram / price * 100 / normFactor, -1, 1) * 0.20;
    totalWeight += 0.20;
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
