import { describe, it, expect } from "vitest";
import { fngToScore } from "@/lib/crypto-fng";
import { toBinanceSymbol } from "@/lib/binance-prices";
import { toCoinGeckoId } from "@/lib/coingecko-prices";

describe("fngToScore", () => {
  it("maps neutral (50) to 0", () => {
    expect(fngToScore(50)).toBe(0);
  });
  it("maps extreme greed (100) to +1 and extreme fear (0) to -1", () => {
    expect(fngToScore(100)).toBe(1);
    expect(fngToScore(0)).toBe(-1);
  });
  it("scales linearly in between", () => {
    expect(fngToScore(75)).toBeCloseTo(0.5, 5);
    expect(fngToScore(25)).toBeCloseTo(-0.5, 5);
  });
  it("clamps out-of-range values", () => {
    expect(fngToScore(120)).toBe(1);
    expect(fngToScore(-20)).toBe(-1);
  });
});

describe("toBinanceSymbol", () => {
  it("converts -USD tickers to USDT pairs", () => {
    expect(toBinanceSymbol("BTC-USD")).toBe("BTCUSDT");
    expect(toBinanceSymbol("ETH-USD")).toBe("ETHUSDT");
  });
  it("returns null for non-crypto tickers", () => {
    expect(toBinanceSymbol("AAPL")).toBeNull();
    expect(toBinanceSymbol("JMT.LS")).toBeNull();
  });
  it("returns null when there is no base symbol", () => {
    expect(toBinanceSymbol("-USD")).toBeNull();
  });
});

describe("toCoinGeckoId", () => {
  it("maps known tickers to coin ids", () => {
    expect(toCoinGeckoId("BTC-USD")).toBe("bitcoin");
    expect(toCoinGeckoId("SOL-USD")).toBe("solana");
  });
  it("returns null for unmapped tickers", () => {
    expect(toCoinGeckoId("AAPL")).toBeNull();
    expect(toCoinGeckoId("ZZZ-USD")).toBeNull();
  });
});
