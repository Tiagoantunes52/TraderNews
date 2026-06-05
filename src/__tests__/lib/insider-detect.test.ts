import { describe, it, expect } from "vitest";
import {
  summarizeInsider,
  detectInsiderClusterBuy,
  detectInsiderFlowShift,
  detectCsuiteBuy,
  CLUSTER_BUYERS_THRESHOLD,
  CSUITE_BUY_MIN_VALUE,
  type PrevInsiderSummary,
} from "@/lib/insider-detect";
import type { InsiderTxn, InsiderTxnType } from "@/lib/insider-sources";

const NOW = new Date("2026-06-05T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function mk(p: {
  txnType: InsiderTxnType;
  daysAgo: number;
  insiderName?: string;
  shares?: number;
  value?: number;
  pctHoldingsChg?: number;
  officerTitle?: string;
  isOfficer?: boolean;
  isPlanned?: boolean;
}): InsiderTxn {
  const txDate = new Date(NOW.getTime() - p.daysAgo * DAY);
  return {
    insiderName: p.insiderName ?? "Insider",
    officerTitle: p.officerTitle ?? null,
    isOfficer: p.isOfficer ?? false,
    isDirector: false,
    isTenPctOwner: false,
    transactionCode: "P",
    txnType: p.txnType,
    isDerivative: false,
    isPlanned: p.isPlanned ?? false,
    shares: p.shares ?? 0,
    price: null,
    value: p.value ?? null,
    sharesAfter: null,
    pctHoldingsChg: p.pctHoldingsChg ?? null,
    transactionDate: txDate,
    filingDate: txDate,
    accessionId: null,
    dedupKey: `${p.insiderName}-${p.daysAgo}-${Math.random()}`,
  };
}

/** A previous-summary stub; override only the fields a test cares about. */
function prev(p: Partial<PrevInsiderSummary>): PrevInsiderSummary {
  return { distinctBuyers14d: 0, netValue90d: 0, csuiteBuyValue14d: 0, ...p };
}

describe("summarizeInsider", () => {
  it("aggregates open-market buys/sells and excludes comp/admin noise", () => {
    const txns = [
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 5, insiderName: "A", shares: 2000, value: 100_000 }),
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 3, insiderName: "B", shares: 1000, value: 50_000 }),
      mk({ txnType: "OPEN_MARKET_SELL", daysAgo: 10, insiderName: "C", shares: -600, value: 30_000 }),
      mk({ txnType: "GRANT", daysAgo: 2, insiderName: "A", shares: 500, value: 0 }), // noise
      mk({ txnType: "OPTION_EXERCISE", daysAgo: 1, insiderName: "D", shares: 800, value: 40_000 }), // noise
    ];
    const s = summarizeInsider(txns, null, NOW);

    expect(s.buyCount90d).toBe(2);
    expect(s.sellCount90d).toBe(1);
    expect(s.distinctBuyers90d).toBe(2);
    expect(s.distinctSellers90d).toBe(1);
    expect(s.buyValue90d).toBe(150_000);
    expect(s.sellValue90d).toBe(30_000);
    expect(s.netValue90d).toBe(120_000);
    expect(s.netShares90d).toBe(2400); // 2000 + 1000 - 600 (noise excluded)
    expect(s.distinctBuyers14d).toBe(2);
    expect(s.convictionScore).toBeCloseTo(120_000 / 180_000, 5);
  });

  it("excludes buys outside the 14-day window from the cluster count", () => {
    const txns = [
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 3, insiderName: "A", shares: 1, value: 10 }),
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 20, insiderName: "E", shares: 1, value: 10 }),
    ];
    const s = summarizeInsider(txns, null, NOW);
    expect(s.distinctBuyers90d).toBe(2);
    expect(s.distinctBuyers14d).toBe(1); // E's buy is 20 days old
  });

  it("folds mspr into the conviction score", () => {
    const txns = [mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 1, insiderName: "A", shares: 1, value: 100_000 })];
    const s = summarizeInsider(txns, -100, NOW);
    // base = +1 (all buys), blended: 0.7*1 + 0.3*(-1) = 0.4
    expect(s.convictionScore).toBeCloseTo(0.4, 5);
  });

  it("emits a CLUSTER_BUY signal when enough distinct insiders buy", () => {
    const txns = [
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "A", shares: 1, value: 10 }),
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "B", shares: 1, value: 10 }),
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "C", shares: 1, value: 10 }),
    ];
    const s = summarizeInsider(txns, null, NOW);
    expect(s.signals.some((sig) => sig.type === "CLUSTER_BUY")).toBe(true);
  });
});

describe("summarizeInsider C-suite", () => {
  it("sums open-market C-suite buys (by title/role) in the 14d window", () => {
    const txns = [
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "Boss", value: 90_000, isOfficer: true, officerTitle: "Chief Executive Officer" }),
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 5, insiderName: "Money", value: 40_000, isOfficer: true, officerTitle: "CFO" }),
    ];
    const s = summarizeInsider(txns, null, NOW);
    expect(s.csuiteBuyValue14d).toBe(130_000);
    expect(s.signals.some((sig) => sig.type === "CSUITE_BUY")).toBe(true);
  });

  it("excludes planned (10b5-1), non-officer, non-C-suite, and out-of-window buys", () => {
    const txns = [
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "Planned", value: 500_000, isOfficer: true, officerTitle: "CEO", isPlanned: true }), // 10b5-1
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "Acct", value: 500_000, isOfficer: true, officerTitle: "Principal Accounting Officer" }), // not C-suite
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 2, insiderName: "Dir", value: 500_000, isOfficer: false }), // not an officer
      mk({ txnType: "OPEN_MARKET_BUY", daysAgo: 30, insiderName: "Old", value: 500_000, isOfficer: true, officerTitle: "CEO" }), // outside 14d
    ];
    const s = summarizeInsider(txns, null, NOW);
    expect(s.csuiteBuyValue14d).toBe(0);
    expect(s.signals.some((sig) => sig.type === "CSUITE_BUY")).toBe(false);
  });
});

describe("detectInsiderClusterBuy", () => {
  it("fires on the upward crossing of the buyer threshold", () => {
    const alert = detectInsiderClusterBuy("AAPL", prev({ distinctBuyers14d: 2 }), { distinctBuyers14d: 3 });
    expect(alert?.type).toBe("INSIDER_CLUSTER_BUY");
    expect(alert?.value).toBe(3);
  });

  it("does not re-fire while already above threshold", () => {
    expect(detectInsiderClusterBuy("AAPL", prev({ distinctBuyers14d: 3 }), { distinctBuyers14d: 4 })).toBeNull();
  });

  it("does not fire below threshold or without a prior summary", () => {
    expect(detectInsiderClusterBuy("AAPL", prev({ distinctBuyers14d: 0 }), { distinctBuyers14d: 2 })).toBeNull();
    expect(detectInsiderClusterBuy("AAPL", null, { distinctBuyers14d: CLUSTER_BUYERS_THRESHOLD })).toBeNull();
  });
});

describe("detectInsiderFlowShift", () => {
  it("fires when 90-day net flow flips to buying above the floor", () => {
    const alert = detectInsiderFlowShift("AAPL", prev({ netValue90d: -200_000 }), { netValue90d: 80_000 });
    expect(alert?.type).toBe("INSIDER_FLOW_SHIFT");
    expect(alert?.title).toContain("buyers");
  });

  it("fires when flow flips to selling above the floor", () => {
    const alert = detectInsiderFlowShift("AAPL", prev({ netValue90d: 120_000 }), { netValue90d: -90_000 });
    expect(alert?.title).toContain("sellers");
  });

  it("ignores sub-floor flips and no-flip / cold-start cases", () => {
    expect(detectInsiderFlowShift("AAPL", prev({ netValue90d: -100_000 }), { netValue90d: 30_000 })).toBeNull(); // below floor
    expect(detectInsiderFlowShift("AAPL", prev({ netValue90d: -100_000 }), { netValue90d: -50_000 })).toBeNull(); // no flip
    expect(detectInsiderFlowShift("AAPL", null, { netValue90d: 80_000 })).toBeNull(); // cold start
  });
});

describe("detectCsuiteBuy", () => {
  it("fires when C-suite buying crosses up through the value floor", () => {
    const alert = detectCsuiteBuy("AAPL", prev({ csuiteBuyValue14d: 0 }), { csuiteBuyValue14d: CSUITE_BUY_MIN_VALUE });
    expect(alert?.type).toBe("INSIDER_CSUITE_BUY");
    expect(alert?.value).toBe(CSUITE_BUY_MIN_VALUE);
  });

  it("does not re-fire while already above the floor", () => {
    expect(detectCsuiteBuy("AAPL", prev({ csuiteBuyValue14d: 150_000 }), { csuiteBuyValue14d: 200_000 })).toBeNull();
  });

  it("does not fire below the floor or without a prior summary", () => {
    expect(detectCsuiteBuy("AAPL", prev({ csuiteBuyValue14d: 0 }), { csuiteBuyValue14d: 50_000 })).toBeNull();
    expect(detectCsuiteBuy("AAPL", null, { csuiteBuyValue14d: CSUITE_BUY_MIN_VALUE })).toBeNull();
  });
});
