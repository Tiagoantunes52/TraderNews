// The specification ledger: every hypothesis ever tested against the corpus.
//
// The harness already adjusts its noise threshold for `k` — the number of chances a
// result had to look good by luck — but it computed `k` from the candidates in the
// CURRENT invocation. Eight candidates in one run and eight candidates across fifty
// runs both reported k=8, so the threshold never moved no matter how much searching had
// actually happened. That is the exact failure the pre-registration convention exists to
// prevent, and it was quietly not being prevented.
//
// This file makes `k` a property of the corpus rather than of a command line. Every spec
// ever judged is recorded here and survives the session, so the bar rises as the search
// widens — which is what a best-of-k result has to be read against.
//
// ── What counts as a chance to get lucky ─────────────────────────────────────
//
// The unit is a SPECIFICATION, not a run: `id@horizon/frame`. Re-running the identical
// spec after a bug fix is the same hypothesis asked twice and does not widen the search,
// so it does not raise `k`. Running `baseline` at three horizons IS three looks, because
// the reader gets to keep whichever answered best.
//
// Controls are recorded but excluded from `k`: the oracle exists to fail loudly, not to
// find an edge, so it was never a chance at a false positive.
//
// Split dates are recorded per spec and deliberately do NOT multiply `k` — a moved split
// is usually re-analysis, not a new hypothesis. But moving it until the answer changes is
// searching by another name, so `splitDrift` surfaces any id judged under more than one,
// for a human to look at rather than a formula to absorb.

import { noiseThreshold } from "@/lib/signal-research";

export const LEDGER_VERSION = 1;

export type LedgerKind = "candidate" | "policy";

export type LedgerEntry = {
  /** `id@horizon/frame` for a candidate, `id@frame` for a policy. Unique per family. */
  spec: string;
  kind: LedgerKind;
  id: string;
  /** Controls are recorded for the audit trail but never counted toward `k`. */
  control: boolean;
  firstRun: string;
  lastRun: string;
  runs: number;
  /** Every split date this spec has been judged under, in the order first seen. */
  splits: string[];
  lastVerdict: string;
};

export type Ledger = { version: number; entries: LedgerEntry[] };

export type RunRecord = {
  kind: LedgerKind;
  id: string;
  control: boolean;
  /** Horizon in sessions; omit for policies, which are not horizon-scoped. */
  horizon?: number;
  frame: string;
  split: string;
  verdict: string;
};

export const EMPTY_LEDGER: Ledger = { version: LEDGER_VERSION, entries: [] };

export function specOf(run: RunRecord): string {
  return run.horizon == null ? `${run.id}@${run.frame}` : `${run.id}@h${run.horizon}/${run.frame}`;
}

/**
 * Fold this run's specs into the ledger. Pure — the caller persists the result.
 *
 * A spec seen before has its run count and verdict updated but does not widen the
 * search; a spec seen for the first time does. `today` is injected so the ledger is
 * reproducible in a test rather than dependent on the clock.
 */
export function recordRuns(ledger: Ledger, runs: RunRecord[], today: string): Ledger {
  const byspec = new Map(ledger.entries.map((e) => [`${e.kind}:${e.spec}`, { ...e, splits: [...e.splits] }]));
  for (const run of runs) {
    const spec = specOf(run);
    const key = `${run.kind}:${spec}`;
    const existing = byspec.get(key);
    if (existing) {
      existing.lastRun = today;
      existing.runs++;
      existing.lastVerdict = run.verdict;
      if (!existing.splits.includes(run.split)) existing.splits.push(run.split);
    } else {
      byspec.set(key, {
        spec,
        kind: run.kind,
        id: run.id,
        control: run.control,
        firstRun: today,
        lastRun: today,
        runs: 1,
        splits: [run.split],
        lastVerdict: run.verdict,
      });
    }
  }
  // Sorted so the committed file has a stable diff — a ledger that reorders itself on
  // every run is one nobody reads in review, which is where its accountability lives.
  const entries = [...byspec.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.spec.localeCompare(b.spec));
  return { version: LEDGER_VERSION, entries };
}

/**
 * Lifetime `k` for one family: distinct non-control specs ever judged.
 *
 * Per family, not global. Score candidates and selection policies search different
 * spaces, so a policy result is not made less believable by scores having been tried.
 */
export function effectiveK(ledger: Ledger, kind: LedgerKind): number {
  return ledger.entries.filter((e) => e.kind === kind && !e.control).length;
}

/** Ids judged under more than one split date — a search surface a formula cannot see. */
export function splitDrift(ledger: Ledger, kind: LedgerKind): { id: string; splits: string[] }[] {
  const byId = new Map<string, Set<string>>();
  for (const e of ledger.entries) {
    if (e.kind !== kind || e.control) continue;
    const set = byId.get(e.id) ?? new Set<string>();
    for (const s of e.splits) set.add(s);
    byId.set(e.id, set);
  }
  return [...byId.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([id, splits]) => ({ id, splits: [...splits].sort() }));
}

/**
 * A run's `k`, never below what this run alone represents.
 *
 * The ledger is the authority, but a run whose specs have not been folded in yet (or a
 * ledger someone deleted) must not report a threshold LOWER than the run in front of the
 * reader justifies. Taking the max makes a missing ledger under-count rather than lie.
 */
export function reportK(ledger: Ledger, kind: LedgerKind, thisRunSpecs: number): number {
  return Math.max(effectiveK(ledger, kind), thisRunSpecs);
}

/**
 * The |t| a best-of-k result must clear: the harness's own noise threshold, floored at
 * the conventional 2.0 so a first-ever candidate is not judged more leniently than a
 * textbook would judge it.
 */
export function noiseFloorFor(k: number): number {
  return Math.max(2, noiseThreshold(k));
}

export function parseLedger(text: string): Ledger {
  const raw = JSON.parse(text) as Partial<Ledger>;
  if (!raw || !Array.isArray(raw.entries)) throw new Error("research ledger: malformed (no entries array)");
  if (raw.version !== LEDGER_VERSION) {
    throw new Error(`research ledger: version ${String(raw.version)}, expected ${LEDGER_VERSION}`);
  }
  return { version: LEDGER_VERSION, entries: raw.entries };
}

/** Trailing newline so the committed file diffs cleanly. */
export function serializeLedger(ledger: Ledger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export function formatLedgerNote(ledger: Ledger, kind: LedgerKind, k: number): string[] {
  const lifetime = effectiveK(ledger, kind);
  const drift = splitDrift(ledger, kind);
  const out = [
    `k=${k} ${kind === "candidate" ? "candidate" : "policy"} specifications ever judged against this corpus ` +
      `(${lifetime} in the ledger, ${ledger.entries.filter((e) => e.kind === kind).length} rows including controls).`,
  ];
  if (drift.length > 0) {
    out.push(
      `!!! split drift: ${drift.map((d) => `${d.id} (${d.splits.join(", ")})`).join("; ")} — ` +
        `judged under more than one split date. k does not price that; you have to.`
    );
  }
  return out;
}
