import { describe, it, expect } from "vitest";
import {
  clampWatchlistLimit,
  parseWatchlistLimit,
  DEFAULT_WATCHLIST_LIMIT,
  MIN_WATCHLIST_LIMIT,
  MAX_WATCHLIST_LIMIT,
} from "@/lib/settings";

describe("clampWatchlistLimit", () => {
  it("keeps in-range integers untouched", () => {
    expect(clampWatchlistLimit(20)).toBe(20);
    expect(clampWatchlistLimit(MIN_WATCHLIST_LIMIT)).toBe(MIN_WATCHLIST_LIMIT);
    expect(clampWatchlistLimit(MAX_WATCHLIST_LIMIT)).toBe(MAX_WATCHLIST_LIMIT);
  });

  it("clamps to the min/max bounds", () => {
    expect(clampWatchlistLimit(0)).toBe(MIN_WATCHLIST_LIMIT);
    expect(clampWatchlistLimit(-5)).toBe(MIN_WATCHLIST_LIMIT);
    expect(clampWatchlistLimit(9999)).toBe(MAX_WATCHLIST_LIMIT);
  });

  it("floors fractional values and rejects non-finite input", () => {
    expect(clampWatchlistLimit(20.9)).toBe(20);
    expect(clampWatchlistLimit(NaN)).toBe(DEFAULT_WATCHLIST_LIMIT);
    expect(clampWatchlistLimit(Infinity)).toBe(DEFAULT_WATCHLIST_LIMIT);
  });
});

describe("parseWatchlistLimit", () => {
  it("defaults when the stored value is missing or unparseable", () => {
    expect(parseWatchlistLimit(null)).toBe(DEFAULT_WATCHLIST_LIMIT);
    expect(parseWatchlistLimit(undefined)).toBe(DEFAULT_WATCHLIST_LIMIT);
    expect(parseWatchlistLimit("")).toBe(DEFAULT_WATCHLIST_LIMIT);
    expect(parseWatchlistLimit("abc")).toBe(DEFAULT_WATCHLIST_LIMIT);
  });

  it("parses and clamps stored numeric strings", () => {
    expect(parseWatchlistLimit("30")).toBe(30);
    expect(parseWatchlistLimit("0")).toBe(MIN_WATCHLIST_LIMIT);
    expect(parseWatchlistLimit("99999")).toBe(MAX_WATCHLIST_LIMIT);
  });
});
