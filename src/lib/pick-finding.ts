// Choose the ONE finding an improvement run should try to fix.
//
// The daily review (src/lib/daily-review.ts) emits Finding[]; this module turns that
// list into a single actionable target for the improvement agent, or nothing. It's
// pure — no report fetching, no PR listing — so it's deterministic and unit-tested;
// scripts/pick-finding.ts does the I/O and hands the data in (the same split as
// daily-review.ts vs pipeline/review.ts).
//
// Two things get a finding excluded:
//   1. It isn't a code bug the agent can patch — operational, data-health, broker
//      reconciliation, or strategy-tuning findings. These are surfaced by NON_CODE_CODES
//      below and belong to an operator or (for tuning) the backtest track, not a code PR.
//   2. It's already being handled — an open or recently-closed auto-improve PR exists
//      for that code (the caller passes those codes in).
//
// One finding per run keeps each PR small and reviewable.

import { type Finding, type Severity } from "@/lib/daily-review";

/**
 * Finding codes the agent must NOT open a code PR for. Everything here is either an
 * operational/data condition (nothing to fix in code — a pipeline didn't run, inputs
 * were missing), a live/sim broker reconciliation drift (fixed by operating the
 * account, not editing code), or an `info` strategy-tuning signal (owned by the
 * backtest-gated tuning track, never an LLM code edit). Any code NOT listed here —
 * the REPLAY_*, EXIT_*, ENTRY_*, REALIZED_PNL_MISMATCH, MISSED_EXIT correctness
 * findings — is a genuine code bug and is eligible.
 */
export const NON_CODE_CODES: ReadonlySet<string> = new Set([
  // Pipeline / data health (auditHealth)
  "NO_ESTIMATES",
  "PARTIAL_ESTIMATES",
  "NO_QUANT",
  "NO_SENTIMENT",
  "NO_ARTICLES",
  "PAPER_DID_NOT_RUN",
  "PAPER_RAN_AFTER_CLOSE",
  "PAPER_RAN_EARLY",
  "STAGE_ERROR",
  "MISSED_TRADING_DAYS",
  "DATA_WARNING",
  "ACCOUNT_ALERT",
  // Position marking (auditOpenPositions) — a data gap, not a ladder bug
  "POSITIONS_NOT_MARKED",
  // Broker reconciliation (reconcileBroker) — operate the account, don't edit code
  "BROKER_POSITIONS_MISSING",
  "BROKER_POSITIONS_SUBSHARE",
  "BROKER_POSITIONS_ORPHAN",
  "BROKER_STOPS_MISSING",
  "BROKER_STOPS_ORPHAN",
  "ORDER_NOT_EXECUTED",
  "ORDER_PENDING",
  "ORDER_PARTIAL_FILL",
  // Strategy-tuning signals (tuningSignals) — backtest track, not a code PR
  "TUNE_TIME_STOP",
  "TUNE_STOP_DISTANCE",
  "TUNE_TRAIL_DISTANCE",
  "TUNE_DECAY_RUNS",
  "NEGATIVE_EXPECTANCY",
]);

// Same worst-first ordering the review email uses (rankFindings): fail before warn.
// `info` never reaches here — it's dropped before ranking.
const SEVERITY_RANK: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };

/**
 * The single highest-priority code-addressable finding not already handled, or null.
 *
 * Eligibility: severity is `fail` or `warn` (never `info`) AND the code is not in
 * NON_CODE_CODES AND the code is not in `alreadyHandledCodes`. Among the eligible,
 * `fail` beats `warn`; ties break by `code` ascending so the choice is deterministic
 * across identical reports.
 */
export function pickFinding(findings: Finding[], alreadyHandledCodes: string[]): Finding | null {
  const handled = new Set(alreadyHandledCodes);
  const eligible = findings.filter(
    (f) => f.severity !== "info" && !NON_CODE_CODES.has(f.code) && !handled.has(f.code)
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code)
  )[0];
}
