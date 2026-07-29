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

// ── Alpaca symbol form ───────────────────────────────────────────────────────
// The app stores US class shares in DASH form (`BRK-B`, `BF-B`); every Alpaca API —
// market data and trading alike — names them with a DOT (`BRK.B`) and rejects the
// dash form outright. Sending one through cost more than that single name: the
// latest-trades endpoint fails the WHOLE request on one bad symbol
// (`400 invalid symbol: BRK-B`), so a chunk of up to 100 names silently fell back to
// stored closes — re-introducing the very close-vs-fill bias live quotes exist to
// remove. Convert at the Alpaca boundary and nowhere else: everything inside the app
// keeps speaking the stored dash form.
//
// Only a single-letter share class is converted (`^TICK-A$`). Crypto (`BTC-USD`) and
// foreign listings (`MC.PA`) are left alone — neither is an Alpaca equity symbol, and
// mangling them would create ticker forms the rest of the app has never seen.
const US_CLASS_SHARE_DASH = /^([A-Z]{1,4})-([A-Z])$/;
const US_CLASS_SHARE_DOT = /^([A-Z]{1,4})\.([A-Z])$/;

/** Stored ticker → Alpaca symbol (`BRK-B` → `BRK.B`). Everything else unchanged. */
export function toAlpacaSymbol(ticker: string): string {
  return ticker.replace(US_CLASS_SHARE_DASH, "$1.$2");
}

/** Alpaca symbol → stored ticker (`BRK.B` → `BRK-B`). Everything else unchanged. */
export function fromAlpacaSymbol(symbol: string): string {
  return symbol.replace(US_CLASS_SHARE_DOT, "$1-$2");
}
