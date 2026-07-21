import { describe, it, expect } from "vitest";
import {
  replayDecisions,
  auditClosedPositions,
  auditOpenPositions,
  auditEntries,
  reconcileBroker,
  auditHealth,
  summarizeStrategies,
  tuningSignals,
  overallStatus,
  rankFindings,
  type AuditPosition,
  type ClosedTradeStat,
  type DecisionRecord,
  type Finding,
  type HealthInput,
  type PaperRunLog,
} from "@/lib/daily-review";
import { DEFAULT_RISK_CONFIG, type RiskConfig, type Strategy } from "@/lib/paper-trading";

const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG };
const day = (n: number) => new Date(Date.UTC(2026, 6, n));

const codes = (findings: Finding[]) => findings.map((f) => f.code);

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    stockId: "s1",
    ticker: "AAPL",
    strategy: "COMBINED_RM",
    inputs: {
      score: 0.6,
      signal: "BUY",
      price: 100,
      confidence: 0.8,
      atrPct: 2,
      runsSinceEntry: 0,
      isNewRun: true,
      open: null,
    },
    action: { type: "NONE" },
    ...over,
  };
}

function runLog(decisions: DecisionRecord[]): PaperRunLog {
  return {
    version: 1,
    ranAt: day(20).toISOString(),
    flags: { riskBooks: true, riskLimits: true, brokerStops: true, insiderBook: false, nearClose: true },
    cfg,
    decisions,
    errors: [],
    counts: { simOpened: 0, simClosed: 0, ordersSubmitted: 0 },
  };
}

function position(over: Partial<AuditPosition> = {}): AuditPosition {
  return {
    id: "p1",
    ticker: "AAPL",
    strategy: "COMBINED_RM" as Strategy,
    status: "CLOSED",
    qty: 10,
    entryDate: day(1),
    entryPrice: 100,
    confidence: 0.8,
    entryScore: 0.6,
    entrySignal: "BUY",
    entryAtrPct: 2,
    peakPrice: 100,
    bearishStreak: 0,
    staleStreak: 0,
    lastMarkDate: day(20),
    lastMarkPrice: 100,
    exitDate: day(20),
    exitPrice: 100,
    exitReason: null,
    realizedPnl: 0,
    ...over,
  };
}

describe("replayDecisions", () => {
  it("passes when the logged action matches what the rules produce", () => {
    // Flat, score above the deadband and confidence above the floor → OPEN.
    const log = runLog([
      decision({
        action: { type: "OPEN", qty: (cfg.riskPerTrade * 0.8) / 0.06 / 100, price: 100 },
      }),
    ]);
    expect(replayDecisions(log)).toEqual([]);
  });

  it("flags an action type the rules disagree with", () => {
    // Same inputs as above, but the run claims it did nothing.
    const log = runLog([decision({ action: { type: "NONE" } })]);
    const found = replayDecisions(log);
    expect(codes(found)).toEqual(["REPLAY_TYPE_MISMATCH"]);
    expect(found[0].severity).toBe("fail");
    expect(found[0].detail).toContain("OPEN");
  });

  it("flags a mislabelled exit rung", () => {
    // Deep underwater → the hard stop is the first rung that matches.
    const log = runLog([
      decision({
        inputs: {
          score: 0.6,
          signal: "BUY",
          price: 50,
          confidence: 0.8,
          atrPct: 2,
          runsSinceEntry: 10,
          isNewRun: true,
          open: { qty: 10, entryPrice: 100, peakPrice: 100, bearishStreak: 0, staleStreak: 0, entryAtrPct: 2 },
        },
        action: { type: "CLOSE", price: 50, reason: "TRAIL" },
      }),
    ]);
    const found = replayDecisions(log);
    expect(codes(found)).toEqual(["REPLAY_REASON_MISMATCH"]);
    expect(found[0].detail).toContain("first-match-wins");
  });

  it("flags a position sized differently from the rules", () => {
    const log = runLog([decision({ action: { type: "OPEN", qty: 999, price: 100 } })]);
    expect(codes(replayDecisions(log))).toEqual(["REPLAY_SIZE_MISMATCH"]);
  });

  it("replays the pure books through the signal-only reconciler", () => {
    const log = runLog([
      decision({
        strategy: "COMBINED",
        inputs: {
          score: -0.5,
          signal: "SELL",
          price: 90,
          confidence: 0.8,
          atrPct: null,
          runsSinceEntry: 3,
          isNewRun: true,
          open: { qty: 10, entryPrice: 100, peakPrice: 100, bearishStreak: 0, staleStreak: 0, entryAtrPct: null },
        },
        // Pure books close on any non-buy and carry no rung.
        action: { type: "CLOSE", price: 90, reason: null },
      }),
    ]);
    expect(replayDecisions(log)).toEqual([]);
  });

  it("uses the config captured in the log, not today's", () => {
    // entryScoreMin raised above the score: with the logged (default) config the
    // OPEN is correct, and a stricter config today must not manufacture a finding.
    const log = runLog([decision({ action: { type: "OPEN", qty: (cfg.riskPerTrade * 0.8) / 0.06 / 100, price: 100 } })]);
    log.cfg = { ...cfg };
    expect(replayDecisions(log)).toEqual([]);
  });
});

describe("auditClosedPositions", () => {
  it("accepts a stop-out at or below the stop level", () => {
    // entryAtrPct 2% × atrStopMult 2.5 = 5%, floored to atrStopFloorPct 6%.
    const p = position({ exitReason: "STOP", exitPrice: 94, realizedPnl: 10 * (94 - 100) });
    expect(auditClosedPositions([p], cfg, null)).toEqual([]);
  });

  it("flags a stop-out above the stop level", () => {
    const p = position({ exitReason: "STOP", exitPrice: 99, realizedPnl: 10 * (99 - 100) });
    const found = auditClosedPositions([p], cfg, null);
    expect(codes(found)).toContain("EXIT_STOP_ABOVE_TRIGGER");
    expect(found[0].severity).toBe("warn");
  });

  it("softens findings to info when the config changed mid-position", () => {
    const p = position({ exitReason: "STOP", exitPrice: 99, realizedPnl: 10 * (99 - 100) });
    const found = auditClosedPositions([p], cfg, day(10));
    expect(found[0].severity).toBe("info");
    expect(found[0].detail).toContain("trading config changed");
  });

  it("flags a trailing exit that was never armed", () => {
    const p = position({
      exitReason: "TRAIL",
      exitPrice: 102,
      peakPrice: 103, // below entry × (1 + 8%) = 108
      realizedPnl: 10 * (102 - 100),
    });
    expect(codes(auditClosedPositions([p], cfg, null))).toContain("EXIT_TRAIL_NOT_ARMED");
  });

  it("flags an exit inside the min-hold window", () => {
    const p = position({
      exitReason: "SIGNAL",
      entryDate: day(19), // 1 run held, min-hold is 3
      exitDate: day(20),
      exitPrice: 95,
      bearishStreak: 2,
      realizedPnl: 10 * (95 - 100),
    });
    expect(codes(auditClosedPositions([p], cfg, null))).toContain("EXIT_DURING_MIN_HOLD");
  });

  it("flags a signal exit without a confirmed streak", () => {
    const p = position({ exitReason: "SIGNAL", exitPrice: 95, bearishStreak: 1, realizedPnl: 10 * (95 - 100) });
    expect(codes(auditClosedPositions([p], cfg, null))).toContain("EXIT_SIGNAL_UNCONFIRMED");
  });

  it("flags a decay exit taken at a loss", () => {
    const p = position({ exitReason: "DECAY", exitPrice: 95, staleStreak: 6, realizedPnl: 10 * (95 - 100) });
    expect(codes(auditClosedPositions([p], cfg, null))).toContain("EXIT_DECAY_AT_LOSS");
  });

  it("flags a time stop on a position that wasn't flat", () => {
    const p = position({
      exitReason: "TIME",
      entryDate: day(1),
      exitDate: day(30),
      exitPrice: 112, // +12%, outside the ±3% dead-money band
      realizedPnl: 10 * (112 - 100),
    });
    expect(codes(auditClosedPositions([p], cfg, null))).toContain("EXIT_TIME_OUT_OF_BAND");
  });

  it("flags realized P&L that doesn't match the fill, as a failure", () => {
    const p = position({ exitReason: "STOP", exitPrice: 90, realizedPnl: -50 }); // should be -100
    const found = auditClosedPositions([p], cfg, null);
    const mismatch = found.find((f) => f.code === "REALIZED_PNL_MISMATCH");
    expect(mismatch?.severity).toBe("fail");
  });

  it("ignores pure books and pre-instrumentation rows", () => {
    const pure = position({ strategy: "COMBINED" as Strategy, exitReason: "SIGNAL", exitPrice: 50 });
    const legacy = position({ exitReason: null, exitPrice: 50 });
    expect(auditClosedPositions([pure, legacy], cfg, null)).toEqual([]);
  });
});

describe("auditOpenPositions", () => {
  it("says nothing about a healthy open position", () => {
    const p = position({ status: "OPEN", exitDate: null, exitPrice: null, lastMarkPrice: 105, peakPrice: 105 });
    expect(auditOpenPositions([p], cfg, day(20))).toEqual([]);
  });

  it("flags a position still open that meets the stop", () => {
    const p = position({
      status: "OPEN",
      exitDate: null,
      exitPrice: null,
      lastMarkPrice: 80, // well through the 6% stop
      lastMarkDate: day(20),
    });
    const found = auditOpenPositions([p], cfg, day(20));
    expect(codes(found)).toContain("MISSED_EXIT");
    expect(found[0].severity).toBe("fail");
    expect(found[0].detail).toContain("STOP");
  });

  it("flags an insider position held past its hold period", () => {
    const p = position({
      strategy: "INSIDER" as Strategy,
      status: "OPEN",
      entryDate: day(1),
      exitDate: null,
      exitPrice: null,
      lastMarkPrice: 105,
      lastMarkDate: new Date(Date.UTC(2026, 10, 1)),
    });
    const found = auditOpenPositions([p], cfg, new Date(Date.UTC(2026, 10, 1)));
    expect(codes(found)).toContain("MISSED_EXIT");
  });

  it("does not blame the exit ladder for a position the stage never marked", () => {
    // Deep through the stop, but stale — the stage never got to evaluate it, so the
    // honest finding is the missing mark, not a missed exit.
    const p = position({
      status: "OPEN",
      exitDate: null,
      exitPrice: null,
      lastMarkPrice: 60,
      lastMarkDate: day(17),
    });
    const found = auditOpenPositions([p], cfg, day(20));
    expect(codes(found)).toEqual(["POSITIONS_NOT_MARKED"]);
  });

  it("collapses unmarked positions into a single finding", () => {
    const stale = ["AAPL", "MSFT", "NVDA"].map((ticker, i) =>
      position({
        id: `p${i}`,
        ticker,
        status: "OPEN",
        exitDate: null,
        exitPrice: null,
        lastMarkPrice: 101,
        lastMarkDate: day(19),
      })
    );
    const found = auditOpenPositions(stale, cfg, day(20));
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe("POSITIONS_NOT_MARKED");
    expect(found[0].severity).toBe("warn");
    expect(found[0].refs?.positions).toBe(3);
    expect(found[0].detail).toContain("AAPL");
  });

  it("escalates to a failure once marks go badly stale", () => {
    const p = position({
      status: "OPEN",
      exitDate: null,
      exitPrice: null,
      lastMarkPrice: 101,
      lastMarkDate: day(10),
    });
    expect(auditOpenPositions([p], cfg, day(20))[0].severity).toBe("fail");
  });

  it("skips positions with no mark price", () => {
    const p = position({ status: "OPEN", exitDate: null, exitPrice: null, lastMarkPrice: null });
    expect(auditOpenPositions([p], cfg, day(20))).toEqual([]);
  });
});

describe("auditEntries", () => {
  it("flags an entry below the score deadband", () => {
    const p = position({ status: "OPEN", entryScore: 0.1, exitReason: null });
    expect(codes(auditEntries([p], cfg))).toContain("ENTRY_BELOW_DEADBAND");
  });

  it("flags an entry below the confidence floor", () => {
    const p = position({ status: "OPEN", confidence: 0.1, exitReason: null });
    expect(codes(auditEntries([p], cfg))).toContain("ENTRY_BELOW_CONFIDENCE");
  });

  it("accepts a well-formed entry", () => {
    expect(auditEntries([position({ status: "OPEN" })], cfg)).toEqual([]);
  });
});

describe("reconcileBroker", () => {
  const base = {
    brokerPositions: [],
    brokerOrders: [],
    simLong: [],
    submittedToday: [],
    brokerStopsEnabled: true,
  };

  it("is silent when the broker matches the sim book", () => {
    const found = reconcileBroker({
      ...base,
      brokerPositions: [{ symbol: "AAPL", qty: 10, avgEntryPrice: 100, currentPrice: 105 }],
      brokerOrders: [{ id: "o1", symbol: "AAPL", type: "stop", side: "sell", qty: 10 }],
      simLong: [{ ticker: "AAPL", qty: 10 }],
    });
    expect(found).toEqual([]);
  });

  it("flags an open position with no protective order as a failure", () => {
    const found = reconcileBroker({
      ...base,
      brokerPositions: [{ symbol: "AAPL", qty: 10, avgEntryPrice: 100, currentPrice: 105 }],
      simLong: [{ ticker: "AAPL", qty: 10 }],
    });
    const missing = found.find((f) => f.code === "BROKER_STOPS_MISSING");
    expect(missing?.severity).toBe("fail");
  });

  it("does not demand a stop when broker stops are off", () => {
    const found = reconcileBroker({
      ...base,
      brokerStopsEnabled: false,
      brokerPositions: [{ symbol: "AAPL", qty: 10, avgEntryPrice: 100, currentPrice: 105 }],
      simLong: [{ ticker: "AAPL", qty: 10 }],
    });
    expect(codes(found)).not.toContain("BROKER_STOPS_MISSING");
  });

  it("flags a sim position the broker doesn't hold", () => {
    const found = reconcileBroker({ ...base, simLong: [{ ticker: "AAPL", qty: 10 }] });
    expect(codes(found)).toContain("BROKER_POSITIONS_MISSING");
  });

  it("flags a broker position the sim book has exited", () => {
    const found = reconcileBroker({
      ...base,
      brokerStopsEnabled: false,
      brokerPositions: [{ symbol: "TSLA", qty: 5, avgEntryPrice: 200, currentPrice: 190 }],
    });
    expect(codes(found)).toContain("BROKER_POSITIONS_ORPHAN");
  });

  it("flags a protective order resting with no position", () => {
    const found = reconcileBroker({
      ...base,
      brokerOrders: [{ id: "o1", symbol: "NVDA", type: "trailing_stop", side: "sell", qty: 3 }],
    });
    const orphan = found.find((f) => f.code === "BROKER_STOPS_ORPHAN");
    expect(orphan?.detail).toContain("opens a short");
  });

  it("flags rejected orders and partial fills", () => {
    const found = reconcileBroker({
      ...base,
      submittedToday: [
        { ticker: "AAPL", side: "BUY", signal: "STRONG_BUY", status: "rejected", qty: 10, filledQty: 0, filledAvgPrice: null },
        { ticker: "MSFT", side: "BUY", signal: "BUY", status: "filled", qty: 10, filledQty: 4, filledAvgPrice: 300 },
      ],
    });
    expect(codes(found)).toContain("ORDER_NOT_EXECUTED");
    expect(codes(found)).toContain("ORDER_PARTIAL_FILL");
  });
});

describe("auditHealth", () => {
  const healthy: HealthInput = {
    universeSize: 100,
    estimatesToday: 100,
    sentimentsToday: 100,
    quantToday: 100,
    articlesToday: 50,
    dataWarningCounts: {},
    paperRanAt: new Date("2026-07-20T19:55:00Z"),
    marketClosedAt: new Date("2026-07-20T20:00:00Z"),
    paperErrors: [],
    missedTradingDays: [],
    alertsToday: [],
  };

  it("is silent on a healthy day", () => {
    expect(auditHealth(healthy)).toEqual([]);
  });

  it("fails when no estimates were produced", () => {
    const found = auditHealth({ ...healthy, estimatesToday: 0 });
    expect(found.find((f) => f.code === "NO_ESTIMATES")?.severity).toBe("fail");
  });

  it("warns when coverage is partial", () => {
    expect(codes(auditHealth({ ...healthy, estimatesToday: 20 }))).toContain("PARTIAL_ESTIMATES");
  });

  it("fails when the paper stage never ran", () => {
    const found = auditHealth({ ...healthy, paperRanAt: null });
    expect(found.find((f) => f.code === "PAPER_DID_NOT_RUN")?.severity).toBe("fail");
  });

  it("warns when the paper stage ran after the close", () => {
    const found = auditHealth({ ...healthy, paperRanAt: new Date("2026-07-20T20:40:00Z") });
    const late = found.find((f) => f.code === "PAPER_RAN_AFTER_CLOSE");
    expect(late?.title).toContain("40 min after the close");
  });

  it("warns when the paper stage ran far before the close", () => {
    expect(codes(auditHealth({ ...healthy, paperRanAt: new Date("2026-07-20T18:00:00Z") }))).toContain("PAPER_RAN_EARLY");
  });

  it("fails on missed trading days", () => {
    const found = auditHealth({ ...healthy, missedTradingDays: ["2026-07-16", "2026-07-17"] });
    const missed = found.find((f) => f.code === "MISSED_TRADING_DAYS");
    expect(missed?.severity).toBe("fail");
    expect(missed?.detail).toContain("2026-07-16");
  });

  it("escalates a widespread data warning above an isolated one", () => {
    const widespread = auditHealth({ ...healthy, dataWarningCounts: { stale_price: 60 } });
    const isolated = auditHealth({ ...healthy, dataWarningCounts: { stale_price: 2 } });
    expect(widespread.find((f) => f.code === "DATA_WARNING")?.severity).toBe("warn");
    expect(isolated.find((f) => f.code === "DATA_WARNING")?.severity).toBe("info");
  });

  it("surfaces account-health alerts and ignores watchlist ones", () => {
    const found = auditHealth({
      ...healthy,
      alertsToday: [
        { type: "ACCOUNT_DRAWDOWN", title: "Drawdown 12%" },
        { type: "SIGNAL_CHANGE", title: "AAPL upgraded" },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("Drawdown 12%");
  });

  it("reports every stage error", () => {
    const found = auditHealth({ ...healthy, paperErrors: ["Alpaca order failed for AAPL"] });
    expect(found.find((f) => f.code === "STAGE_ERROR")?.detail).toBe("Alpaca order failed for AAPL");
  });
});

describe("summarizeStrategies", () => {
  const trade = (over: Partial<ClosedTradeStat> = {}): ClosedTradeStat => ({
    strategy: "COMBINED_RM" as Strategy,
    exitReason: "STOP",
    realizedPnl: -50,
    returnPct: -0.05,
    holdDays: 5,
    exitDate: day(20),
    ...over,
  });

  it("rolls up hit rate, payoff and hold time per book", () => {
    const stats = summarizeStrategies([
      trade({ realizedPnl: 100, exitReason: "TRAIL", holdDays: 10 }),
      trade({ realizedPnl: 100, exitReason: "TRAIL", holdDays: 10 }),
      trade({ realizedPnl: -50, exitReason: "STOP", holdDays: 4 }),
      trade({ realizedPnl: -50, exitReason: "STOP", holdDays: 4 }),
    ]);
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.closed).toBe(4);
    expect(s.hitRate).toBe(0.5);
    expect(s.avgWin).toBe(100);
    expect(s.avgLoss).toBe(-50);
    expect(s.payoff).toBe(2);
    expect(s.avgHoldDays).toBe(7);
    expect(s.totalPnl).toBe(100);
    expect(s.exitMix.TRAIL.count).toBe(2);
    expect(s.exitMix.TRAIL.hitRate).toBe(1);
    expect(s.exitMix.STOP.hitRate).toBe(0);
  });

  it("buckets unrecorded exit reasons separately", () => {
    const stats = summarizeStrategies([trade({ exitReason: null })]);
    expect(stats[0].exitMix.UNRECORDED.count).toBe(1);
  });

  it("splits books apart", () => {
    const stats = summarizeStrategies([trade(), trade({ strategy: "QUANT_RM" as Strategy })]);
    expect(stats.map((s) => s.strategy)).toEqual(["COMBINED_RM", "QUANT_RM"]);
  });
});

describe("tuningSignals", () => {
  const many = (n: number, over: Partial<ClosedTradeStat>): ClosedTradeStat[] =>
    Array.from({ length: n }, () => ({
      strategy: "COMBINED_RM" as Strategy,
      exitReason: "STOP",
      realizedPnl: -50,
      returnPct: -0.05,
      holdDays: 5,
      exitDate: day(20),
      ...over,
    }));

  it("stays quiet below the minimum sample", () => {
    const stats = summarizeStrategies(many(4, { exitReason: "TIME", realizedPnl: -10 }));
    expect(tuningSignals(stats)).toEqual([]);
  });

  it("flags time stops that mostly close losers", () => {
    const stats = summarizeStrategies([
      ...many(9, { exitReason: "TIME", realizedPnl: -10 }),
      ...many(3, { exitReason: "TRAIL", realizedPnl: 40 }),
    ]);
    const found = tuningSignals(stats);
    const tune = found.find((f) => f.code === "TUNE_TIME_STOP");
    expect(tune?.severity).toBe("info");
    expect(tune?.refs?.knob).toBe("timeStopRuns");
  });

  it("flags a stop distance that dominates the exit mix", () => {
    const stats = summarizeStrategies([
      ...many(10, { exitReason: "STOP", realizedPnl: -50 }),
      ...many(2, { exitReason: "TRAIL", realizedPnl: 60 }),
    ]);
    const tune = tuningSignals(stats).find((f) => f.code === "TUNE_STOP_DISTANCE");
    expect(tune?.refs?.knob).toBe("atrStopMult");
  });

  it("reports negative expectancy", () => {
    const stats = summarizeStrategies([
      ...many(3, { exitReason: "TRAIL", realizedPnl: 10 }),
      ...many(9, { exitReason: "STOP", realizedPnl: -50 }),
    ]);
    expect(codes(tuningSignals(stats))).toContain("NEGATIVE_EXPECTANCY");
  });

  it("never raises anything above info — tuning is not a bug", () => {
    const stats = summarizeStrategies([
      ...many(10, { exitReason: "STOP", realizedPnl: -50 }),
      ...many(2, { exitReason: "TRAIL", realizedPnl: 60 }),
    ]);
    expect(tuningSignals(stats).every((f) => f.severity === "info")).toBe(true);
  });
});

describe("overallStatus / rankFindings", () => {
  const f = (severity: Finding["severity"], code: string): Finding => ({
    severity,
    code,
    title: code,
    detail: code,
  });

  it("takes the worst severity", () => {
    expect(overallStatus([])).toBe("OK");
    expect(overallStatus([f("info", "A")])).toBe("OK");
    expect(overallStatus([f("info", "A"), f("warn", "B")])).toBe("WARN");
    expect(overallStatus([f("warn", "B"), f("fail", "C")])).toBe("FAIL");
  });

  it("ranks failures first and is stable by code", () => {
    const ranked = rankFindings([f("info", "Z"), f("fail", "B"), f("warn", "M"), f("fail", "A")]);
    expect(ranked.map((r) => r.code)).toEqual(["A", "B", "M", "Z"]);
  });
});
