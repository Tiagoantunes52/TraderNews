import { describe, it, expect } from "vitest";
import { toPriceBarRows, barDate, hasQualityRejections, describeRejections } from "@/lib/price-bars";
import type { DailyPrice } from "@/lib/tiingo-prices";

const BEFORE = new Date("2026-07-30T00:00:00.000Z"); // exclusive upper bound

function bar(date: string, over: Partial<DailyPrice> = {}): DailyPrice {
  return { date, open: 100, high: 104, low: 98, close: 102, volume: 1000, ...over };
}

describe("barDate()", () => {
  it("parses YYYY-MM-DD to UTC midnight", () => {
    expect(barDate("2026-07-29")?.toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });

  it("returns null for garbage", () => {
    expect(barDate("not-a-date")).toBeNull();
  });
});

describe("toPriceBarRows()", () => {
  it("converts a clean window, preserving every leg and the source", () => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("2026-07-28"), bar("2026-07-29")], "Tiingo", BEFORE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      stockId: "s1",
      date: new Date("2026-07-28T00:00:00.000Z"),
      open: 100,
      high: 104,
      low: 98,
      close: 102,
      volume: 1000,
      source: "Tiingo",
    });
    expect(hasQualityRejections(rejected)).toBe(false);
  });

  // The stage runs minutes before the US close and crypto never closes, so the newest
  // bar a provider returns is routinely an unfinished session. Rows are written with
  // skipDuplicates, so a partial persisted once would never be corrected.
  it("excludes the in-progress session (dated at/after `before`)", () => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("2026-07-29"), bar("2026-07-30")], "Tiingo", BEFORE);
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(rejected.IN_PROGRESS).toBe(1);
  });

  it("excludes a future-dated bar too", () => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("2026-08-05")], "Yahoo", BEFORE);
    expect(rows).toHaveLength(0);
    expect(rejected.IN_PROGRESS).toBe(1);
  });

  // The Defect-A signature: adjusted close against raw open/high/low. A fill model
  // reading `low <= stop` on such a bar concludes it stopped out, every time.
  it("rejects a bar whose low sits above its close (mixed adjustment bases)", () => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("2026-07-29", { close: 50, low: 98, high: 104 })], "Yahoo", BEFORE);
    expect(rows).toHaveLength(0);
    expect(rejected.INCONSISTENT_OHLC).toBe(1);
    expect(hasQualityRejections(rejected)).toBe(true);
  });

  it("rejects high < low", () => {
    const { rejected } = toPriceBarRows("s1", [bar("2026-07-29", { high: 90, low: 95, close: 92, open: 93 })], "Yahoo", BEFORE);
    expect(rejected.INCONSISTENT_OHLC).toBe(1);
  });

  it("rejects an open outside [low, high]", () => {
    const { rejected } = toPriceBarRows("s1", [bar("2026-07-29", { open: 200 })], "Yahoo", BEFORE);
    expect(rejected.INCONSISTENT_OHLC).toBe(1);
  });

  it.each([
    ["zero close", { close: 0 }],
    ["negative low", { low: -1 }],
    ["NaN high", { high: NaN }],
    ["Infinity open", { open: Infinity }],
  ])("rejects %s", (_label, over) => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("2026-07-29", over as Partial<DailyPrice>)], "Yahoo", BEFORE);
    expect(rows).toHaveLength(0);
    expect(rejected.INVALID_PRICE).toBe(1);
  });

  it("rejects negative volume but allows zero (a genuinely untraded session)", () => {
    expect(toPriceBarRows("s1", [bar("2026-07-29", { volume: -5 })], "Yahoo", BEFORE).rows).toHaveLength(0);
    expect(toPriceBarRows("s1", [bar("2026-07-29", { volume: 0 })], "Yahoo", BEFORE).rows).toHaveLength(1);
  });

  // CoinGecko publishes no true O/H/L and falls back to the close for all three.
  it("accepts a flat bar where open === high === low === close", () => {
    const flat = bar("2026-07-29", { open: 100, high: 100, low: 100, close: 100 });
    const { rows, rejected } = toPriceBarRows("s1", [flat], "CoinGecko", BEFORE);
    expect(rows).toHaveLength(1);
    expect(hasQualityRejections(rejected)).toBe(false);
  });

  it("rejects an unparseable date", () => {
    const { rows, rejected } = toPriceBarRows("s1", [bar("garbage")], "Yahoo", BEFORE);
    expect(rows).toHaveLength(0);
    expect(rejected.INVALID_DATE).toBe(1);
  });

  it("keeps the good bars from a partly-bad window", () => {
    const { rows, rejected } = toPriceBarRows(
      "s1",
      [bar("2026-07-27"), bar("2026-07-28", { close: 0 }), bar("2026-07-29")],
      "Tiingo",
      BEFORE
    );
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-07-27", "2026-07-29"]);
    expect(rejected.INVALID_PRICE).toBe(1);
  });

  it("returns nothing for an empty window", () => {
    const { rows, rejected } = toPriceBarRows("s1", [], "Tiingo", BEFORE);
    expect(rows).toEqual([]);
    expect(hasQualityRejections(rejected)).toBe(false);
  });
});

describe("describeRejections()", () => {
  it("summarises quality rejections and stays silent about in-progress bars", () => {
    const { rejected } = toPriceBarRows(
      "s1",
      [bar("2026-07-30"), bar("2026-07-29", { close: 0 }), bar("2026-07-28", { high: 1 })],
      "Yahoo",
      BEFORE
    );
    const text = describeRejections(rejected);
    expect(text).toContain("INVALID_PRICE=1");
    expect(text).toContain("INCONSISTENT_OHLC=1");
    expect(text).not.toContain("IN_PROGRESS");
  });

  it("is empty when only in-progress bars were dropped", () => {
    const { rejected } = toPriceBarRows("s1", [bar("2026-07-30")], "Yahoo", BEFORE);
    expect(describeRejections(rejected)).toBe("");
    expect(hasQualityRejections(rejected)).toBe(false);
  });
});
