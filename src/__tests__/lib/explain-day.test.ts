import { describe, it, expect } from "vitest";
import { explainDay, formatDayExplanation, type DayInput, type DisagreementKind } from "@/lib/explain-day";
import type { PaperRunLog, DecisionRecord } from "@/lib/daily-review";
import { DEFAULT_RISK_CONFIG } from "@/lib/paper-trading";

const DAY = "2026-07-29";
const SESSION = "2026-07-28"; // the session a 02:20 UTC run on DAY reads

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    stockId: "s1",
    ticker: "AAPL",
    strategy: "COMBINED_RM",
    inputs: {
      score: 0.7,
      signal: "BUY",
      price: 200,
      confidence: 0.8,
      atrPct: 2,
      runsSinceEntry: 0,
      isNewRun: true,
      open: null,
      priceSource: "CLOSE",
    },
    action: { type: "NONE" },
    ...over,
  } as DecisionRecord;
}

function runLog(over: Partial<PaperRunLog> = {}): PaperRunLog {
  return {
    version: 1,
    ranAt: `${DAY}T02:20:00.000Z`,
    flags: { riskBooks: true, riskLimits: true, brokerStops: true, insiderBook: true, nearClose: false },
    pricing: { enabled: true, marketOpen: false, livePriced: 0, totalPriced: 1 },
    cfg: { ...DEFAULT_RISK_CONFIG },
    decisions: [],
    errors: [],
    counts: { simOpened: 0, simClosed: 0, ordersSubmitted: 0 },
    ...over,
  };
}

function input(over: Partial<DayInput> = {}): DayInput {
  return {
    day: DAY,
    run: runLog(),
    reviewStatus: "OK",
    quant: [{ stockId: "s1", ticker: "AAPL", price: 200, sessionDate: SESSION }],
    bars: [{ stockId: "s1", date: SESSION, close: 200 }],
    opened: [],
    closed: [],
    orders: [],
    ...over,
  };
}

const kinds = (i: DayInput): DisagreementKind[] => explainDay(i).disagreements.map((d) => d.kind);

describe("explainDay() — session alignment", () => {
  it("reports the declared session, which is not the run day", () => {
    const x = explainDay(input());
    expect(x.session.declared).toEqual([{ date: SESSION, rows: 1 }]);
    expect(x.day).toBe(DAY);
    expect(x.disagreements).toEqual([]);
  });

  it("flags rows that declare no session instead of assuming the run day", () => {
    const x = explainDay(
      input({ quant: [{ stockId: "s1", ticker: "BTC-USD", price: 200, sessionDate: null }] })
    );
    expect(x.session.undeclared).toBe(1);
    expect(kinds(input({ quant: [{ stockId: "s1", ticker: "BTC-USD", price: 200, sessionDate: null }] }))).toContain(
      "SESSION_UNDECLARED"
    );
  });

  it("flags a run whose rows disagree about which session they read", () => {
    expect(
      kinds(
        input({
          quant: [
            { stockId: "s1", ticker: "AAPL", price: 200, sessionDate: SESSION },
            { stockId: "s2", ticker: "MSFT", price: 300, sessionDate: "2026-07-27" },
          ],
          bars: [
            { stockId: "s1", date: SESSION, close: 200 },
            { stockId: "s2", date: "2026-07-27", close: 300 },
          ],
        })
      )
    ).toContain("SESSION_SPLIT");
  });
});

describe("explainDay() — bar vs stored close", () => {
  it("names the session a price actually belongs to when the label is wrong", () => {
    const x = explainDay(
      input({
        quant: [{ stockId: "s1", ticker: "AAPL", price: 195, sessionDate: SESSION }],
        bars: [
          { stockId: "s1", date: "2026-07-27", close: 195 },
          { stockId: "s1", date: SESSION, close: 200 },
        ],
        // The decision followed the (wrong-session) stored close, so only the label is at fault.
        run: runLog({ decisions: [decision({ inputs: { ...decision().inputs, price: 195 } })] }),
      })
    );
    const g = x.disagreements.find((d) => d.kind === "QUANT_WRONG_SESSION");
    expect(g?.severity).toBe("fail");
    expect(g?.detail).toContain("2026-07-27");
  });

  it("reports an unexplained ratio rather than silently accepting it", () => {
    const x = explainDay(
      input({
        quant: [{ stockId: "s1", ticker: "PFE", price: 202, sessionDate: SESSION }],
        bars: [{ stockId: "s1", date: SESSION, close: 200 }],
        run: runLog({ decisions: [decision({ ticker: "PFE", inputs: { ...decision().inputs, price: 202 } })] }),
      })
    );
    expect(x.disagreements.find((d) => d.kind === "QUANT_OFF_BAR")?.detail).toContain("1.0100");
  });

  it("stays silent for a name with no bar coverage", () => {
    expect(
      kinds(input({ quant: [{ stockId: "s9", ticker: "BA.L", price: 12, sessionDate: SESSION }], bars: [] }))
    ).not.toContain("QUANT_OFF_BAR");
  });
});

describe("explainDay() — decision vs stored close", () => {
  it("catches a CLOSE-priced decision that did not use the stored close", () => {
    const x = explainDay(input({ run: runLog({ decisions: [decision({ inputs: { ...decision().inputs, price: 210 } })] }) }));
    const g = x.disagreements.find((d) => d.kind === "DECISION_OFF_QUANT");
    expect(g?.severity).toBe("fail");
    expect(g?.subject).toBe("AAPL/COMBINED_RM");
  });

  it("does not compare a live-tape price against the stored close — different sessions", () => {
    expect(
      kinds(
        input({
          run: runLog({
            decisions: [decision({ inputs: { ...decision().inputs, price: 210, priceSource: "LIVE_TRADE" } })],
          }),
        })
      )
    ).not.toContain("DECISION_OFF_QUANT");
  });

  it("counts decisions by how each was priced, including the unknowable ones", () => {
    const noSource = decision();
    delete noSource.inputs.priceSource;
    const x = explainDay(
      input({
        run: runLog({
          decisions: [decision(), decision({ inputs: { ...decision().inputs, priceSource: "LIVE_TRADE" } }), noSource],
        }),
      })
    );
    expect(x.decisions.priced).toEqual({ live: 1, close: 1, unknown: 1 });
  });
});

describe("explainDay() — decision vs persisted state", () => {
  const openDecision = decision({ action: { type: "OPEN", qty: 5, price: 200 } });

  it("flags an OPEN that never became a position", () => {
    expect(kinds(input({ run: runLog({ decisions: [openDecision] }) }))).toContain("OPEN_NOT_PERSISTED");
  });

  it("accepts an OPEN the risk gate vetoed — nothing was supposed to be written", () => {
    expect(
      kinds(input({ run: runLog({ decisions: [decision({ ...openDecision, riskBlocked: true, riskBlockReason: "MAX_POSITIONS" })] }) }))
    ).not.toContain("OPEN_NOT_PERSISTED");
  });

  const position = (strategy: string) => ({
    stockId: "s1",
    ticker: "AAPL",
    strategy,
    status: "OPEN",
    entryDate: DAY,
    exitDate: null,
    exitReason: null,
    qty: 5,
    entryPrice: 200,
    exitPrice: null,
  });

  it("flags a position no decision asked for", () => {
    expect(
      kinds(input({ run: runLog({ decisions: [decision()] }), opened: [position("COMBINED_RM")] }))
    ).toContain("OPEN_UNEXPLAINED");
  });

  it("ignores books that never reach the decision log, like INSIDER", () => {
    expect(
      kinds(input({ run: runLog({ decisions: [decision()] }), opened: [position("INSIDER")] }))
    ).not.toContain("OPEN_UNEXPLAINED");
  });

  it("flags a close with no exitReason — the trade cannot be attributed", () => {
    expect(
      kinds(
        input({
          run: runLog({ decisions: [decision({ action: { type: "CLOSE", reason: "STOP" } })] }),
          closed: [
            {
              stockId: "s1",
              ticker: "AAPL",
              strategy: "COMBINED_RM",
              status: "CLOSED",
              entryDate: "2026-07-20",
              exitDate: DAY,
              exitReason: null,
              qty: 5,
              entryPrice: 190,
              exitPrice: 200,
            },
          ],
        })
      )
    ).toEqual(["EXIT_REASON_MISSING"]);
  });
});

describe("explainDay() — provenance and orders", () => {
  it("flags a missing pricing block instead of reading it as 'live quotes off'", () => {
    const log = runLog();
    delete log.pricing;
    const x = explainDay(input({ run: log }));
    expect(x.pricing).toBeNull();
    expect(x.disagreements.find((d) => d.kind === "PRICING_UNDECLARED")?.detail).toContain("Absent does NOT mean");
  });

  it("fails when there is no run log at all", () => {
    expect(kinds(input({ run: null }))).toContain("NO_RUN_LOG");
  });

  it("surfaces an order still working with no fill, but not a terminal one", () => {
    const order = { stockId: "s1", ticker: "AAPL", side: "BUY", status: "new", filledQty: null, submittedAt: `${DAY}T13:31:00.000Z` };
    expect(kinds(input({ orders: [order] }))).toContain("ORDER_UNRESOLVED");
    expect(kinds(input({ orders: [{ ...order, status: "canceled" }] }))).not.toContain("ORDER_UNRESOLVED");
    expect(kinds(input({ orders: [{ ...order, status: "filled", filledQty: 5 }] }))).not.toContain("ORDER_UNRESOLVED");
  });

  it("sorts failures ahead of warnings ahead of info", () => {
    const x = explainDay(
      input({
        run: runLog({ decisions: [decision({ action: { type: "OPEN", qty: 5, price: 200 } })] }),
        quant: [{ stockId: "s1", ticker: "AAPL", price: 200, sessionDate: null }],
        orders: [{ stockId: "s1", ticker: "AAPL", side: "BUY", status: "new", filledQty: null, submittedAt: `${DAY}T13:31:00.000Z` }],
      })
    );
    expect(x.disagreements.map((g) => g.severity)).toEqual(["fail", "warn", "info"]);
  });
});

describe("formatDayExplanation()", () => {
  it("spells out the session offset rather than leaving it to be re-derived", () => {
    const text = formatDayExplanation(explainDay(input()));
    expect(text).toContain(`prices on this run describe ${SESSION}, not ${DAY}`);
    expect(text).toContain("disagreements: none");
  });

  it("says pricing is undeclared rather than printing a default", () => {
    const log = runLog();
    delete log.pricing;
    expect(formatDayExplanation(explainDay(input({ run: log })))).toContain("pricing    UNDECLARED");
  });
});
