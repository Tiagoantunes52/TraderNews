// Ticker → sector ETF map, plus ETF → human-readable sector name.
// Shared by the quant pipeline (sector-relative strength — US tickers only) and the
// watchlist-insights page (sector concentration — all tickers).
//
// Sectors follow GICS, mapped to the SPDR sector ETFs. The quant stage only looks up
// US tickers here (relative strength vs the US sector ETF), so the European entries
// below are display-only for the insights page and never benchmark a EU name against
// a US ETF. Keyed by our stored ticker form (e.g. BRK-B, MC.PA). The seed is fully
// covered; common non-seed US large-caps are kept too so a searched name still
// categorizes. Anything unmapped falls back to "Other".

export const SECTOR_ETF: Record<string, string> = {
  // ── US — Technology (XLK) ──────────────────────────────────────────────────
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", ORCL: "XLK", CRM: "XLK", ADBE: "XLK",
  NOW: "XLK", PLTR: "XLK", SNOW: "XLK", CRWD: "XLK", PANW: "XLK", DDOG: "XLK",
  APP: "XLK", ARM: "XLK", AMD: "XLK", INTC: "XLK", MU: "XLK", AVGO: "XLK",
  QCOM: "XLK", AMAT: "XLK", LRCX: "XLK", KLAC: "XLK", ANET: "XLK", SMCI: "XLK",
  COHR: "XLK", LITE: "XLK", TOST: "XLK", DUOL: "XLK",
  // ── US — Communication Services (XLC) ──────────────────────────────────────
  GOOGL: "XLC", GOOG: "XLC", META: "XLC", NFLX: "XLC", DIS: "XLC", TMUS: "XLC",
  VZ: "XLC", T: "XLC", RDDT: "XLC", SPOT: "XLC", FOXA: "XLC", ASTS: "XLC",
  // ── US — Consumer Discretionary (XLY) ──────────────────────────────────────
  AMZN: "XLY", TSLA: "XLY", BKNG: "XLY", ABNB: "XLY", RIVN: "XLY", CVNA: "XLY",
  NKE: "XLY", SBUX: "XLY", CAVA: "XLY", HD: "XLY", MCD: "XLY",
  // ── US — Consumer Staples (XLP) ────────────────────────────────────────────
  WMT: "XLP", COST: "XLP", PG: "XLP", KO: "XLP", PEP: "XLP", PM: "XLP", CART: "XLP",
  // ── US — Financials (XLF) ──────────────────────────────────────────────────
  JPM: "XLF", BAC: "XLF", WFC: "XLF", GS: "XLF", MS: "XLF", "BRK-B": "XLF",
  BLK: "XLF", SCHW: "XLF", V: "XLF", MA: "XLF", COIN: "XLF", HOOD: "XLF", C: "XLF",
  // ── US — Healthcare (XLV) ──────────────────────────────────────────────────
  LLY: "XLV", JNJ: "XLV", ABBV: "XLV", MRK: "XLV", PFE: "XLV", UNH: "XLV",
  ISRG: "XLV", TMO: "XLV", DHR: "XLV", REGN: "XLV", VRTX: "XLV", TEM: "XLV",
  // ── US — Industrials (XLI) ─────────────────────────────────────────────────
  GE: "XLI", CAT: "XLI", DE: "XLI", RTX: "XLI", LMT: "XLI", BA: "XLI", ETN: "XLI",
  PH: "XLI", EME: "XLI", FIX: "XLI", RKLB: "XLI", SPCX: "XLI", VRT: "XLI",
  UBER: "XLI", HON: "XLI", UPS: "XLI",
  // ── US — Energy (XLE) ──────────────────────────────────────────────────────
  XOM: "XLE", CVX: "XLE", COP: "XLE", EOG: "XLE", OXY: "XLE", SLB: "XLE",
  // ── US — Utilities (XLU) ───────────────────────────────────────────────────
  NEE: "XLU", SO: "XLU", DUK: "XLU",
  // ── US — Real Estate (XLRE) ────────────────────────────────────────────────
  PLD: "XLRE", AMT: "XLRE", EQIX: "XLRE",
  // ── US — Materials (XLB) ───────────────────────────────────────────────────
  LIN: "XLB", APD: "XLB", NEM: "XLB",

  // ── Europe (display-only; quant never benchmarks these vs a US ETF) ─────────
  // Portugal (Euronext Lisbon)
  "JMT.LS": "XLP", "GALP.LS": "XLE", "EDP.LS": "XLU", "EDPR.LS": "XLU",
  "BCP.LS": "XLF", "NOS.LS": "XLC", "SON.LS": "XLP", "NVG.LS": "XLB",
  "SEM.LS": "XLB", "CTT.LS": "XLI", "ALTR.LS": "XLB", "COR.LS": "XLB",
  "EGL.LS": "XLI", "RENE.LS": "XLU", "IBS.LS": "XLY", "RAM.LS": "XLB",
  // Spain (BME)
  "ITX.MC": "XLY", "SAN.MC": "XLF", "IBE.MC": "XLU", "BBVA.MC": "XLF",
  "TEF.MC": "XLC", "CABK.MC": "XLF", "AMS.MC": "XLK", "FER.MC": "XLI",
  "REP.MC": "XLE", "AENA.MC": "XLI", "ELE.MC": "XLU", "NTGY.MC": "XLU",
  "SAB.MC": "XLF", "RED.MC": "XLU", "CLNX.MC": "XLC", "ACS.MC": "XLI",
  "MAP.MC": "XLF", "ANA.MC": "XLU", "ENG.MC": "XLU", "GRF.MC": "XLV",
  // France (Euronext Paris)
  "MC.PA": "XLY", "OR.PA": "XLP", "TTE.PA": "XLE", "SAN.PA": "XLV",
  "AIR.PA": "XLI", "SU.PA": "XLI", "AI.PA": "XLB", "EL.PA": "XLV",
  "BNP.PA": "XLF", "DG.PA": "XLI", "SAF.PA": "XLI", "CS.PA": "XLF",
  "RMS.PA": "XLY", "KER.PA": "XLY", "DSY.PA": "XLK", "BN.PA": "XLP",
  "GLE.PA": "XLF", "STLAP.PA": "XLY", "ACA.PA": "XLF", "ENGI.PA": "XLU",
  // Germany (XETRA)
  "SAP.DE": "XLK", "SIE.DE": "XLI", "ALV.DE": "XLF", "DTE.DE": "XLC",
  "MBG.DE": "XLY", "BMW.DE": "XLY", "VOW3.DE": "XLY", "BAS.DE": "XLB",
  "BAYN.DE": "XLV", "MRK.DE": "XLV", "DB1.DE": "XLF", "IFX.DE": "XLK",
  "DBK.DE": "XLF", "ADS.DE": "XLY", "MUV2.DE": "XLF", "RWE.DE": "XLU",
  "EOAN.DE": "XLU", "DHL.DE": "XLI", "HEN3.DE": "XLP", "P911.DE": "XLY",
  // Netherlands (Euronext Amsterdam)
  "ASML.AS": "XLK", "PRX.AS": "XLC", "INGA.AS": "XLF", "ADYEN.AS": "XLK",
  "AD.AS": "XLP", "PHIA.AS": "XLV", "WKL.AS": "XLI", "HEIA.AS": "XLP",
  "ASM.AS": "XLK", "REN.AS": "XLI", "BESI.AS": "XLK", "KPN.AS": "XLC",
  "NN.AS": "XLF", "AGN.AS": "XLF", "DSFIR.AS": "XLB", "AKZA.AS": "XLB",
  "RAND.AS": "XLI", "IMCD.AS": "XLI", "ABN.AS": "XLF", "URW.AS": "XLRE",
  // Italy (Borsa Italiana)
  "ENEL.MI": "XLU", "ISP.MI": "XLF", "UCG.MI": "XLF", "ENI.MI": "XLE",
  "RACE.MI": "XLY", "G.MI": "XLF", "STLAM.MI": "XLY", "STMMI.MI": "XLK",
  "PRY.MI": "XLI", "MONC.MI": "XLY", "TIT.MI": "XLC", "SRG.MI": "XLU",
  "TRN.MI": "XLU", "LDO.MI": "XLI", "BAMI.MI": "XLF", "MB.MI": "XLF",
  "CPR.MI": "XLP", "NEXI.MI": "XLK", "PST.MI": "XLF", "FBK.MI": "XLF",
  // United Kingdom (LSE)
  "AZN.L": "XLV", "BA.L": "XLI", "SHEL.L": "XLE", "HSBA.L": "XLF",
  "ULVR.L": "XLP", "BP.L": "XLE", "RIO.L": "XLB", "GSK.L": "XLV",
  "DGE.L": "XLP", "REL.L": "XLI", "GLEN.L": "XLB", "BATS.L": "XLP",
  "LSEG.L": "XLF", "RR.L": "XLI", "NG.L": "XLU", "BARC.L": "XLF",
  "VOD.L": "XLC", "LLOY.L": "XLF", "PRU.L": "XLF", "NWG.L": "XLF",
  "TSCO.L": "XLP",
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
