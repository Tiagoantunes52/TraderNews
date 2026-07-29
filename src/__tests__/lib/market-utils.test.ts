import { describe, it, expect } from "vitest";
import { marketNamesForTicker, toAlpacaSymbol, fromAlpacaSymbol } from "@/lib/market-utils";

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

  it("maps Bolsa de Madrid suffix", () => {
    expect(marketNamesForTicker("ITX.MC")).toEqual(["BME"]);
    expect(marketNamesForTicker("SAN.MC")).toEqual(["BME"]);
  });

  it("maps Borsa Italiana suffix", () => {
    expect(marketNamesForTicker("ENEL.MI")).toEqual(["BORSA_ITALIANA"]);
    expect(marketNamesForTicker("RACE.MI")).toEqual(["BORSA_ITALIANA"]);
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

describe("Alpaca symbol form", () => {
  it("converts a US class share to the dot form Alpaca requires", () => {
    expect(toAlpacaSymbol("BRK-B")).toBe("BRK.B");
    expect(toAlpacaSymbol("BF-B")).toBe("BF.B");
  });

  it("converts an Alpaca class-share symbol back to the stored dash form", () => {
    expect(fromAlpacaSymbol("BRK.B")).toBe("BRK-B");
  });

  it("leaves ordinary US tickers untouched in both directions", () => {
    expect(toAlpacaSymbol("AAPL")).toBe("AAPL");
    expect(fromAlpacaSymbol("AAPL")).toBe("AAPL");
  });

  // Neither is an Alpaca equity symbol, and rewriting them would invent ticker forms
  // the rest of the app has never stored.
  it("leaves crypto and foreign listings alone", () => {
    expect(toAlpacaSymbol("BTC-USD")).toBe("BTC-USD");
    expect(fromAlpacaSymbol("MC.PA")).toBe("MC.PA");
    expect(fromAlpacaSymbol("EGL.LS")).toBe("EGL.LS");
  });

  it("round-trips", () => {
    for (const t of ["BRK-B", "AAPL", "BTC-USD", "MC.PA"]) {
      expect(fromAlpacaSymbol(toAlpacaSymbol(t))).toBe(t);
    }
  });
});
