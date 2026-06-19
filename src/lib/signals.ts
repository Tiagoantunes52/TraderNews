// Single source of truth for turning raw indicator numbers into a bull / bear /
// neutral read. Every view (watchlist-insights heatmap, analysis badges, stock detail,
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
// copy a user reads can never drift from the logic above. Used for the
// watchlist-insights and analysis column tooltips.
export const SIGNAL_HINTS = {
  sentiment: `Aggregate news sentiment for the stock, on a −1 to +1 scale. Reads bullish above +${THRESHOLDS.sentimentBull}, bearish below −${THRESHOLDS.sentimentBull}, otherwise neutral.`,
  rsi: `Relative Strength Index (14-day). Oversold (below ${THRESHOLDS.rsiOversold}) reads bullish on mean-reversion; overbought (above ${THRESHOLDS.rsiOverbought}) reads bearish.`,
  macd: `MACD histogram as a % of price (so it's comparable across stocks). Reads bullish above +${THRESHOLDS.macdDeadzonePct}%, bearish below −${THRESHOLDS.macdDeadzonePct}%; a near-zero histogram is neutral.`,
  momentum: `7-day price change. Up more than ${THRESHOLDS.momentumNeutralPct}% reads bullish, down more than ${THRESHOLDS.momentumNeutralPct}% reads bearish; smaller weekly moves are treated as neutral noise.`,
} as const;

// Plain-language explanations for the indicators surfaced on the analysis page —
// what each one means and which way it nudges the read. Built from the same
// THRESHOLDS so the copy can't drift from the logic. RSI and sentiment reuse
// SIGNAL_HINTS verbatim so both pages say the same thing about the same number.
export const INDICATOR_HINTS = {
  rsi: SIGNAL_HINTS.rsi,
  sma20:
    "20-day simple moving average — the mean closing price over the last 20 sessions. Trading above the SMA20 signals a short-term uptrend (bullish); below it, a short-term downtrend (bearish).",
  sma50:
    "50-day simple moving average — the mean closing price over the last 50 sessions. Above it is a medium-term uptrend (bullish); below it, a medium-term downtrend (bearish).",
  pctB:
    "Bollinger %B — where the price sits within the Bollinger Bands. 100 = at the upper band (stretched high, often overbought), 0 = at the lower band (stretched low, often oversold), 50 = the 20-day average.",
  signal:
    "Overall call from the combined score: STRONG BUY above +0.6, BUY +0.2 to +0.6, NEUTRAL within ±0.2, SELL −0.6 to −0.2, STRONG SELL below −0.6.",
  confidence:
    "How sure the model is of this estimate (0–100%). It starts from the sentiment model's own confidence, then is trimmed for stale prices, missing quant data, sentiment/quant disagreement or thin news — and nudged up when many articles agree.",
  aspects:
    "The model's sentiment broken down by theme (earnings, guidance, products…). Each bar shows how positive or negative recent news was on that aspect.",
  keyDriver:
    "The single factor the model judged most responsible for the current sentiment read.",
  bollingerSqueeze: `Bollinger Bands run ±2 standard deviations around the 20-day average. When they pinch tight (a "squeeze" — band width below ${THRESHOLDS.bollingerSqueeze}), volatility is unusually low, often the lull before a sharp move in either direction.`,
  atr:
    "Average True Range, as a % of price — how much the stock typically swings in a day. Higher means more volatile (bigger moves, wider risk); it sizes the moves, it doesn't pick a direction.",
  earnings:
    "Trading days until the next scheduled earnings report. Price reactions are often large and hard to predict right around earnings, so a date within a week is flagged as elevated event risk.",
  sentimentScore: SIGNAL_HINTS.sentiment,
  quantScore:
    "Quant score (−1 to +1): a weighted blend of the price-based indicators — RSI, momentum, MACD, price-vs-SMA, Bollinger %B and volatility. Positive leans bullish, negative bearish.",
  combinedScore:
    "Combined estimate (−1 to +1): news sentiment and the quant score merged into one number. Sentiment's weight grows with how many articles back it (and shrinks when the stock is very volatile). This score ranks the cards.",
} as const;
