import { readFileSync, existsSync } from "node:fs";
import type { FeatureRow, MarketRegime, RegimeBoundaries } from "../src/lib/signal-research";
import { MIN_NAMES_PER_SESSION, DEFAULT_REGIME_BOUNDARIES, noiseThreshold, regimeOf } from "../src/lib/signal-research";
import {
  fitFamaMacBeth,
  fitByRegime,
  selectBoundaries,
  boundaryGrid,
  MIN_SESSIONS_PER_REGIME,
  scoreWithWeights,
  type FitResult,
} from "../src/lib/signal-research-fit";
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
/**
 * The inner split, INSIDE train, used to choose regime boundaries.
 *
 * Weights are fitted before this date; boundaries are ranked on the year after it, which
 * those weights never saw. Choosing boundaries on the same rows that fitted the weights
 * would choose them for fitting noise, and the real holdout would be the first thing to
 * find out. ~2.2 years to fit, ~1 year to select on.
 */
const DEFAULT_INNER_SPLIT = "2024-01-01";

const REGIMES: MarketRegime[] = ["TREND_BULL", "TREND_BEAR", "MEAN_REVERTING", "UNCLASSIFIED"];

function parseArgs(argv: string[]) {
  let split = DEFAULT_SPLIT;
  let innerSplit = DEFAULT_INNER_SPLIT;
  let horizon = 5;
  let boundaries = false;
  for (const a of argv) {
    if (a === "--boundaries") boundaries = true;
    else if (a.startsWith("--split=")) split = a.slice(8);
    else if (a.startsWith("--inner-split=")) innerSplit = a.slice(14);
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
  if (innerSplit >= split) {
    console.error(`--inner-split (${innerSplit}) must fall INSIDE train, i.e. before --split (${split}).`);
    process.exit(2);
  }
  return { split, innerSplit, horizon, boundaries };
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

const b2s = (b: RegimeBoundaries) => `adx>${b.adxTrend} / adx<${b.adxCalm} & rsi ${b.rsiLo}-${b.rsiHi}`;

/** The whole per-regime weight table, ready to paste as one pre-registered constant. */
function emitRegimeBlock(
  name: string,
  boundaries: RegimeBoundaries,
  fits: Partial<Record<MarketRegime, { w: Record<string, number>; std: Record<string, { mean: number; sd: number }> }>>
) {
  console.log(`\nexport const ${name}_BOUNDARIES: RegimeBoundaries = ${JSON.stringify(boundaries)};`);
  console.log(`export const ${name} = {`);
  for (const [regime, fit] of Object.entries(fits)) {
    const w = TERM_KEYS.map((k) => `${k}: ${fit.w[k].toFixed(6)}`).join(", ");
    const s = TERM_KEYS.map(
      (k) => `${k}: { mean: ${fit.std[k].mean.toFixed(6)}, sd: ${fit.std[k].sd.toFixed(6)} }`
    ).join(", ");
    console.log(`  ${regime}: {`);
    console.log(`    w: { ${w} },`);
    console.log(`    std: { ${s} },`);
    console.log(`  },`);
  }
  console.log("};");
}

/** Nested selection of the regime cut-points. Train only, weights and boundaries both. */
function fitBoundaries(train: FeatureRow[], innerSplit: string, ret: (f: FeatureRow) => number) {
  const inner = train.filter((f) => f.session < innerSplit);
  const validate = train.filter((f) => f.session >= innerSplit);
  const grid = boundaryGrid();

  console.log("\n═══ regime boundaries — NESTED SELECTION, TRAIN ONLY ═══");
  console.log(
    `fit weights on ${new Set(inner.map((f) => f.session)).size} sessions (< ${innerSplit}), ` +
      `rank boundaries on ${new Set(validate.map((f) => f.session)).size} sessions (>= ${innerSplit}) the weights never saw.`
  );
  console.log(`grid: ${grid.length} boundary sets → noise threshold |t| ≈ ${noiseThreshold(grid.length).toFixed(2)}`);

  const trials = selectBoundaries(inner, validate, quantTerms, ret, TERM_KEYS, grid, {
    minNames: MIN_NAMES_PER_SESSION,
  });
  const usable = trials.filter((t) => t.usable);

  console.log(`\n   ${usable.length}/${trials.length} usable (every regime ≥ ${MIN_SESSIONS_PER_REGIME} fitting sessions)`);
  console.log("   rank  boundaries                          validation IC");
  for (const [i, t] of usable.slice(0, 10).entries()) {
    console.log(
      `   ${String(i + 1).padStart(4)}  ${b2s(t.boundaries).padEnd(36)}` +
        `${(t.validation.mean ?? NaN) >= 0 ? "+" : ""}${(t.validation.mean ?? NaN).toFixed(4)}(${(t.validation.tStat ?? NaN).toFixed(2)})`
    );
  }
  const asShipped = trials.find(
    (t) =>
      t.boundaries.adxTrend === DEFAULT_REGIME_BOUNDARIES.adxTrend &&
      t.boundaries.adxCalm === DEFAULT_REGIME_BOUNDARIES.adxCalm &&
      t.boundaries.rsiLo === DEFAULT_REGIME_BOUNDARIES.rsiLo
  );
  if (asShipped) {
    const rank = usable.indexOf(asShipped) + 1;
    console.log(
      `\n   the textbook cuts (${b2s(DEFAULT_REGIME_BOUNDARIES)}) rank ${rank || "unusable"}/${usable.length} ` +
        `at ${(asShipped.validation.mean ?? NaN).toFixed(4)}(${(asShipped.validation.tStat ?? NaN).toFixed(2)})`
    );
  }

  const winner = usable[0];
  if (!winner) {
    console.error("\nNo usable boundary set — every candidate leaves some regime too thin to fit.");
    return;
  }
  console.log(`\n   winner: ${b2s(winner.boundaries)}`);

  // Refit the weights on ALL of train under the winning boundaries. The inner split has
  // done its job (choosing the partition) and holding data back from the final fit now
  // would only make the frozen weights noisier.
  const fits = fitByRegime(train, winner.boundaries, quantTerms, ret, TERM_KEYS, { minNames: MIN_NAMES_PER_SESSION });
  for (const [regime, fit] of Object.entries(fits)) {
    console.log(`   ${regime.padEnd(16)}${fit.sessions} train sessions`);
  }
  emitRegimeBlock("REFIT2", winner.boundaries, fits);

  const mix = new Map<MarketRegime, number>();
  for (const f of train) {
    const r = regimeOf(f, winner.boundaries);
    mix.set(r, (mix.get(r) ?? 0) + 1);
  }
  console.log(
    `\n   train regime mix: ${[...mix.entries()].map(([r, n]) => `${r} ${((n / train.length) * 100).toFixed(1)}%`).join("  ")}`
  );
}

function main() {
  const { split, innerSplit, horizon, boundaries } = parseArgs(process.argv.slice(2));
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

  if (boundaries) {
    fitBoundaries(train, innerSplit, ret);
    console.log(
      "\nThe boundaries above were SEARCHED. Read the winner against the grid's noise threshold,",
      "\nnot against zero, and against how tightly the top ten cluster."
    );
    return;
  }

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
