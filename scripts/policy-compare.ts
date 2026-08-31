import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildFeatures, splitFixed, splitRolling, RETURN_FRAMES, type Bar, type FeatureRow, type ReturnFrame } from "../src/lib/signal-research";
import { ALL_CANDIDATES, ORACLE_ID } from "../src/lib/signal-research-variants";
import {
  buildSimRows,
  simulate,
  pairedDifference,
  policyVerdict,
  controlOk,
  formatPolicyReport,
  type PolicyReport,
  type SimRow,
} from "../src/lib/portfolio-sim";
import { POLICIES, POLICY_K, P0_INCUMBENT, P2_TOPN } from "../src/lib/portfolio-sim-policies";
import { mean } from "../src/lib/stats";
import { recordRuns, reportK, formatLedgerNote } from "../src/lib/research-ledger";
import { readLedger, writeLedger } from "../src/lib/research-ledger-io";

// Does ranking names against each other beat letting them in first-come, once the book
// is full?
//
// A SCRIPT, not a stage: it reads years of bars and answers a research question, and
// nothing it prints changes how anything trades. The judgement lives in
// `src/lib/portfolio-sim.ts`; this file only loads, runs and prints.
//
// What it can and cannot say is set out at the top of `portfolio-sim.ts`. The short
// version: it models the entry frame and the slot cap, and it does NOT model price
// stops, exit slippage, position sizing or the portfolio caps — three of those omissions
// bias in the same direction as the hypothesis.
//
// Usage:
//   npx tsx scripts/policy-compare.ts --frame=fill
//   npx tsx scripts/policy-compare.ts --frame=exec --split=2025-01-01 --folds=4
//   npx tsx scripts/policy-compare.ts --candidate=baseline
//   npx tsx scripts/policy-compare.ts --json
//
// Reads the feature cache written by `scripts/signal-research.ts`; run that first (or
// with --rebuild-cache) if the cache is missing.

// Lazily constructed, and only when the feature cache misses: with the cache present
// this script needs no database at all, which is what lets it run on a runner holding
// nothing but the pipeline secret (see scripts/fetch-corpus.ts).
let prisma: PC<never, undefined> | null = null;
function client(): PC<never, undefined> {
  if (!prisma) {
    if (!process.env.DIRECT_URL) {
      throw new Error(
        "DIRECT_URL is required to build features from the database. " +
          "To run without one, build the cache over HTTP first: npx tsx scripts/fetch-corpus.ts"
      );
    }
    const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL });
    prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;
  }
  return prisma;
}

const CACHE_PATH = ".cache/signal-research-features.json";
const DEFAULT_SPLIT = "2025-01-01";
const DEFAULT_FOLDS = 4;

function parseArgs(argv: string[]) {
  let split = DEFAULT_SPLIT;
  let folds = DEFAULT_FOLDS;
  // Default `exec`, not `close`: the close frame prices every entry at a close nothing
  // can trade at, which makes turnover free — and turnover is the cost this whole
  // comparison exists to weigh. Defaulting to the flattering frame would be a trap.
  let frame: ReturnFrame = "exec";
  let candidateId = "baseline";
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--split=")) split = a.slice(8);
    else if (a.startsWith("--folds=")) folds = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith("--candidate=")) candidateId = a.slice(12);
    else if (a.startsWith("--frame=")) {
      const f = a.slice(8) as ReturnFrame;
      if (!RETURN_FRAMES.includes(f)) {
        console.error(`--frame must be one of ${RETURN_FRAMES.join(", ")}`);
        process.exit(2);
      }
      frame = f;
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(split)) {
    console.error(`--split must be YYYY-MM-DD, got: ${split}`);
    process.exit(2);
  }
  return { split, folds, frame, candidateId, json };
}

async function loadFeatures(): Promise<FeatureRow[]> {
  if (existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as FeatureRow[];
    if (cached.length > 0 && cached[0].forwardExec !== undefined) {
      console.error(`features: ${cached.length.toLocaleString()} rows from cache`);
      return cached;
    }
    console.error("features: cache predates the executable frame — rebuilding");
  }
  console.error("features: building from PriceBar…");
  const rows = await client().priceBar.findMany({
    select: {
      stockId: true, date: true, open: true, high: true, low: true, close: true, volume: true,
      stock: { select: { ticker: true } },
    },
    orderBy: { date: "asc" },
  });
  const bars: Bar[] = rows.map((r) => ({
    stockId: r.stockId,
    ticker: r.stock.ticker,
    session: r.date.toISOString().slice(0, 10),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  console.error(`  ${bars.length.toLocaleString()} bars → computing indicators…`);
  return buildFeatures(bars);
}

/** Split the sim rows the same way the score harness splits features — same dates, same folds. */
function periodsOf(rows: SimRow[], split: string, folds: number) {
  const fixed = splitFixed(rows, split);
  return { train: fixed.train, holdout: fixed.holdout, folds: splitRolling(rows, folds) };
}

async function main() {
  const { split, folds, frame, candidateId, json } = parseArgs(process.argv.slice(2));

  const candidate = ALL_CANDIDATES.find((c) => c.id === candidateId);
  if (!candidate) {
    console.error(`Unknown candidate: ${candidateId}`);
    console.error(`Known: ${ALL_CANDIDATES.map((c) => c.id).join(", ")}`);
    process.exit(2);
  }
  if (candidate.oracle) {
    console.error("The oracle is the control, not a candidate — it runs automatically. Pick a real score.");
    process.exit(2);
  }
  const oracle = ALL_CANDIDATES.find((c) => c.id === ORACLE_ID)!;

  const features = await loadFeatures();
  if (features.length === 0) {
    console.error("No feature rows — is PriceBar populated? (npm run backfill-price-bars)");
    process.exit(1);
  }

  const rows = buildSimRows(features, candidate, frame);
  const scored = rows.filter((r) => r.score != null).length;
  console.error(`sim rows: ${rows.length.toLocaleString()} (${scored.toLocaleString()} scored) over frame ${frame}`);

  // The control first, so a broken simulator fails before anything else is read. Same
  // policy, two scores: a perfect ranking must beat the incumbent's by a margin nobody
  // has to squint at. This is scale-free — it never asks the oracle's raw score to clear
  // a threshold calibrated for the incumbent — which is why it pairs P2 against P2.
  const oracleRows = buildSimRows(features, oracle, frame);
  const control = controlOk(
    (mean(simulate(oracleRows, P2_TOPN).sessions.map((s) => s.excess)) ?? 0) * 10_000,
    (mean(simulate(rows, P2_TOPN).sessions.map((s) => s.excess)) ?? 0) * 10_000
  );

  const periods = periodsOf(rows, split, folds);
  const baseline = {
    all: simulate(rows, P0_INCUMBENT),
    train: simulate(periods.train, P0_INCUMBENT),
    holdout: simulate(periods.holdout, P0_INCUMBENT),
    folds: periods.folds.map((f) => simulate(f.rows, P0_INCUMBENT)),
  };

  // Lifetime k BEFORE judging, because the verdict rule uses it. The spec set is known
  // from the policy list and the frame, so the ledger can be projected forward without
  // being written — then the real record is folded in once, with the real verdicts.
  const today = new Date().toISOString().slice(0, 10);
  const prior = readLedger();
  const specs = POLICIES.filter((p) => p.id !== P0_INCUMBENT.id).map((p) => ({
    kind: "policy" as const,
    id: p.id,
    control: !!p.control,
    frame,
    split,
  }));
  const k = reportK(recordRuns(prior, specs.map((sp) => ({ ...sp, verdict: "PENDING" })), today), "policy", POLICY_K);

  const reports: PolicyReport[] = POLICIES.map((policy) => {
    const sim = simulate(rows, policy);
    if (policy.id === P0_INCUMBENT.id) {
      return { policyId: policy.id, hypothesis: policy.hypothesis, control: false, sim, train: null, holdout: null, folds: [], verdict: null };
    }
    const train = pairedDifference(simulate(periods.train, policy), baseline.train, "train");
    const holdout = pairedDifference(simulate(periods.holdout, policy), baseline.holdout, "holdout");
    const foldStats = periods.folds.map((f, i) => pairedDifference(simulate(f.rows, policy), baseline.folds[i], f.label));
    return {
      policyId: policy.id,
      hypothesis: policy.hypothesis,
      control: !!policy.control,
      sim,
      train,
      holdout,
      folds: foldStats,
      verdict: policy.control ? "CONTROL" : policyVerdict(train, holdout, foldStats, k),
    };
  });

  const verdictOf = new Map(reports.map((r) => [r.policyId, r.verdict ?? "?"]));
  const ledger = recordRuns(prior, specs.map((sp) => ({ ...sp, verdict: verdictOf.get(sp.id) ?? "?" })), today);
  writeLedger(ledger);
  const ledgerNote = formatLedgerNote(ledger, "policy", k);

  if (json) {
    console.log(JSON.stringify({ candidateId, frame, split, k, ledger: ledgerNote, control, reports }, null, 2));
  } else {
    console.log(formatPolicyReport(reports, { frame, candidateId, k, splitDate: split, control }));
    console.log(ledgerNote.join("\n"));
  }

  // Non-zero when the simulator failed its own control, so a broken instrument cannot
  // be mistaken for a null result.
  process.exit(control.ok ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma?.$disconnect());
