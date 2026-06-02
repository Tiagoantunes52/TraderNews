// Known ETF tickers — used to decide which watchlist symbols get an ETF profile
// pulled (Alpha Vantage ETF_PROFILE). Includes broad-market funds plus the
// sector ETFs already referenced for sector-relative strength.

export const ETF_TICKERS = new Set<string>([
  // Broad market / index
  "SPY", "QQQ", "DIA", "IWM", "VTI", "VOO", "IVV", "VEA", "VWO", "EFA", "AGG", "BND", "TLT", "GLD", "SLV",
  // Sector SPDRs
  "XLK", "XLC", "XLY", "XLP", "XLF", "XLV", "XLI", "XLE", "XLU", "XLRE", "XLB",
]);

export function isEtf(ticker: string): boolean {
  return ETF_TICKERS.has(ticker);
}
