// Pure checks for the daily post-close self-audit.
//
// The performance and calibration pages answer "how predictive are the signals?".
// Nothing answered "did the machine do what its own rules say it should have done?"
// — a protective stop that was never placed, an entry that never filled, a position
// that met an exit condition and stayed open, a stage that ran outside its window.
// Those are correctness bugs, and they were invisible.
//
// Everything here is pure and unit-tested; src/lib/pipeline/review.ts does the I/O
// and hands the data in. Each check returns Findings rather than throwing, so one
// unhappy check never costs you the rest of the report.

import {
  reconcilePosition,
  reconcileRiskManaged,
  reconcileEventPosition,
  riskDistancePct,
  utcDaysBetween,
  sessionsStale,
  STRATEGY_IS_RM,
  type RiskConfig,
  type Strategy,
} from "@/lib/paper-trading";
import { type RiskBlockReason, type RiskLimits } from "@/lib/portfolio-risk";

export type Severity = "info" | "warn" | "fail";

/**
 * One observation. `code` is stable and machine-readable so the agent reading this
 * report can group findings across days without parsing prose; `title`/`detail` are
 * what a human reads in the email.
 */
export type Finding = {
  severity: Severity;
  code: string;
  title: string;
  detail: string;
  refs?: Record<string, string | number | boolean | null>;
};

const finding = (
  severity: Severity,
  code: string,
  title: string,
  detail: string,
  refs?: Finding["refs"]
): Finding => ({ severity, code, title, detail, ...(refs ? { refs } : {}) });

/** Worst severity wins: any fail → FAIL, any warn → WARN, else OK. */
export function overallStatus(findings: Finding[]): "OK" | "WARN" | "FAIL" {
  if (findings.some((f) => f.severity === "fail")) return "FAIL";
  if (findings.some((f) => f.severity === "warn")) return "WARN";
  return "OK";
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const money = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// ── The paper stage's decision log ────────────────────────────────────────────
// Written by runPaperStage, replayed here. Without it the audit can only infer
// intent from state the stage already mutated; with it the exact inputs of every
// decision survive, so the pure reconcilers can be re-run and diffed.

export type OpenState = {
  qty: number;
  entryPrice: number;
  peakPrice: number;
  bearishStreak: number;
  staleStreak: number;
  entryAtrPct: number | null;
};

export type DecisionInputs = {
  score: number;
  /**
   * The score that actually gated the entry decision, when it differs from `score`
   * (COMBINED_RM entering on sentiment alone — see `entryScoreFor`). Optional: pure
   * books and RM books outside that override have no divergence, and logs written
   * before this field existed genuinely lack it, so the replay falls back to `score`.
   */
  entryScore?: number;
  signal: string;
  price: number;
  confidence: number;
  atrPct: number | null;
  runsSinceEntry: number;
  isNewRun: boolean;
  open: OpenState | null;
  /**
   * WHERE `price` came from. The live-quote overlay is per-stock and partial — a name
   * the feed skipped keeps its stored close — so a run is routinely a mix of both, and
   * a run-level flag cannot tell you which side of it any single decision sat on.
   *
   * Note the two are not even the same session: the stored close is the PREVIOUS
   * session's (the quant stage runs ~02:30 UTC and stamps `date` with now()), while a
   * live trade is from the session in progress. Comparing a CLOSE-priced decision with
   * a LIVE_TRADE-priced one is therefore comparing different days.
   *
   * Optional only because logs written before this existed genuinely lack it —
   * `auditRunProvenance` turns that absence into a finding rather than a shrug.
   */
  priceSource?: PriceSource;
};

/** Live tape (session in progress) vs the stored close (previous session). */
export type PriceSource = "LIVE_TRADE" | "CLOSE";

export type LoggedAction = {
  type: "OPEN" | "CLOSE" | "MARK" | "NONE";
  reason?: string | null;
  qty?: number;
  price?: number;
};

export type DecisionRecord = {
  stockId: string;
  ticker: string;
  strategy: Strategy;
  inputs: DecisionInputs;
  /** What the reconciler decided — BEFORE the portfolio gate had its say. */
  action: LoggedAction;
  /** True when the portfolio gate vetoed a would-be OPEN (so nothing was persisted). */
  riskBlocked?: boolean;
  /**
   * WHICH gate rule vetoed it. Without this the log says a book stopped trading but
   * not why, and telling "at the position cap" apart from "kill-switch tripped" means
   * reconstructing book equity by hand from closed-position P&L.
   */
  riskBlockReason?: RiskBlockReason | null;
};

export type PaperRunLog = {
  version: 1;
  ranAt: string;
  flags: {
    // Optional: run logs predating live-quote pricing have no such field. True means
    // at least one of this day's decisions was priced off the live tape, not the
    // previous close — the two are not comparable, so anything trending across days
    // must account for it. `pricing` below says HOW MANY, which is the number that
    // actually matters, because the overlay is partial.
    liveQuotes?: boolean;
    riskBooks: boolean;
    riskLimits: boolean;
    brokerStops: boolean;
    insiderBook: boolean;
    nearClose: boolean;
  };
  /**
   * How this run was priced. A boolean flag proved insufficient: the overlay only
   * applies while the market is open and only to names the feed returned, so a run is
   * routinely a mix of live-tape and previous-session prices, and "was live pricing on"
   * does not answer "what was this book actually marked against".
   *
   * Optional for logs written before it existed; `auditRunProvenance` reports the
   * absence so a missing block is visible rather than read as "off".
   */
  pricing?: {
    /** PAPER_LIVE_QUOTES=1 and market-data keys configured. */
    enabled: boolean;
    /** Broker clock said the session was open (the overlay no-ops otherwise). */
    marketOpen: boolean;
    /** Stocks whose price came from the live tape. */
    livePriced: number;
    /** Stocks with any price at all — the denominator for the above. */
    totalPriced: number;
    /**
     * The convergence sweep's own pricing. It prices names that have no estimate this
     * run, and submits its own orders, so it needs its own numerator/denominator: a run
     * where the main path is 100% live and the sweep is 0% is not a live-priced run.
     * Optional — logs written before the sweep overlay existed omit both.
     */
    sweepLivePriced?: number;
    sweepTotalPriced?: number;
  };
  cfg: RiskConfig;
  decisions: DecisionRecord[];
  errors: string[];
  // `entryOrdersExpired` is optional: run logs written before stale-entry expiry
  // existed have no such field, and the review must still read them.
  counts: { simOpened: number; simClosed: number; ordersSubmitted: number; entryOrdersExpired?: number; intentsRecovered?: number };
};

// ── 1. Decision replay ───────────────────────────────────────────────────────

/**
 * Re-run each logged decision through the same pure reconciler with the same
 * inputs and config, and diff. A mismatch means the persisted outcome and the
 * rules disagree — always a bug, never a tuning question, so it's a `fail`.
 *
 * Uses the config captured in the log rather than today's, so a knob edited
 * between the two stages can't manufacture a mismatch.
 */
export function replayDecisions(log: PaperRunLog): Finding[] {
  const out: Finding[] = [];
  for (const d of log.decisions) {
    const i = d.inputs;
    const expected = STRATEGY_IS_RM[d.strategy]
      ? reconcileRiskManaged({
          score: i.score,
          entryScore: i.entryScore,
          signal: i.signal,
          price: i.price,
          confidence: i.confidence,
          atrPct: i.atrPct,
          runsSinceEntry: i.runsSinceEntry,
          isNewRun: i.isNewRun,
          open: i.open,
          cfg: log.cfg,
        })
      : reconcilePosition(i.signal, i.price, i.confidence, i.open);

    const actual = d.action;
    if (expected.type !== actual.type) {
      out.push(
        finding(
          "fail",
          "REPLAY_TYPE_MISMATCH",
          `${d.ticker} ${d.strategy}: recorded ${actual.type}, rules say ${expected.type}`,
          `Replaying the stage's own inputs (signal ${i.signal}, score ${i.score.toFixed(3)}, price ${i.price.toFixed(2)}) through the reconciler yields ${expected.type}, but the run logged ${actual.type}. The persisted book and the strategy rules disagree.`,
          { ticker: d.ticker, strategy: d.strategy, expected: expected.type, actual: actual.type }
        )
      );
      continue;
    }
    if (expected.type === "CLOSE") {
      const expectedReason = expected.reason ?? null;
      const actualReason = actual.reason ?? null;
      if (expectedReason !== actualReason) {
        out.push(
          finding(
            "fail",
            "REPLAY_REASON_MISMATCH",
            `${d.ticker} ${d.strategy}: exit reason recorded as ${actualReason ?? "none"}, rules say ${expectedReason ?? "none"}`,
            `Both agree the position closed, but the exit rung differs. The exit ladder is first-match-wins, so this means the ladder was evaluated against different state than was logged.`,
            { ticker: d.ticker, strategy: d.strategy, expected: expectedReason, actual: actualReason }
          )
        );
      }
    }
    if (expected.type === "OPEN" && actual.qty != null && !near(expected.qty, actual.qty, 1e-4)) {
      out.push(
        finding(
          "fail",
          "REPLAY_SIZE_MISMATCH",
          `${d.ticker} ${d.strategy}: sized ${actual.qty.toFixed(4)} shares, rules say ${expected.qty.toFixed(4)}`,
          `Position sizing is deterministic given confidence, stop distance and price — a divergence means one of those was not what the log recorded.`,
          { ticker: d.ticker, strategy: d.strategy, expected: expected.qty, actual: actual.qty }
        )
      );
    }
  }
  return out;
}

// ── 2. Invariant audit of persisted positions ────────────────────────────────

export type AuditPosition = {
  id: string;
  ticker: string;
  strategy: Strategy;
  status: "OPEN" | "CLOSED";
  qty: number;
  entryDate: Date;
  entryPrice: number;
  confidence: number;
  entryScore: number | null;
  entrySignal: string | null;
  entryAtrPct: number | null;
  peakPrice: number | null;
  bearishStreak: number;
  staleStreak: number;
  lastMarkDate: Date;
  lastMarkPrice: number | null;
  exitDate: Date | null;
  exitPrice: number | null;
  exitReason: string | null;
  realizedPnl: number | null;
};

/**
 * Config to check today's closes against: the run log's, when today's paper stage
 * left one, since that's the config that actually decided every exit in `closed`
 * (every row is filtered to `exitDate` today, so it's the same run). Falls back to
 * a freshly loaded config on days with no log at all.
 *
 * A naive fresh reload can differ from decision time even within the same day —
 * a DB-backed override edited between the two stages, or a knob pinned by its
 * env var (which wins over the DB and leaves no edit trace `cfgChangedAt` could
 * ever catch) — and either would manufacture a confirmed-streak/min-hold/etc.
 * mismatch against an exit that was perfectly correct when it fired.
 */
export function closedPositionAuditConfig(runLog: PaperRunLog | null, freshCfg: RiskConfig): RiskConfig {
  return runLog?.cfg ?? freshCfg;
}

/**
 * Check closed positions against the rung they claim to have exited on.
 *
 * This is the second, independent layer: the replay above proves the stage agreed
 * with the rules *at decision time*, while these invariants hold against whatever
 * ended up in the table — so they still catch a bad write, and they work on days
 * with no run log at all. Callers should still pass the config via
 * `closedPositionAuditConfig` so a knob change can't manufacture a false positive.
 *
 * `cfgChangedAt` downgrades findings for positions whose life spans a config edit:
 * the audit necessarily uses today's knobs, and a mid-flight change makes an
 * honest exit look wrong.
 */
export function auditClosedPositions(
  closed: AuditPosition[],
  cfg: RiskConfig,
  cfgChangedAt: Date | null
): Finding[] {
  const out: Finding[] = [];
  for (const p of closed) {
    if (!STRATEGY_IS_RM[p.strategy]) continue; // pure books exit on signal flip alone
    if (p.exitPrice == null || p.exitReason == null) continue; // pre-instrumentation
    const stale = cfgChangedAt != null && cfgChangedAt > p.entryDate;
    const sev: Severity = stale ? "info" : "warn";
    const suffix = stale
      ? " (trading config changed during this position's life, so today's knobs may not be the ones it traded under)"
      : "";
    const refs = { ticker: p.ticker, strategy: p.strategy, positionId: p.id, exitReason: p.exitReason };

    const stopPct = riskDistancePct(cfg, p.entryAtrPct, cfg.stopLossPct);
    const runs = utcDaysBetween(p.entryDate, p.exitDate ?? p.lastMarkDate);

    switch (p.exitReason) {
      case "STOP": {
        const trigger = p.entryPrice * (1 - stopPct);
        if (p.exitPrice > trigger && !near(p.exitPrice, trigger)) {
          out.push(
            finding(
              sev,
              "EXIT_STOP_ABOVE_TRIGGER",
              `${p.ticker} ${p.strategy}: stopped out above its stop level`,
              `Exit ${p.exitPrice.toFixed(2)} is above the ${pct(stopPct)} stop at ${trigger.toFixed(2)} (entry ${p.entryPrice.toFixed(2)}). A stop should only fire at or below the trigger${suffix}.`,
              refs
            )
          );
        }
        break;
      }
      case "TRAIL": {
        const armed = p.entryPrice * (1 + cfg.trailActivatePct);
        if (p.peakPrice != null && p.peakPrice < armed && !near(p.peakPrice, armed)) {
          out.push(
            finding(
              sev,
              "EXIT_TRAIL_NOT_ARMED",
              `${p.ticker} ${p.strategy}: trailing stop fired before it was armed`,
              `Peak ${p.peakPrice.toFixed(2)} never reached the ${pct(cfg.trailActivatePct)} activation at ${armed.toFixed(2)} (entry ${p.entryPrice.toFixed(2)}), yet the position exited on TRAIL${suffix}.`,
              refs
            )
          );
        }
        if (runs < cfg.minHoldRuns) {
          out.push(
            finding(
              sev,
              "EXIT_DURING_MIN_HOLD",
              `${p.ticker} ${p.strategy}: TRAIL exit inside the min-hold window`,
              `Held ${runs} run(s), min-hold is ${cfg.minHoldRuns}. Only the hard stop is allowed to fire during min-hold${suffix}.`,
              refs
            )
          );
        }
        break;
      }
      case "SIGNAL": {
        if (p.bearishStreak < cfg.signalConfirmRuns) {
          out.push(
            finding(
              sev,
              "EXIT_SIGNAL_UNCONFIRMED",
              `${p.ticker} ${p.strategy}: signal exit without a confirmed bearish streak`,
              `Bearish streak was ${p.bearishStreak}, confirmation needs ${cfg.signalConfirmRuns}${suffix}.`,
              refs
            )
          );
        }
        if (runs < cfg.minHoldRuns) {
          out.push(
            finding(sev, "EXIT_DURING_MIN_HOLD", `${p.ticker} ${p.strategy}: SIGNAL exit inside the min-hold window`, `Held ${runs} run(s), min-hold is ${cfg.minHoldRuns}${suffix}.`, refs)
          );
        }
        break;
      }
      case "DECAY": {
        if (p.exitPrice <= p.entryPrice) {
          out.push(
            finding(
              sev,
              "EXIT_DECAY_AT_LOSS",
              `${p.ticker} ${p.strategy}: decay exit taken at a loss`,
              `Decay exits are only meant to bank a profit once conviction is gone — exit ${p.exitPrice.toFixed(2)} vs entry ${p.entryPrice.toFixed(2)}. Loss-side staleness belongs to the stop and time exits${suffix}.`,
              refs
            )
          );
        }
        if (p.staleStreak < cfg.decayRuns) {
          out.push(
            finding(sev, "EXIT_DECAY_UNCONFIRMED", `${p.ticker} ${p.strategy}: decay exit before the stale streak matured`, `Stale streak was ${p.staleStreak}, decay needs ${cfg.decayRuns}${suffix}.`, refs)
          );
        }
        break;
      }
      case "TIME": {
        if (cfg.timeStopRuns > 0 && runs < cfg.timeStopRuns) {
          out.push(
            finding(sev, "EXIT_TIME_EARLY", `${p.ticker} ${p.strategy}: time stop fired early`, `Held ${runs} run(s), the time stop is set at ${cfg.timeStopRuns}${suffix}.`, refs)
          );
        }
        const ret = p.entryPrice > 0 ? (p.exitPrice - p.entryPrice) / p.entryPrice : 0;
        if (Math.abs(ret) > cfg.timeStopBandPct && !near(Math.abs(ret), cfg.timeStopBandPct)) {
          out.push(
            finding(
              sev,
              "EXIT_TIME_OUT_OF_BAND",
              `${p.ticker} ${p.strategy}: time stop fired on a position that wasn't flat`,
              `Return at exit was ${pct(ret)}, outside the ±${pct(cfg.timeStopBandPct)} dead-money band. A moving position should have exited on a different rung${suffix}.`,
              refs
            )
          );
        }
        break;
      }
    }

    // Realized P&L must equal qty × (exit − entry); anything else is an arithmetic
    // or write bug, and it silently corrupts every equity curve downstream.
    if (p.realizedPnl != null) {
      const expected = p.qty * (p.exitPrice - p.entryPrice);
      if (!near(expected, p.realizedPnl, 1e-4)) {
        out.push(
          finding(
            "fail",
            "REALIZED_PNL_MISMATCH",
            `${p.ticker} ${p.strategy}: realized P&L doesn't match the fill`,
            `Stored ${money(p.realizedPnl)}, but ${p.qty.toFixed(4)} × (${p.exitPrice.toFixed(2)} − ${p.entryPrice.toFixed(2)}) = ${money(expected)}.`,
            refs
          )
        );
      }
    }
  }
  return out;
}

/**
 * Positions still open that meet an exit condition right now.
 *
 * Only positions the stage actually marked today are judged. A position it never
 * looked at (no fresh estimate, no price) hasn't had its chance, and flagging it
 * would blame the exit ladder for a data gap — that gap is reported separately,
 * once, below. For the rest the stage evaluated this same ladder against this same
 * mark, so a CLOSE here is a genuine missed exit: capital still at risk that the
 * rules wanted out of.
 */
export function auditOpenPositions(open: AuditPosition[], cfg: RiskConfig, today: Date): Finding[] {
  const out: Finding[] = [];
  const unmarked: AuditPosition[] = [];

  for (const p of open) {
    const price = p.lastMarkPrice;
    if (utcDaysBetween(p.lastMarkDate, today) >= 1) {
      unmarked.push(p);
      continue;
    }
    if (price == null) continue;

    if (STRATEGY_IS_RM[p.strategy]) {
      // Re-run with the *persisted* (post-run) streaks and isNewRun=false, which is
      // exactly the state the stage left behind — so the ladder sees what it saw.
      const action = reconcileRiskManaged({
        score: p.entryScore ?? cfg.entryScoreMin + 1e-9, // score isn't stored per-run; entry score is the honest stand-in
        signal: "NEUTRAL", // unknown post-hoc: only suppresses the SIGNAL rung, never invents one
        price,
        confidence: p.confidence,
        atrPct: p.entryAtrPct,
        runsSinceEntry: utcDaysBetween(p.entryDate, today),
        isNewRun: false,
        open: {
          qty: p.qty,
          entryPrice: p.entryPrice,
          peakPrice: p.peakPrice ?? p.entryPrice,
          bearishStreak: p.bearishStreak,
          staleStreak: p.staleStreak,
          entryAtrPct: p.entryAtrPct,
        },
        cfg,
      });
      if (action.type === "CLOSE") {
        out.push(
          finding(
            "fail",
            "MISSED_EXIT",
            `${p.ticker} ${p.strategy}: still open but meets the ${action.reason} exit`,
            `Marked at ${price.toFixed(2)} (entry ${p.entryPrice.toFixed(2)}, peak ${(p.peakPrice ?? p.entryPrice).toFixed(2)}), the exit ladder returns ${action.reason} — but the position is still OPEN after today's run. Capital is exposed that the rules wanted out of.`,
            { ticker: p.ticker, strategy: p.strategy, positionId: p.id, reason: action.reason ?? null }
          )
        );
      }
    }

    // Insider book: time is its only exit, so an over-held position is unambiguous.
    if (p.strategy === "INSIDER") {
      const held = utcDaysBetween(p.entryDate, today);
      const action = reconcileEventPosition(price, held, cfg.insiderHoldDays, p);
      if (action.type === "CLOSE") {
        out.push(
          finding(
            "fail",
            "MISSED_EXIT",
            `${p.ticker} INSIDER: held past its exit date`,
            `Held ${held} days against a ${cfg.insiderHoldDays}-day holding period; the event book's only exit is expiry, so this should have closed.`,
            { ticker: p.ticker, strategy: p.strategy, positionId: p.id }
          )
        );
      }
    }

  }

  // Unmarked positions get ONE finding, not one each. They share a single root
  // cause (the stage didn't see them), and on a bad day there are hundreds — enough
  // to bury the failures that actually need reading.
  if (unmarked.length > 0) {
    const staleDays = Math.max(...unmarked.map((p) => utcDaysBetween(p.lastMarkDate, today)));
    const names = [...new Set(unmarked.map((p) => p.ticker))];
    const shown = names.slice(0, 12).join(", ");
    out.push(
      finding(
        staleDays >= 3 ? "fail" : "warn",
        "POSITIONS_NOT_MARKED",
        `${unmarked.length} open position(s) were not marked today`,
        `Across ${names.length} ticker(s) — ${shown}${names.length > 12 ? `, +${names.length - 12} more` : ""}. The oldest mark is ${staleDays} day(s) old. The exit ladder only runs on positions that get a fresh estimate and price, so these are currently unmanaged: no marks, no stops, no exits.`,
        { positions: unmarked.length, tickers: names.length, staleDays }
      )
    );
  }

  return out;
}

/**
 * Entries that shouldn't have cleared the gate. Sizing and the entry deadband are
 * both deterministic, so a position below either threshold means the gate was
 * bypassed or the stored score is wrong.
 */
export function auditEntries(openedToday: AuditPosition[], cfg: RiskConfig): Finding[] {
  const out: Finding[] = [];
  for (const p of openedToday) {
    if (!STRATEGY_IS_RM[p.strategy]) continue;
    const refs = { ticker: p.ticker, strategy: p.strategy, positionId: p.id };
    if (p.entryScore != null && p.entryScore <= cfg.entryScoreMin) {
      out.push(
        finding(
          "warn",
          "ENTRY_BELOW_DEADBAND",
          `${p.ticker} ${p.strategy}: opened below the entry deadband`,
          `Entry score ${p.entryScore.toFixed(3)} does not clear entryScoreMin ${cfg.entryScoreMin}.`,
          refs
        )
      );
    }
    if (p.confidence < cfg.minConfidence) {
      out.push(
        finding(
          "warn",
          "ENTRY_BELOW_CONFIDENCE",
          `${p.ticker} ${p.strategy}: opened below the confidence floor`,
          `Sized on confidence ${p.confidence.toFixed(3)}, floor is ${cfg.minConfidence}.`,
          refs
        )
      );
    }
  }
  return out;
}

/**
 * Report what the run recorded about ITSELF, and complain when it recorded nothing.
 *
 * This exists because of a specific silent failure. `flags.liveQuotes` was declared in
 * this type, documented as the thing that makes cross-day comparison valid, consumed by
 * readers — and never written by the stage. Being optional, its absence was
 * indistinguishable from "off", so for the whole life of the live-quote feature every
 * run log asserted nothing and every reader inferred "closes" and was wrong. The
 * per-stock overlay count was computed in the same function and discarded.
 *
 * The general rule this encodes: a field that says how the run was configured must
 * either be present or be a finding. An optional provenance field that silently reads
 * as a default is worse than no field, because it converts "unknown" into a confident
 * wrong answer — which is exactly how it failed.
 *
 * `info` when present (it is a statement of fact, not a fault) and `warn` when absent,
 * because a run that cannot say how it was priced cannot be compared with one that can.
 */
export function auditRunProvenance(log: PaperRunLog): Finding[] {
  const p = log.pricing;
  if (!p) {
    return [
      finding(
        "warn",
        "RUN_PROVENANCE_MISSING",
        "Run log records no pricing provenance",
        "The paper run did not record whether its decisions were priced from the live tape or from stored closes. Those are different sessions — a stored close is the PREVIOUS session's — so this day's marks and P&L cannot be soundly compared with a day that did record it. Logs written before the `pricing` block existed will report this until they age out.",
        { hasFlag: log.flags.liveQuotes ?? null }
      ),
    ];
  }

  const mixed = p.livePriced > 0 && p.livePriced < p.totalPriced;
  const out = [
    finding(
      "info",
      "RUN_PRICING",
      `Priced ${p.livePriced}/${p.totalPriced} names from the live tape`,
      `Live quotes ${p.enabled ? "enabled" : "disabled"}, market ${p.marketOpen ? "open" : "closed"} at run time. ` +
        (mixed
          ? `${p.totalPriced - p.livePriced} name(s) fell back to their stored close, which is the PREVIOUS session's — this run mixes two sessions and per-name comparisons must read inputs.priceSource.`
          : p.livePriced === 0
            ? "Every name was priced from its stored close (the previous session's)."
            : "Every name was priced from the live tape.") +
        (p.sweepTotalPriced
          ? ` Convergence sweep: ${p.sweepLivePriced ?? 0}/${p.sweepTotalPriced} live.`
          : ""),
      {
        enabled: p.enabled,
        marketOpen: p.marketOpen,
        livePriced: p.livePriced,
        totalPriced: p.totalPriced,
        sweepLivePriced: p.sweepLivePriced ?? null,
        sweepTotalPriced: p.sweepTotalPriced ?? null,
      }
    ),
  ];

  // The sweep submits real entry orders off its own prices. If the main path priced live
  // and the sweep did not, the run is quietly entering some names on a two-session-old
  // close — the exact asymmetry the sweep overlay was added to remove, so it must be
  // audible rather than inferable from two numbers in a JSON blob.
  if (p.sweepTotalPriced && (p.sweepLivePriced ?? 0) === 0 && p.livePriced > 0) {
    out.push(
      finding(
        "warn",
        "SWEEP_PRICED_STALE",
        `Convergence sweep priced 0/${p.sweepTotalPriced} names live while the main path priced ${p.livePriced}/${p.totalPriced}`,
        "The sweep submits its own entry orders. Pricing them from stored closes while everything else uses the tape re-creates the stale-anchor bias for exactly the names the sweep exists to repair — it retries the names nothing else refreshed. Check the quote feed's response for those tickers.",
        { sweepTotalPriced: p.sweepTotalPriced, livePriced: p.livePriced }
      )
    );
  }
  return out;
}

/**
 * One-step move in a held name's price stream beyond which the move is treated as
 * a suspected corporate action rather than a market move. 0.6 (and its inverse,
 * ~1.67x) is far outside any one-day move the books have actually seen except the
 * CRWD 4:1 split — a real crash that size deserves a manual look anyway, so a rare
 * false fire costs a glance while a miss costs corrupted P&L history.
 */
const CORPORATE_ACTION_RATIO = 0.6;

/**
 * The sim has no split/corporate-action handling: a held name crossing one books
 * the entire basis change as P&L. CRWD's 4:1 split turned a +14% hold into four
 * "-71%" closes of fictitious loss and sat unnoticed for seven weeks
 * because nothing watched for it — every aggregate over closed trades inherited
 * the artifact (OPEN-FINDINGS.md, "CRWD's 4:1 split"). This check watches each
 * OPEN position's price stream day-over-day, so the next basis break surfaces on
 * the day it happens, while the position is still open and the row still repairable
 * before it closes into the statistics.
 */
export function auditCorporateActions(rows: { ticker: string; prevPrice: number; curPrice: number }[]): Finding[] {
  const out: Finding[] = [];
  for (const r of rows) {
    if (!(r.prevPrice > 0) || !(r.curPrice > 0)) continue;
    const ratio = r.curPrice / r.prevPrice;
    if (ratio >= CORPORATE_ACTION_RATIO && ratio <= 1 / CORPORATE_ACTION_RATIO) continue;
    out.push(
      finding(
        "warn",
        "CORPORATE_ACTION_SUSPECT",
        `${r.ticker}: held position's price moved ${((ratio - 1) * 100).toFixed(0)}% in one step`,
        `A one-step move this size in a held name is more often a split or other basis change than a market move, ` +
          `and the sim books a basis change as real P&L (CRWD's 4:1 split booked a large fictitious loss). ` +
          `Verify against the adjusted bars; if it is a corporate action, repair the position rows on the new basis ` +
          `(scripts/repair-crwd-split.ts is the pattern) before the position closes into the statistics.`,
        { ticker: r.ticker, prevPrice: r.prevPrice, curPrice: r.curPrice, ratio: Number(ratio.toFixed(4)) }
      )
    );
  }
  return out;
}

/**
 * A stock whose latest stored bar is this many sessions old (or older) counts as
 * stale. Three leaves one session of slack for a market holiday plus the current
 * session (whose bar is only written by the next quant run), so a long weekend
 * alone cannot trip it.
 */
const BAR_STALE_SESSION_MIN = 3;
/**
 * Share of the universe that must be stale before the finding fires. One delisted
 * or renamed ticker is noise; a fifth of the universe is an outage.
 */
const BAR_STALE_SHARE_WARN = 0.2;

/**
 * Widespread missing PriceBars while the quant stage runs green means bars are
 * being DROPPED, not skipped: the stage fetches prices for every universe name
 * daily and reports rejections only as error strings that keep the run green.
 * That is exactly how the Tiingo ISO-datetime defect ran for three and a half
 * weeks — fresh prices, green workflows, zero bars, null sessionDate — with its
 * own diagnosis printed daily into a log nobody read (OPEN-FINDINGS.md,
 * "The Tiingo date defect, 2026-08-24"). This check watches the DATA, so it fires
 * whatever the cause: validation rejections, a source outage, or a worklist bug.
 */
export function auditBarFreshness(stocks: { ticker: string; lastBar: Date | null }[], today: Date): Finding[] {
  if (stocks.length === 0) return [];
  const stale = stocks.filter((s) => sessionsStale(s.lastBar, today) >= BAR_STALE_SESSION_MIN);
  if (stale.length / stocks.length < BAR_STALE_SHARE_WARN) return [];
  return [
    finding(
      "warn",
      "PRICE_BARS_STALE",
      `${stale.length}/${stocks.length} universe names have no PriceBar for recent sessions`,
      "The quant stage fetches prices for every universe name daily, so missing bars at this scale mean the bars are being dropped between fetch and write — check the stage's errors in the pipeline workflow log for `Price bars rejected` (validation) or a price-source outage. Downstream this also nulls QuantAnalysis.sessionDate, which maxes the staleness-scaled entry buffer and shrinks signal-health's sample.",
      { stale: stale.length, total: stocks.length, sample: stale.slice(0, 8).map((s) => s.ticker).join(", ") }
    ),
  ];
}

/**
 * A book whose every would-be entry is vetoed by the portfolio gate has silently
 * stopped trading. The reconciler keeps producing OPENs and the gate keeps dropping
 * them, so nothing looks broken: no error, no failed stage, just a book that only
 * ever shrinks. COMBINED_RM went 17 trading days that way (2026-07-01 onward) and
 * took the live Alpaca book with it — the live book mirrors COMBINED_RM, so it
 * submitted sells only and drained to three names before anyone noticed.
 *
 * One fully-blocked day is not itself a fault — a book sitting at maxPositions is
 * the cap doing its job. What this surfaces is the *state*, so a run of them is
 * visible rather than inferred. It escalates to `fail` when the book holds MORE
 * than maxPositions, because a book above its own cap cannot open anything until
 * it drains, and nothing in the system trims it back.
 */
export function auditRiskBlocks(decisions: DecisionRecord[], limits: RiskLimits): Finding[] {
  const out: Finding[] = [];
  const byStrategy = new Map<Strategy, DecisionRecord[]>();
  for (const d of decisions) {
    if (!STRATEGY_IS_RM[d.strategy]) continue;
    const list = byStrategy.get(d.strategy) ?? [];
    list.push(d);
    byStrategy.set(d.strategy, list);
  }

  for (const [strategy, ds] of [...byStrategy].sort(([a], [b]) => a.localeCompare(b))) {
    const wanted = ds.filter((d) => d.action.type === "OPEN");
    if (wanted.length === 0) continue;
    const blocked = wanted.filter((d) => d.riskBlocked);
    if (blocked.length < wanted.length) continue; // some got through — the book still trades

    // MARK/CLOSE are the names the book was already holding when the run started,
    // which is what the gate counted against maxPositions.
    const held = ds.filter((d) => d.action.type === "MARK" || d.action.type === "CLOSE").length;
    const overCap = held > limits.maxPositions;

    // Report the dominant reason; a book is usually blocked by one rule, and naming
    // it is the difference between "at the cap" and "kill-switch tripped".
    const tally = new Map<string, number>();
    for (const d of blocked) {
      const r = d.riskBlockReason ?? "UNKNOWN";
      tally.set(r, (tally.get(r) ?? 0) + 1);
    }
    const [reason] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? ["UNKNOWN"];

    out.push(
      finding(
        overCap ? "fail" : "warn",
        "ENTRIES_ALL_RISK_BLOCKED",
        `${strategy}: every entry blocked by the portfolio gate`,
        `All ${wanted.length} would-be entries were vetoed (${reason}). The book holds ${held} of a ${limits.maxPositions} maximum` +
          (overCap
            ? `, which is ABOVE the cap — it cannot open anything until exits drain it below ${limits.maxPositions}, and nothing trims it automatically.`
            : `. It resumes trading as soon as a slot frees.`),
        { strategy, blocked: blocked.length, held, maxPositions: limits.maxPositions, reason }
      )
    );
  }
  return out;
}

/**
 * One number for how far the live book has drifted from the sim book it mirrors.
 *
 * `reconcileBroker` already names the divergent tickers, but it emits one finding per
 * *category* — and a reader scanning "COMBINED_RM is long four names but the
 * paper account is flat in them" cannot tell a routine one-name lag from a live book
 * holding three of eight names and missing its four best. That distinction is the
 * whole point: the live book existing to track the sim is only true while it does.
 *
 * Coverage = sim names the broker actually holds ÷ sim names it should. Sub-share
 * names are excluded from the denominator: whole-share sizing structurally cannot
 * hold them, so counting them as drift would make the metric permanently red for a
 * reason no fix addresses.
 */
export function auditTrackingError(args: {
  simLong: { ticker: string; qty: number }[];
  brokerSymbols: string[];
  minCoverage: number; // fraction below which this is a fail (e.g. 0.7)
}): Finding[] {
  const held = new Set(args.brokerSymbols);
  // A sim leg under one share can never be mirrored — not drift, just granularity.
  const trackable = args.simLong.filter((p) => p.qty >= 1);
  if (trackable.length === 0) return [];

  const missing = trackable.filter((p) => !held.has(p.ticker)).map((p) => p.ticker);
  const coverage = (trackable.length - missing.length) / trackable.length;
  if (missing.length === 0) return [];

  const pct = (coverage * 100).toFixed(0);
  return [
    finding(
      coverage < args.minCoverage ? "fail" : "warn",
      "LIVE_TRACKING_ERROR",
      `Live book tracks ${pct}% of the COMBINED_RM names it mirrors`,
      `Holding ${trackable.length - missing.length} of ${trackable.length} trackable sim names; missing ${missing.join(", ")}. ` +
        `The live book only means anything while it tracks the sim — below ${(args.minCoverage * 100).toFixed(0)}% its P&L stops being evidence about the strategy.`,
      { coverage: Number(coverage.toFixed(3)), missing: missing.join(","), trackable: trackable.length }
    ),
  ];
}

// ── 3. Broker reconciliation ─────────────────────────────────────────────────

export type BrokerPosition = { symbol: string; qty: number; avgEntryPrice: number | null; currentPrice: number | null };
export type BrokerOrder = { id: string; symbol: string; type: string; side: string; qty: number | null };
export type SubmittedOrder = {
  ticker: string;
  side: string;
  signal: string;
  status: string;
  qty: number | null;
  filledQty: number | null;
  filledAvgPrice: number | null;
};

/**
 * Diff the live Alpaca account against the COMBINED_RM book it mirrors. This is
 * where the expensive failures hide: the sim book is always internally consistent
 * because one function writes it, while the broker is a separate system that can
 * reject, partially fill, or quietly drop a protective order.
 */
export function reconcileBroker(args: {
  brokerPositions: BrokerPosition[];
  brokerOrders: BrokerOrder[];
  simLong: { ticker: string; qty: number }[];
  submittedToday: SubmittedOrder[];
  brokerStopsEnabled: boolean;
}): Finding[] {
  const { brokerPositions, brokerOrders, simLong, submittedToday, brokerStopsEnabled } = args;
  const out: Finding[] = [];

  const bySymbol = new Map(brokerPositions.map((p) => [p.symbol, p]));
  const simBySymbol = new Map(simLong.map((p) => [p.ticker, p]));
  const protectiveBySymbol = new Map<string, BrokerOrder>();
  for (const o of brokerOrders) {
    if (o.side === "sell" && (o.type === "stop" || o.type === "trailing_stop")) protectiveBySymbol.set(o.symbol, o);
  }

  // Each class of drift is reported once with its full ticker list rather than
  // once per name. A live/sim divergence is nearly always systemic — one cause,
  // many symbols — and thirty near-identical entries bury everything else.
  const list = (tickers: string[]) => {
    const shown = tickers.slice(0, 12).join(", ");
    return tickers.length > 12 ? `${shown}, +${tickers.length - 12} more` : shown;
  };

  // A sim position under one whole share can't be mirrored by the live book, which
  // only holds whole shares (planBrokerAction floors qty, so the broker enters 0). The
  // sim sizes fractionally on purpose — it measures signal quality, not capital — so
  // that gap is an expected sizing artifact, not drift. Split it out as info so the
  // warning is left to name genuine problems (unfilled, risk-gated, or closed outside
  // the app), which are actually fixable.
  const missingAll = simLong.filter((s) => !bySymbol.has(s.ticker));
  const missing = missingAll.filter((s) => s.qty >= 1).map((s) => s.ticker);
  const subShare = missingAll.filter((s) => s.qty < 1).map((s) => s.ticker);
  if (missing.length > 0) {
    out.push(
      finding(
        "warn",
        "BROKER_POSITIONS_MISSING",
        `${missing.length} sim position(s) the broker isn't holding`,
        `COMBINED_RM is long ${list(missing)} at a full share or more, but the paper account is flat in them. Either those entries never filled, they were gated by the risk caps, or they were closed outside the app. Live and sim P&L diverge for as long as this persists.`,
        { count: missing.length, tickers: missing.join(",") }
      )
    );
  }
  if (subShare.length > 0) {
    out.push(
      finding(
        "info",
        "BROKER_POSITIONS_SUBSHARE",
        `${subShare.length} sub-one-share sim position(s) the live book can't mirror`,
        `COMBINED_RM holds a fractional position (<1 share) in ${list(subShare)}, so whole-share sizing enters 0 at the broker and it stays flat. Expected on a small book — the sim sizes fractionally to measure signal quality — not a fault to fix.`,
        { count: subShare.length, tickers: subShare.join(",") }
      )
    );
  }

  const orphans = brokerPositions.filter((p) => !simBySymbol.has(p.symbol)).map((p) => p.symbol);
  if (orphans.length > 0) {
    out.push(
      finding(
        "warn",
        "BROKER_POSITIONS_ORPHAN",
        `${orphans.length} broker position(s) the strategy no longer wants`,
        `The paper account is long ${list(orphans)} while COMBINED_RM is flat in them. The live book is carrying risk the strategy has already exited.`,
        { count: orphans.length, tickers: orphans.join(",") }
      )
    );
  }

  if (brokerStopsEnabled) {
    // Split by what a protective order could actually cover. Alpaca rejects a
    // fractional stop, so a position under one whole share cannot carry one at all —
    // reporting it as the same `fail` as a naked whole-share position demands of the
    // operator something no run can deliver, and that is exactly what happened: every
    // review from 2026-07-22 on was red for the same 0.94 shares of one name, until
    // FAIL meant nothing. The paper stage now trims such stubs at market (see
    // planWholeShareTrim), so one surviving here is a stub the trim could not clear.
    const unprotectedAll = brokerPositions.filter((p) => !protectiveBySymbol.has(p.symbol));
    const unprotected = unprotectedAll.filter((p) => Math.abs(p.qty) >= 1).map((p) => p.symbol);
    const subShareUnprotected = unprotectedAll.filter((p) => Math.abs(p.qty) < 1).map((p) => p.symbol);
    if (unprotected.length > 0) {
      out.push(
        finding(
          "fail",
          "BROKER_STOPS_MISSING",
          `${unprotected.length} open position(s) with no protective order`,
          `Broker stops are enabled, but no resting stop or trailing stop covers ${list(unprotected)}. These are unprotected against a gap until a later run repairs them — the single most expensive failure mode this review exists to catch.`,
          { count: unprotected.length, tickers: unprotected.join(",") }
        )
      );
    }
    if (subShareUnprotected.length > 0) {
      out.push(
        finding(
          "warn",
          "BROKER_STOPS_SUBSHARE",
          `${subShareUnprotected.length} sub-one-share position(s) no stop can cover`,
          `The paper account holds less than a whole share of ${list(subShareUnprotected)}, and Alpaca rejects a fractional stop or trailing order, so nothing protective can rest on them. The stage trims stubs like these at market on its next run; one that survives needs selling or topping up to a whole share by hand. Exposure is under a share a name, which is why this is not a failure — but nothing is stopping it either.`,
          { count: subShareUnprotected.length, tickers: subShareUnprotected.join(",") }
        )
      );
    }
  }

  const strayStops = [...protectiveBySymbol.keys()].filter((symbol) => !bySymbol.has(symbol));
  if (strayStops.length > 0) {
    out.push(
      finding(
        "warn",
        "BROKER_STOPS_ORPHAN",
        `${strayStops.length} protective order(s) resting with no position`,
        `Sell stops are still working on ${list(strayStops)} although those positions are closed. If one fills it opens a short — which this long-only book has no way to manage.`,
        { count: strayStops.length, tickers: strayStops.join(",") }
      )
    );
  }

  for (const o of submittedToday) {
    const status = o.status.toLowerCase();
    if (status === "rejected" || status === "canceled" || status === "cancelled" || status === "expired") {
      out.push(
        finding(
          "warn",
          "ORDER_NOT_EXECUTED",
          `${o.ticker}: ${o.side} order ${status}`,
          `Submitted on signal ${o.signal} and never executed. The sim books recorded the trade regardless, so live and sim P&L diverge from here.`,
          { ticker: o.ticker, side: o.side, status: o.status }
        )
      );
    } else if (status !== "filled" && o.side === "BUY") {
      out.push(
        finding(
          "info",
          "ORDER_PENDING",
          `${o.ticker}: buy order still ${status}`,
          `Not yet filled at review time. Normal for an order placed into the close; a finding tomorrow would not be.`,
          { ticker: o.ticker, status: o.status }
        )
      );
    }
    if (o.filledQty != null && o.qty != null && o.filledQty > 0 && o.filledQty < o.qty) {
      out.push(
        finding(
          "warn",
          "ORDER_PARTIAL_FILL",
          `${o.ticker}: partial fill (${o.filledQty}/${o.qty})`,
          `The sim book assumes the full size, so position sizing diverges between the books.`,
          { ticker: o.ticker, filledQty: o.filledQty, qty: o.qty }
        )
      );
    }
  }

  return out;
}

// ── 4. Pipeline & data health ────────────────────────────────────────────────

/**
 * What kind of problem a paper-stage error string describes.
 *
 * Every stage error used to land as one undifferentiated `STAGE_ERROR` per message,
 * which made the whole bucket unactionable: a transient 502 from Alpaca and a request
 * the broker will reject on every future run read identically, so the bucket had to be
 * treated as operational and excluded from the improvement agent (see
 * NON_CODE_CODES in lib/pick-finding). That hid a real bug for as long as it existed —
 * eight positions a day whose stop re-anchor was rejected 403 because it was submitted
 * on top of the still-resting stop. Splitting the bucket is what lets a deterministic
 * failure be routed to a code fix while the transient ones stay operational.
 *
 *  - BROKER_ORDER_REJECTED — the broker refused the ORDER (4xx, not rate-limiting).
 *    Our request was invalid for the account's state; retrying it unchanged fails
 *    identically tomorrow, so this is a code bug.
 *  - QUOTE_SYMBOL_INVALID — we asked a market-data endpoint for a symbol it doesn't
 *    know. A ticker-form bug in the request; also a code bug.
 *  - BROKER_API_ERROR — the API call itself failed (5xx, 429, transport). Usually
 *    transient and owned by the operator, not the code.
 *  - STAGE_ERROR — anything unrecognized. Keeps the old catch-all behaviour so a new
 *    failure mode still surfaces (just never auto-routed to a code fix).
 */
export type StageErrorClass = "BROKER_ORDER_REJECTED" | "QUOTE_SYMBOL_INVALID" | "BROKER_API_ERROR" | "STAGE_ERROR";

/** Classify one paper-stage error message. Pure, and the order of tests matters. */
export function classifyStageError(message: string): StageErrorClass {
  // Checked first: an invalid symbol arrives as an HTTP 400 whose body names it, so a
  // status-code test alone would file it as a generic API error.
  if (/invalid symbol/i.test(message)) return "QUOTE_SYMBOL_INVALID";
  // 429 is rate-limiting — a 4xx that says "later", not "never", so it is NOT a
  // rejection of the order's contents.
  if (/order error: 4(?!29)\d\d/.test(message)) return "BROKER_ORDER_REJECTED";
  if (/error: (?:429|5\d\d)/.test(message) || /(?:failed|unreachable|ECONN|ETIMEDOUT|fetch failed)/i.test(message)) {
    return "BROKER_API_ERROR";
  }
  return "STAGE_ERROR";
}

/** The ticker an error is about, when the message names one. */
function stageErrorTicker(message: string): string | null {
  return (
    message.match(/(?:failed|rejected) for ([A-Z][A-Z0-9.-]*)/)?.[1] ??
    message.match(/invalid symbol: ([A-Z][A-Z0-9.-]*)/i)?.[1] ??
    null
  );
}

const STAGE_ERROR_CLASSES: Record<
  StageErrorClass,
  { severity: Severity; title: (n: number) => string; detail: string }
> = {
  BROKER_ORDER_REJECTED: {
    severity: "fail",
    title: (n) => `${n} order(s) the broker rejected outright`,
    detail:
      "Alpaca refused these orders with a 4xx — the request was invalid for the account's state (already-held shares, bad qty, unknown symbol), so it will fail identically on every future run until the code changes. Whatever each order was for (an exit, a stop, a repair) did NOT happen.",
  },
  QUOTE_SYMBOL_INVALID: {
    severity: "warn",
    title: (n) => `${n} symbol(s) the market-data feed doesn't recognize`,
    detail:
      "The app asked for a ticker form Alpaca doesn't use (typically a dash-form class share like BRK-B, which Alpaca names BRK.B). The latest-trades endpoint fails the WHOLE request on one bad symbol, so up to 100 other names silently fell back to stored closes for that run.",
  },
  BROKER_API_ERROR: {
    severity: "warn",
    title: (n) => `${n} broker/API call(s) failed`,
    detail:
      "The call itself failed (5xx, rate limit, or transport). Usually transient — worth watching for a pattern, but there is nothing to fix in code unless it repeats daily.",
  },
  STAGE_ERROR: {
    severity: "warn",
    title: (n) => `${n} unclassified paper-stage error(s)`,
    detail: "The stage reported an error that matches no known class. Read the messages below.",
  },
};

/**
 * Paper-stage errors, one finding per CLASS rather than per message.
 *
 * Per-message findings buried the report: a single root cause hitting eight tickers
 * read as eight separate problems, exactly the failure mode that took an early report
 * to 198 findings. Group by class, carry every affected ticker (or the raw messages
 * when none is named) in the detail.
 */
export function auditStageErrors(errors: string[]): Finding[] {
  const byClass = new Map<StageErrorClass, string[]>();
  for (const err of errors) {
    const cls = classifyStageError(err);
    const existing = byClass.get(cls) ?? [];
    existing.push(err);
    byClass.set(cls, existing);
  }

  const out: Finding[] = [];
  for (const [cls, messages] of byClass) {
    const spec = STAGE_ERROR_CLASSES[cls];
    const tickers = [...new Set(messages.map(stageErrorTicker).filter((t): t is string => t != null))];
    // The messages are the evidence a fix gets written from, so they travel with the
    // finding — capped, because a stage that fails on every name would otherwise ship
    // its whole log into the report.
    const evidence = messages.slice(0, 8).join(" | ") + (messages.length > 8 ? ` | +${messages.length - 8} more` : "");
    out.push(
      finding(spec.severity, cls, spec.title(messages.length), `${spec.detail}\n\n${evidence}`, {
        count: messages.length,
        ...(tickers.length > 0 ? { tickers: tickers.join(",") } : {}),
      })
    );
  }
  return out;
}

export type HealthInput = {
  universeSize: number;
  estimatesToday: number;
  sentimentsToday: number;
  quantToday: number;
  articlesToday: number;
  dataWarningCounts: Record<string, number>;
  paperRanAt: Date | null;
  marketClosedAt: Date | null;
  paperErrors: string[];
  missedTradingDays: string[];
  alertsToday: { type: string; title: string }[];
};

const ACCOUNT_HEALTH_ALERTS = new Set([
  "ACCOUNT_DRAWDOWN",
  "ORDER_FAILURES",
  "BROKER_UNREACHABLE",
  "STALE_PIPELINE",
  "MISSED_PAPER_DAYS",
]);

/** Did the pipeline actually produce today's inputs, and did it trade on time? */
export function auditHealth(h: HealthInput): Finding[] {
  const out: Finding[] = [];

  if (h.estimatesToday === 0) {
    out.push(
      finding(
        "fail",
        "NO_ESTIMATES",
        "No estimates were produced today",
        `The paper stage trades off StockEstimate rows dated today; with none, every book sat idle regardless of what the market did.`,
        { universeSize: h.universeSize }
      )
    );
  } else if (h.universeSize > 0 && h.estimatesToday < h.universeSize * 0.5) {
    out.push(
      finding(
        "warn",
        "PARTIAL_ESTIMATES",
        `Only ${h.estimatesToday} of ${h.universeSize} watched stocks got an estimate`,
        `Stocks without a fresh estimate are skipped entirely — they are neither entered nor marked nor exited, so open positions in them went unmanaged.`,
        { estimatesToday: h.estimatesToday, universeSize: h.universeSize }
      )
    );
  }

  if (h.quantToday === 0) {
    out.push(
      finding("fail", "NO_QUANT", "No quant analyses today", "Mark prices come from QuantAnalysis; with none, no position could be marked, sized or exited.")
    );
  }
  if (h.sentimentsToday === 0) {
    out.push(finding("warn", "NO_SENTIMENT", "No sentiment scores today", "The sentiment and combined books run on stale or missing scores."));
  }
  if (h.articlesToday === 0) {
    out.push(finding("warn", "NO_ARTICLES", "No articles ingested today", "Sentiment has nothing fresh to read, so scores drift toward their previous values."));
  }

  if (h.paperRanAt == null) {
    out.push(finding("fail", "PAPER_DID_NOT_RUN", "The paper stage did not run today", "No equity snapshot exists for today, so no book was marked and no trade was placed."));
  } else if (h.marketClosedAt != null) {
    const mins = (h.paperRanAt.getTime() - h.marketClosedAt.getTime()) / 60_000;
    if (mins > 5) {
      out.push(
        finding(
          "warn",
          "PAPER_RAN_AFTER_CLOSE",
          `The paper stage ran ${Math.round(mins)} min after the close`,
          `It is meant to act inside the final minutes before the close, where liquidity is deepest and the marks match the sim books. Running afterwards means the fills came from a different session than the marks.`,
          { minutesAfterClose: Math.round(mins) }
        )
      );
    } else if (mins < -35) {
      out.push(
        finding(
          "warn",
          "PAPER_RAN_EARLY",
          `The paper stage ran ${Math.round(-mins)} min before the close`,
          `Outside the intended near-close window, so the marks are mid-session prices.`,
          { minutesBeforeClose: Math.round(-mins) }
        )
      );
    }
  }

  out.push(...auditStageErrors(h.paperErrors));

  if (h.missedTradingDays.length > 0) {
    out.push(
      finding(
        "fail",
        "MISSED_TRADING_DAYS",
        `${h.missedTradingDays.length} trading day(s) with no run`,
        `No equity snapshot exists for ${h.missedTradingDays.join(", ")}. Positions went unmanaged on those days — no marks, no exits.`,
        { days: h.missedTradingDays.join(",") }
      )
    );
  }

  // Estimate warnings split into two kinds. Genuine *degraded inputs* — missing price
  // data, too few articles — mean the score rested on thin/missing evidence, so a
  // widespread occurrence is worth a warning. The rest ("signal disagreement", "high
  // volatility", "earnings soon") are normal market *conditions* the estimate already
  // prices into confidence (each docks it 0.1–0.15), not data faults — so they stay
  // informational even when common, and never carry the "degraded inputs" framing.
  // Anything unrecognized keeps the widespread → warn default, so new input problems
  // still surface.
  const isPricedCondition = (w: string) =>
    w.includes("Signal disagreement") || w.includes("High volatility") || w.includes("Earnings in");
  const warned = Object.entries(h.dataWarningCounts).sort((a, b) => b[1] - a[1]);
  for (const [warning, count] of warned.slice(0, 5)) {
    if (count <= 0) continue;
    const condition = isPricedCondition(warning);
    const widespread = count > h.estimatesToday * 0.25;
    out.push(
      finding(
        !condition && widespread ? "warn" : "info",
        "DATA_WARNING",
        `${count} estimate(s) carried "${warning}"`,
        condition
          ? `Estimates flagged this today. It's a market condition the estimate already discounts in its confidence, not a degraded input.`
          : `Estimates flagged this today. Widespread warnings mean the scores that drove trading were built on degraded inputs.`,
        { warning, count }
      )
    );
  }

  for (const a of h.alertsToday) {
    if (ACCOUNT_HEALTH_ALERTS.has(a.type)) {
      out.push(finding("warn", "ACCOUNT_ALERT", `Account alert: ${a.title}`, `The ${a.type} detector fired today.`, { type: a.type }));
    }
  }

  return out;
}

// ── 5. Strategy tuning signals ───────────────────────────────────────────────

export type ClosedTradeStat = {
  strategy: Strategy;
  exitReason: string | null;
  realizedPnl: number;
  returnPct: number;
  holdDays: number;
  exitDate: Date;
};

export type StrategyStats = {
  strategy: Strategy;
  closed: number;
  wins: number;
  hitRate: number | null;
  totalPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  avgHoldDays: number | null;
  payoff: number | null; // avgWin / |avgLoss| — the edge multiple
  exitMix: Record<string, { count: number; totalPnl: number; hitRate: number | null }>;
};

/** Per-book rollup, sliced by exit rung so the ladder can be judged rung by rung. */
export function summarizeStrategies(trades: ClosedTradeStat[]): StrategyStats[] {
  const byStrategy = new Map<Strategy, ClosedTradeStat[]>();
  for (const t of trades) {
    const arr = byStrategy.get(t.strategy);
    if (arr) arr.push(t);
    else byStrategy.set(t.strategy, [t]);
  }

  const stats: StrategyStats[] = [];
  for (const [strategy, arr] of byStrategy) {
    const wins = arr.filter((t) => t.realizedPnl > 0);
    const losses = arr.filter((t) => t.realizedPnl < 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realizedPnl, 0) / wins.length : null;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realizedPnl, 0) / losses.length : null;

    const exitMix: StrategyStats["exitMix"] = {};
    for (const t of arr) {
      const key = t.exitReason ?? "UNRECORDED";
      const bucket = (exitMix[key] ??= { count: 0, totalPnl: 0, hitRate: null });
      bucket.count++;
      bucket.totalPnl += t.realizedPnl;
    }
    for (const [key, bucket] of Object.entries(exitMix)) {
      const rungTrades = arr.filter((t) => (t.exitReason ?? "UNRECORDED") === key);
      bucket.hitRate = rungTrades.length > 0 ? rungTrades.filter((t) => t.realizedPnl > 0).length / rungTrades.length : null;
    }

    stats.push({
      strategy,
      closed: arr.length,
      wins: wins.length,
      hitRate: arr.length > 0 ? wins.length / arr.length : null,
      totalPnl: arr.reduce((s, t) => s + t.realizedPnl, 0),
      avgWin,
      avgLoss,
      avgHoldDays: arr.length > 0 ? arr.reduce((s, t) => s + t.holdDays, 0) / arr.length : null,
      payoff: avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
      exitMix,
    });
  }
  return stats.sort((a, b) => a.strategy.localeCompare(b.strategy));
}

// Below this many trades on a rung, its hit rate is noise — say so rather than
// dressing a handful of trades up as a tuning recommendation.
const MIN_RUNG_SAMPLE = 8;

/**
 * Tuning observations, all severity `info`: these are arguments for changing a
 * knob, never bugs. Each one names the knob and the evidence so the agent reading
 * the report can propose a specific value instead of a vague direction.
 */
export function tuningSignals(stats: StrategyStats[]): Finding[] {
  const out: Finding[] = [];
  for (const s of stats) {
    if (s.closed < MIN_RUNG_SAMPLE) continue;

    for (const [rung, bucket] of Object.entries(s.exitMix)) {
      if (bucket.count < MIN_RUNG_SAMPLE) continue;
      const share = bucket.count / s.closed;

      if (rung === "TIME" && bucket.hitRate != null && bucket.hitRate < 0.35) {
        out.push(
          finding(
            "info",
            "TUNE_TIME_STOP",
            `${s.strategy}: time stops are mostly closing losers (${pct(bucket.hitRate)} win rate over ${bucket.count} trades)`,
            `Dead money is being held to the ${bucket.count}-trade time limit and then released at a loss. A shorter timeStopRuns or a wider timeStopBandPct would recycle that capital sooner. Net ${money(bucket.totalPnl)} from this rung.`,
            { strategy: s.strategy, knob: "timeStopRuns", rungCount: bucket.count, rungHitRate: bucket.hitRate }
          )
        );
      }
      if (rung === "STOP" && share > 0.5) {
        out.push(
          finding(
            "info",
            "TUNE_STOP_DISTANCE",
            `${s.strategy}: ${pct(share)} of exits are hard stops`,
            `Over half of all closes are stop-outs (${bucket.count} of ${s.closed}, net ${money(bucket.totalPnl)}). Stops that tight get hit by noise rather than by a broken thesis — consider a larger atrStopMult or a higher atrStopFloorPct.`,
            { strategy: s.strategy, knob: "atrStopMult", share, rungCount: bucket.count }
          )
        );
      }
      if (rung === "TRAIL" && bucket.hitRate != null && bucket.hitRate > 0.8 && s.payoff != null && s.payoff < 1) {
        out.push(
          finding(
            "info",
            "TUNE_TRAIL_DISTANCE",
            `${s.strategy}: trailing stops win often but small (payoff ${s.payoff.toFixed(2)})`,
            `Trails are banking ${pct(bucket.hitRate)} winners, yet the average win is smaller than the average loss. The trail is probably too tight — a wider trailPct or a later trailRatchetActivatePct would let winners run.`,
            { strategy: s.strategy, knob: "trailPct", payoff: s.payoff }
          )
        );
      }
      if (rung === "DECAY" && bucket.hitRate != null && bucket.hitRate < 0.5) {
        out.push(
          finding(
            "info",
            "TUNE_DECAY_RUNS",
            `${s.strategy}: decay exits are underperforming (${pct(bucket.hitRate)} win rate)`,
            `Decay is meant to bank a profit once conviction fades; at this hit rate it is firing too early. Consider raising decayRuns.`,
            { strategy: s.strategy, knob: "decayRuns", rungHitRate: bucket.hitRate }
          )
        );
      }
    }

    if (s.payoff != null && s.hitRate != null) {
      // Expectancy per trade in R-multiples: below zero the book loses money at its
      // current hit rate no matter how the individual rungs look.
      const expectancy = s.hitRate * s.payoff - (1 - s.hitRate);
      if (expectancy < 0) {
        out.push(
          finding(
            "info",
            "NEGATIVE_EXPECTANCY",
            `${s.strategy}: negative expectancy over ${s.closed} closed trades`,
            `Hit rate ${pct(s.hitRate)} at a payoff of ${s.payoff.toFixed(2)} gives ${expectancy.toFixed(2)}R per trade. The book needs either a higher payoff (wider targets, tighter entries) or a better hit rate to be viable.`,
            { strategy: s.strategy, expectancy, closed: s.closed }
          )
        );
      }
    }
  }
  return out;
}

// ── Report assembly ──────────────────────────────────────────────────────────

export type DailyReviewReport = {
  version: 1;
  date: string; // YYYY-MM-DD (UTC)
  generatedAt: string;
  status: "OK" | "WARN" | "FAIL";
  summary: {
    findings: number;
    fails: number;
    warns: number;
    openPositions: number;
    openedToday: number;
    closedToday: number;
    realizedToday: number;
    ordersSubmittedToday: number;
    replayed: number;
  };
  findings: Finding[];
  strategies: StrategyStats[];
  books: { book: string; equity: number; realizedPnl: number; unrealizedPnl: number; openPositions: number; dayChange: number | null }[];
  notes: string[];
};

/** Order findings worst-first so the email and the agent both lead with what matters. */
export function rankFindings(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code));
}
