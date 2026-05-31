import { describe, it, expect } from "vitest";
import { marketNamesForTicker } from "@/lib/market-utils";

describe("marketNamesForTicker()", () => {
  it("maps Euronext Lisbon suffix", () => {
    expect(marketNamesForTicker("EGL.LS")).toEqual(["EURONEXT_LISBON"]);
    expect(marketNamesForTicker("BCP.LS")).toEqual(["EURONEXT_LISBON"]);
  });

  it("maps LSE suffix", () => {
    expect(marketNamesForTicker("HSBA.L")).toEqual(["LSE"]);
  });

  it("maps Euronext Paris suffix", () => {
    expect(marketNamesForTicker("LVMH.PA")).toEqual(["EURONEXT_PARIS"]);
  });

  it("maps Xetra suffix", () => {
    expect(marketNamesForTicker("BMW.DE")).toEqual(["XETRA"]);
  });

  it("maps Euronext Amsterdam suffix", () => {
    expect(marketNamesForTicker("ASML.AS")).toEqual(["EURONEXT_AMSTERDAM"]);
  });

  it("maps crypto suffix", () => {
    expect(marketNamesForTicker("BTC-USD")).toEqual(["CRYPTO"]);
    expect(marketNamesForTicker("ETH-USD")).toEqual(["CRYPTO"]);
  });

  it("defaults to NYSE/NASDAQ for plain US tickers", () => {
    expect(marketNamesForTicker("AAPL")).toEqual(["NYSE", "NASDAQ"]);
    expect(marketNamesForTicker("MSFT")).toEqual(["NYSE", "NASDAQ"]);
    expect(marketNamesForTicker("V")).toEqual(["NYSE", "NASDAQ"]);
  });

  it("does not match .L suffix for longer suffixes", () => {
    // EGL.LS should NOT match LSE (.L)
    expect(marketNamesForTicker("EGL.LS")).not.toEqual(["LSE"]);
  });
});
