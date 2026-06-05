import { describe, it, expect } from "vitest";
import {
  normalizeTxnType,
  mapFinnhubTxn,
  isInsiderEligible,
  finnhubInsiderSource,
} from "@/lib/insider-sources";
import type { FinnhubInsiderTxn } from "@/lib/finnhub";

describe("normalizeTxnType", () => {
  it("maps the open-market codes to conviction types", () => {
    expect(normalizeTxnType("P")).toBe("OPEN_MARKET_BUY");
    expect(normalizeTxnType("S")).toBe("OPEN_MARKET_SELL");
  });

  it("maps comp/admin codes to their noise types", () => {
    expect(normalizeTxnType("A")).toBe("GRANT");
    expect(normalizeTxnType("M")).toBe("OPTION_EXERCISE");
    expect(normalizeTxnType("F")).toBe("TAX_WITHHOLDING");
    expect(normalizeTxnType("G")).toBe("GIFT");
    expect(normalizeTxnType("C")).toBe("CONVERSION");
    expect(normalizeTxnType("X")).toBe("CONVERSION");
  });

  it("is case-insensitive and falls back to OTHER", () => {
    expect(normalizeTxnType("p")).toBe("OPEN_MARKET_BUY");
    expect(normalizeTxnType("Z")).toBe("OTHER");
    expect(normalizeTxnType("")).toBe("OTHER");
  });
});

describe("isInsiderEligible", () => {
  it("accepts US operating-company tickers", () => {
    expect(isInsiderEligible("AAPL")).toBe(true);
    expect(isInsiderEligible("TSLA")).toBe(true);
  });

  it("rejects non-US, crypto, and ETF tickers", () => {
    expect(isInsiderEligible("JMT.LS")).toBe(false); // non-US (dot suffix)
    expect(isInsiderEligible("BTC-USD")).toBe(false); // crypto
    expect(isInsiderEligible("SPY")).toBe(false); // ETF
    expect(isInsiderEligible("XLK")).toBe(false); // sector ETF
  });
});

describe("mapFinnhubTxn", () => {
  const raw: FinnhubInsiderTxn = {
    name: "DOE JANE",
    share: 12000, // holdings after
    change: 2000, // bought 2000 (prior = 10000)
    filingDate: "2026-05-29",
    transactionDate: "2026-05-27",
    transactionCode: "P",
    transactionPrice: 50,
    isDerivative: false,
    id: "0001-26-1",
    symbol: "AAPL",
  };

  it("computes signed shares, notional value, and %-of-holdings", () => {
    const t = mapFinnhubTxn("AAPL", raw);
    expect(t.txnType).toBe("OPEN_MARKET_BUY");
    expect(t.shares).toBe(2000);
    expect(t.value).toBe(100000); // 2000 * 50
    expect(t.sharesAfter).toBe(12000);
    expect(t.pctHoldingsChg).toBeCloseTo(0.2, 5); // 2000 / 10000
    expect(t.accessionId).toBe("0001-26-1");
  });

  it("treats a zero transaction price as null (e.g. gifts)", () => {
    const t = mapFinnhubTxn("AAPL", { ...raw, transactionCode: "G", transactionPrice: 0, change: -65000 });
    expect(t.txnType).toBe("GIFT");
    expect(t.price).toBeNull();
    expect(t.value).toBeNull();
    expect(t.shares).toBe(-65000);
  });

  it("builds a stable, value-inclusive dedup key (idempotent re-fetch)", () => {
    const a = mapFinnhubTxn("AAPL", raw);
    const b = mapFinnhubTxn("AAPL", { ...raw });
    expect(a.dedupKey).toBe(b.dedupKey);
    // A different price (an amendment) yields a different key.
    const c = mapFinnhubTxn("AAPL", { ...raw, transactionPrice: 51 });
    expect(c.dedupKey).not.toBe(a.dedupKey);
  });
});

describe("finnhubInsiderSource", () => {
  it("is US-equity gated and configured by the Finnhub key", () => {
    expect(finnhubInsiderSource.supports("AAPL")).toBe(true);
    expect(finnhubInsiderSource.supports("BTC-USD")).toBe(false);
  });
});
