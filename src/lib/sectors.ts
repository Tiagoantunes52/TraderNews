// Ticker → sector ETF map, plus ETF → human-readable sector name.
// Shared by the quant pipeline (sector-relative strength) and the
// portfolio page (sector concentration).

export const SECTOR_ETF: Record<string, string> = {
  // Technology
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", AMD: "XLK", INTC: "XLK", ORCL: "XLK", CRM: "XLK", ADBE: "XLK", QCOM: "XLK",
  // Communication Services (GOOGL appears in both Tech and Comm — last key wins; we use XLC)
  META: "XLC", NFLX: "XLC", GOOGL: "XLC", GOOG: "XLC", VZ: "XLC", T: "XLC", DIS: "XLC",
  // Consumer Discretionary
  AMZN: "XLY", TSLA: "XLY", HD: "XLY", MCD: "XLY", NKE: "XLY", SBUX: "XLY",
  // Consumer Staples
  PG: "XLP", KO: "XLP", PEP: "XLP", WMT: "XLP", COST: "XLP", PM: "XLP",
  // Financials
  JPM: "XLF", BAC: "XLF", GS: "XLF", MS: "XLF", C: "XLF", WFC: "XLF", BRK_B: "XLF",
  // Healthcare
  JNJ: "XLV", UNH: "XLV", PFE: "XLV", ABBV: "XLV", MRK: "XLV", LLY: "XLV",
  // Industrials
  BA: "XLI", CAT: "XLI", GE: "XLI", HON: "XLI", UPS: "XLI",
  // Energy
  XOM: "XLE", CVX: "XLE", COP: "XLE", SLB: "XLE",
  // Utilities
  NEE: "XLU", DUK: "XLU", SO: "XLU",
  // Real Estate
  AMT: "XLRE", PLD: "XLRE", EQIX: "XLRE",
  // Materials
  LIN: "XLB", APD: "XLB", NEM: "XLB",
};

export const ETF_SECTOR_NAME: Record<string, string> = {
  XLK: "Technology",
  XLC: "Communication Services",
  XLY: "Consumer Discretionary",
  XLP: "Consumer Staples",
  XLF: "Financials",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLE: "Energy",
  XLU: "Utilities",
  XLRE: "Real Estate",
  XLB: "Materials",
};

/** Human-readable sector for a ticker. Crypto and unmapped tickers fall back. */
export function sectorForTicker(ticker: string): string {
  if (ticker.endsWith("-USD")) return "Crypto";
  const etf = SECTOR_ETF[ticker];
  if (!etf) return "Other";
  return ETF_SECTOR_NAME[etf] ?? "Other";
}
