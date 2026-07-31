import { readFileSync, existsSync } from "node:fs";
import type { FeatureRow, MarketRegime } from "../src/lib/signal-research";
import { MIN_NAMES_PER_SESSION } from "../src/lib/signal-research";
import { fitFamaMacBeth, scoreWithWeights, type FitResult } from "../src/lib/signal-research-fit";
import { quantTerms, TERM_KEYS } from "../src/lib/signal-research-variants";
import { scoreToSignal } from "../src/lib/indicators";

// Fit the blend's weights on TRAIN sessions, and print them for pre-registration.
//
// This script NEVER touches the holdout. It filters to `session < --split` before it
// looks at anything, and prints the sessions it used so the claim is checkable. The
// output is a paste-ready constant block: the fitted weights go into
// `signal-research-variants.ts` as a pre-registered candidate, and only then does
// `npm run signal-research` score them out of sample. Fitting and judging in one process
// is how an in-sample number gets reported as an out-of-sample one.
//
// Usage:
//   npm run signal-research-fit
//   npm run signal-research-fit -- --split=2025-01-01 --horizon=5

const CACHE_PATH = ".cache/signal-research-features.json";
const DEFAULT_SPLIT = "2025-01-01";

const REGIMES: MarketRegime[] = ["TREND_BULL", "TREND_BEAR", "MEAN_REVERTING", "UNCLASSIFIED"];

function parseArgs(argv: string[]) {
  let split = DEFAULT_SPLIT;
  let horizon = 5;
  for (const a of argv) {
    if (a.startsWith("--split=")) split = a.slice(8);
    else if (a.startsWith("--horizon=")) horizon = Number(a.slice(10));
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(split)) {
    console.error(`--split must be YYYY-MM-DD, got: ${split}`);
    process.exit(2);
  }
  return { split, horizon };
}

const fixed = (v: number, w = 7) => (v >= 0 ? "+" : "") + v.toFixed(4).padStart(w);

function printFit(label: string, fit: FitResult) {
  console.log(`\n── ${label} ──`);
  console.log(`   ${fit.sessions} sessions, ${fit.observations.toLocaleString()} obs (${fit.dropped.toLocaleString()} dropped for a missing term)`);
  console.log("   term        weight    t");
  for (const k of TERM_KEYS) {
    const t = fit.tStats[k];
    console.log(`   ${k.padEnd(10)}${fixed(fit.weights[k])}  ${t == null ? "   —" : (t >= 0 ? "+" : "") + t.toFixed(2)}`);
  }
}

function bucketMix(rows: FeatureRow[], fit: FitResult): string {
  const counts = new Map<string, number>();
  for (const f of rows) {
    const s = scoreWithWeights(quantTerms(f), fit.weights, fit.standardizers);
    if (s == null) continue;
    const b = scoreToSignal(s);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([b, n]) => `${b} ${((n / total) * 100).toFixed(1)}%`)
    .join("  ");
}

/** The constant block to paste into `signal-research-variants.ts`. */
function emitConstants(name: string, fit: FitResult) {
  const w = TERM_KEYS.map((k) => `${k}: ${fit.weights[k].toFixed(6)}`).join(", ");
  const s = TERM_KEYS.map(
    (k) => `${k}: { mean: ${fit.standardizers[k].mean.toFixed(6)}, sd: ${fit.standardizers[k].sd.toFixed(6)} }`
  ).join(",\n  ");
  console.log(`\nexport const ${name}_W = { ${w} };`);
  console.log(`export const ${name}_STD = {\n  ${s},\n};`);
}

function main() {
  const { split, horizon } = parseArgs(process.argv.slice(2));
  if (!existsSync(CACHE_PATH)) {
    console.error(`No feature cache at ${CACHE_PATH}. Run \`npm run signal-research\` first to build it.`);
    process.exit(1);
  }
  const all = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as FeatureRow[];

  // The only place the holdout is excluded, and it happens before anything is read.
  const train = all.filter((f) => f.session < split);
  const sessions = new Set(train.map((f) => f.session));
  const trainMax = [...sessions].sort().pop();

  console.log("═══ blend refit — TRAIN ONLY ═══");
  console.log(`split ${split} → fitting on ${sessions.size} sessions (${train.length.toLocaleString()} obs), last = ${trainMax}`);
  console.log(`holdout (${(all.length - train.length).toLocaleString()} obs) is NOT read by this script.`);
  console.log(`horizon ${horizon} sessions; Fama-MacBeth (per-session cross-sectional OLS, t across sessions).`);

  const ret = (f: FeatureRow) => f.forward[`h${horizon}` as `h${5}`];
  const global = fitFamaMacBeth(train, quantTerms, ret, TERM_KEYS, { minNames: MIN_NAMES_PER_SESSION });
  printFit("global", global);
  console.log(`   train bucket mix: ${bucketMix(train, global)}`);
  emitConstants("REFIT", global);

  for (const regime of REGIMES) {
    const sub = train.filter((f) => f.marketRegime === regime);
    if (sub.length === 0) continue;
    const fit = fitFamaMacBeth(sub, quantTerms, ret, TERM_KEYS, { minNames: MIN_NAMES_PER_SESSION });
    printFit(`regime ${regime}`, fit);
    emitConstants(`REFIT_${regime}`, fit);
  }

  console.log(
    "\nThese weights are IN-SAMPLE by construction and mean nothing yet. Paste them into",
    "\nsignal-research-variants.ts as a pre-registered candidate, then run `npm run signal-research`",
    "\nto find out whether they survive the holdout. They probably will not — three hypotheses",
    "\nalready did not."
  );
}

main();
