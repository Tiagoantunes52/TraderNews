// Exchange suffixes the app supports end-to-end (price sources, news, market
// routing). US equities + crypto carry no such suffix. Anything else dotted
// (.SS Shanghai, .T Tokyo, .TO Toronto, .MX Mexico, …) is an unsupported foreign
// listing we don't ingest — no price/news coverage, can't be traded.
export const SUPPORTED_EXCHANGE_SUFFIXES = [".LS", ".L", ".PA", ".DE", ".AS", ".MC", ".MI"] as const;

// Suffix → market name. Order matters only in that `.LS` is checked before `.L`
// (handled by the array order above, since ".LS" precedes ".L").
const SUFFIX_MARKET: Record<(typeof SUPPORTED_EXCHANGE_SUFFIXES)[number], string> = {
  ".LS": "EURONEXT_LISBON",
  ".L": "LSE",
  ".PA": "EURONEXT_PARIS",
  ".DE": "XETRA",
  ".AS": "EURONEXT_AMSTERDAM",
  ".MC": "BME",
  ".MI": "BORSA_ITALIANA",
};

export function marketNamesForTicker(ticker: string): string[] {
  for (const suffix of SUPPORTED_EXCHANGE_SUFFIXES) {
    if (ticker.endsWith(suffix)) return [SUFFIX_MARKET[suffix]];
  }
  if (ticker.endsWith("-USD")) return ["CRYPTO"];
  return ["NYSE", "NASDAQ"];
}

/**
 * True if the app supports this ticker end-to-end: a US equity (no exchange
 * suffix), crypto (`-USD`), or one of the seeded European exchanges. Unsupported
 * foreign listings (e.g. `.SS`, `.T`, `.TO`) return false — they have no price/news
 * coverage and must not be persisted (search) or ingested (pipeline). Dotted US
 * class shares (e.g. `BRK.B`) also return false; the app uses the dash form (`BRK-B`).
 */
export function isSupportedTicker(ticker: string): boolean {
  if (ticker.endsWith("-USD")) return true; // crypto
  if (!ticker.includes(".")) return true; // US equity (no exchange suffix)
  return SUPPORTED_EXCHANGE_SUFFIXES.some((s) => ticker.endsWith(s));
}
