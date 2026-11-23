import { describe, it, expect } from "vitest";
import {
  detectLargeBuy,
  isEntityInsider,
  LARGE_BUY_MIN_VALUE,
  LARGE_BUY_FRESH_DAYS,
  IPO_LOCKOUT_DAYS,
} from "@/lib/insider-detect";
import type { InsiderTxn } from "@/lib/insider-sources";

const NOW = new Date("2026-11-23T01:30:00Z");
const DAY = 24 * 60 * 60 * 1000;
const LISTED_LONG_AGO = new Date("2021-07-30T00:00:00Z");

function buy(p: Partial<InsiderTxn> & { value: number; filedDaysAgo?: number; tradedDaysAgo?: number }): InsiderTxn {
  const price = p.price ?? 50;
  return {
    insiderName: p.insiderName ?? "DOE JANE",
    officerTitle: p.officerTitle ?? null,
    isOfficer: p.isOfficer ?? false,
    isDirector: p.isDirector ?? true,
    isTenPctOwner: p.isTenPctOwner ?? false,
    transactionCode: "P",
    txnType: p.txnType ?? "OPEN_MARKET_BUY",
    isDerivative: p.isDerivative ?? false,
    isPlanned: p.isPlanned ?? false,
    shares: p.value / price,
    price,
    value: p.value,
    sharesAfter: null,
    pctHoldingsChg: null,
    transactionDate: new Date(NOW.getTime() - (p.tradedDaysAgo ?? 3) * DAY),
    filingDate: new Date(NOW.getTime() - (p.filedDaysAgo ?? 1) * DAY),
    accessionId: null,
    dedupKey: `${p.insiderName ?? "DOE JANE"}-${p.value}-${Math.random()}`,
  };
}

const opts = { now: NOW, firstPriceDate: LISTED_LONG_AGO };

describe("detectLargeBuy", () => {
  it("fires on a fresh individual open-market buy at the $1M floor", () => {
    const a = detectLargeBuy("ACME", [buy({ value: LARGE_BUY_MIN_VALUE })], opts);
    expect(a?.type).toBe("INSIDER_LARGE_BUY");
    expect(a?.value).toBe(LARGE_BUY_MIN_VALUE);
    expect(a?.title).toBe("ACME $1.0M insider buy");
  });

  it("stays quiet below the floor", () => {
    expect(detectLargeBuy("ACME", [buy({ value: LARGE_BUY_MIN_VALUE - 1 })], opts)).toBeNull();
  });

  it("sums several new individual buys on the same stock", () => {
    const a = detectLargeBuy(
      "ACME",
      [buy({ insiderName: "A", value: 600_000 }), buy({ insiderName: "B", value: 500_000 })],
      opts
    );
    expect(a?.value).toBe(1_100_000);
    expect(a?.message).toContain("2 insiders");
  });

  it("ignores 10b5-1 planned, derivative, and non-buy transactions", () => {
    const txns = [
      buy({ value: 5_000_000, isPlanned: true }),
      buy({ value: 5_000_000, isDerivative: true }),
      buy({ value: 5_000_000, txnType: "OPEN_MARKET_SELL" }),
      buy({ value: 5_000_000, txnType: "OPTION_EXERCISE" }),
    ];
    expect(detectLargeBuy("ACME", txns, opts)).toBeNull();
  });

  it("ignores funds, corporates and pure 10% holders", () => {
    const txns = [
      buy({ value: 5_000_000, insiderName: "SEQUOIA CAPITAL U.S. VENTURE FUND XIV, L.P." }),
      buy({ value: 5_000_000, insiderName: "VOLKSWAGEN AG" }),
      buy({ value: 5_000_000, insiderName: "BUFFETT WARREN E", isTenPctOwner: true, isDirector: false }),
    ];
    expect(detectLargeBuy("ACME", txns, opts)).toBeNull();
  });

  it("ignores buys inside the IPO lockout (allocations, not conviction)", () => {
    const listed = new Date(NOW.getTime() - 30 * DAY);
    expect(detectLargeBuy("NEWCO", [buy({ value: 5_000_000 })], { now: NOW, firstPriceDate: listed })).toBeNull();
    const listedJustClear = new Date(NOW.getTime() - (IPO_LOCKOUT_DAYS + 10) * DAY);
    expect(detectLargeBuy("NEWCO", [buy({ value: 5_000_000 })], { now: NOW, firstPriceDate: listedJustClear })).not.toBeNull();
  });

  it("never fires when the listing date is unknown", () => {
    expect(detectLargeBuy("ACME", [buy({ value: 5_000_000 })], { now: NOW, firstPriceDate: null })).toBeNull();
  });

  it("ignores stale filings so a late backfill doesn't open old trades", () => {
    expect(
      detectLargeBuy("ACME", [buy({ value: 5_000_000, filedDaysAgo: LARGE_BUY_FRESH_DAYS + 1, tradedDaysAgo: 12 })], opts)
    ).toBeNull();
  });

  it("drops parse-error prices (share count in the price field)", () => {
    // ASTS / Vodafone 2024: price = 25,000,000 → value $625T.
    expect(detectLargeBuy("ASTS", [buy({ value: 625e12, price: 25_000_000, insiderName: "DOE JOHN" })], opts)).toBeNull();
  });
});

describe("isEntityInsider", () => {
  it("treats named individuals with a board or officer seat as individuals", () => {
    expect(isEntityInsider({ insiderName: "GELSINGER PATRICK P", isTenPctOwner: false, isOfficer: true, isDirector: true })).toBe(false);
    expect(isEntityInsider({ insiderName: "Ricks David A", isTenPctOwner: true, isOfficer: true, isDirector: false })).toBe(false);
  });

  it("does not trip on surnames that merely contain an entity word", () => {
    expect(isEntityInsider({ insiderName: "AGUILAR MARIA", isTenPctOwner: false, isOfficer: false, isDirector: true })).toBe(false);
    expect(isEntityInsider({ insiderName: "INCE ROBERT", isTenPctOwner: false, isOfficer: false, isDirector: true })).toBe(false);
  });
});
