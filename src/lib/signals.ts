// Single source of truth for turning raw indicator numbers into a bull / bear /
// neutral read. Every view (portfolio heatmap, analysis badges, stock detail,
// news filter, mood) must classify *through* these helpers rather than
// re-deriving thresholds inline — that is how two components drift into telling
// the user different things about the same number.
//
// The principle: centralize the *decision*, not just the *number*. A shared
// constant still lets one caller use `>` and another `>=`; a shared classifier
// does not.

export type Signal = "bullish" | "bearish" | "neutral" | null;

export const THRESHOLDS = {
  /** Sentiment score (−1..1) above this is bullish, below its negation bearish. Also the mood() boundary. */
  sentimentBull: 0.2,
  /** RSI(14) below this is oversold → bullish mean-reversion. */
  rsiOversold: 30,
  /** RSI(14) above this is overbought → bearish. */
  rsiOverbought: 70,
  /** MACD histogram as a % of price; magnitudes within ± this are neutral noise. */
  macdDeadzonePct: 0.1,
  /** 7-day % price change within ± this is neutral noise. */
  momentumNeutralPct: 2,
  /** Bollinger band width below this signals a volatility squeeze. */
  bollingerSqueeze: 0.05,
  /** A single sector above this fraction of the watchlist is overweight. */
  sectorConcentration: 0.4,
} as const;

/** Symmetric dead-zone: bullish above +half, bearish below −half, neutral in between. */
function band(value: number, neutralHalfWidth: number): Signal {
  if (value > neutralHalfWidth) return "bullish";
  if (value < -neutralHalfWidth) return "bearish";
  return "neutral";
}

export function classifySentiment(score: number | null | undefined): Signal {
  if (score == null) return null;
  return band(score, THRESHOLDS.sentimentBull);
}

export function classifyRsi(rsi: number | null | undefined): Signal {
  if (rsi == null) return null;
  if (rsi < THRESHOLDS.rsiOversold) return "bullish"; // oversold → mean-reversion upside
  if (rsi > THRESHOLDS.rsiOverbought) return "bearish"; // overbought
  return "neutral";
}

export function classifyMacd(
  histogram: number | null | undefined,
  price: number | null | undefined
): Signal {
  if (histogram == null || price == null || price <= 0) return null;
  // The histogram is in price units, so it scales with the share price. Express it
  // as a % of price so one threshold works across stocks, then ignore the near-zero
  // band where the MACD and signal lines have barely crossed.
  return band((histogram / price) * 100, THRESHOLDS.macdDeadzonePct);
}

export function classifyMomentum(change7dPct: number | null | undefined): Signal {
  if (change7dPct == null) return null;
  return band(change7dPct, THRESHOLDS.momentumNeutralPct);
}

/** True when Bollinger band width indicates a volatility squeeze. */
export function isBollingerSqueeze(width: number | null | undefined): boolean {
  return width != null && width < THRESHOLDS.bollingerSqueeze;
}

// Plain-language explanations of each signal, built from the same constants so the
// copy a user reads can never drift from the logic above. Used for the portfolio
// column tooltips.
export const SIGNAL_HINTS = {
  sentiment: `Aggregate news sentiment for the stock, on a −1 to +1 scale. Reads bullish above +${THRESHOLDS.sentimentBull}, bearish below −${THRESHOLDS.sentimentBull}, otherwise neutral.`,
  rsi: `Relative Strength Index (14-day). Oversold (below ${THRESHOLDS.rsiOversold}) reads bullish on mean-reversion; overbought (above ${THRESHOLDS.rsiOverbought}) reads bearish.`,
  macd: `MACD histogram as a % of price (so it's comparable across stocks). Reads bullish above +${THRESHOLDS.macdDeadzonePct}%, bearish below −${THRESHOLDS.macdDeadzonePct}%; a near-zero histogram is neutral.`,
  momentum: `7-day price change. Up more than ${THRESHOLDS.momentumNeutralPct}% reads bullish, down more than ${THRESHOLDS.momentumNeutralPct}% reads bearish; smaller weekly moves are treated as neutral noise.`,
} as const;
