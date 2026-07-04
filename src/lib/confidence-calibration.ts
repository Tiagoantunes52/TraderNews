// Empirical confidence recalibration (from the calibration harness's reliability
// diagram). The _RM books and the live book size positions by the estimate's
// confidence — but that's the model's *stated* confidence. The daily calibrate
// stage already measures how stated confidence maps to realized directional
// accuracy (reliabilityDiagram over the non-overlapping observation set); this
// module closes the loop by adjusting the confidence used for sizing/entry by how
// each confidence bucket has actually performed:
//
//   calibrated = stated × clamp(binHitRate ÷ overallHitRate, 0.5, 1.5)
//
// A RELATIVE adjustment, not a replacement: substituting the raw hit rate (~0.5)
// for confidence would collapse the sizing scale and silently starve every entry
// below the minConfidence floor. The ratio form keeps the scale and shifts dollars
// from overconfident buckets to underrated ones.
//
// Trust gates — the calibrator stays an identity map (inactive) unless the data
// says the mapping is real:
//   • Brier must beat the base-rate benchmark (the harness's own "confidence
//     carries information" test — if not, per the Model QA review, stated
//     confidence is noise and we must not remap by it).
//   • ≥ MIN_N directional observations overall; a bin adjusts only with
//     ≥ MIN_BIN_N observations (sparse bins pass through unadjusted).
//
// Ship-dark: PAPER_CONF_CALIBRATION=1 enables it, and it only ever applies to the
// _RM sim books + live Alpaca book — the pure books stay the raw-confidence
// attribution baseline (same scoping rule as every other risk feature).

import type { Reliability } from "@/lib/calibration";

/** Gate for applying reliability-based confidence recalibration. Ship-dark. */
export function isConfCalibrationEnabled(): boolean {
  return process.env.PAPER_CONF_CALIBRATION === "1";
}

/** Minimum directional observations before any recalibration is trusted. */
export const CALIBRATION_MIN_N = 50;
/** Minimum observations in a bin for that bin to adjust (else pass-through). */
export const CALIBRATION_MIN_BIN_N = 10;
/** Bounds on the per-bin adjustment factor. */
export const CALIBRATION_FACTOR_LO = 0.5;
export const CALIBRATION_FACTOR_HI = 1.5;

export type ConfidenceCalibrator = {
  /** Map a stated confidence to its empirically adjusted value (both in [0, 1]). */
  calibrate: (stated: number) => number;
  /** False = identity map; `reason` says why the data wasn't trusted. */
  active: boolean;
  reason: string | null;
};

const IDENTITY = (stated: number) => Math.max(0, Math.min(1, stated));

function inactive(reason: string): ConfidenceCalibrator {
  return { calibrate: IDENTITY, active: false, reason };
}

/**
 * Build a calibrator from a reliability diagram (the gate-horizon one from the
 * latest CalibrationSnapshot). Pure; returns an identity calibrator with a reason
 * whenever the diagram can't be trusted, so callers can apply it unconditionally.
 */
export function buildConfidenceCalibrator(rel: Reliability | null | undefined): ConfidenceCalibrator {
  if (!rel) return inactive("no reliability data");
  if (rel.n < CALIBRATION_MIN_N) return inactive(`only ${rel.n} directional observations (< ${CALIBRATION_MIN_N})`);
  if (rel.brier == null || rel.baseRateBrier == null || rel.brier >= rel.baseRateBrier) {
    return inactive("Brier does not beat the base rate — confidence carries no usable information");
  }

  // Observation-weighted overall hit rate (the denominator of every bin's factor).
  let wins = 0;
  let total = 0;
  for (const b of rel.bins) {
    if (b.hitRate != null && b.count > 0) {
      wins += b.hitRate * b.count;
      total += b.count;
    }
  }
  if (total === 0) return inactive("no populated reliability bins");
  const overall = wins / total;
  if (overall <= 0) return inactive("zero overall hit rate");

  const calibrate = (stated: number): number => {
    const c = Math.max(0, Math.min(1, stated));
    // Last bin is inclusive of its upper edge (mirrors reliabilityDiagram binning).
    const bin = rel.bins.find((b, i) => c >= b.lo && (c < b.hi || (i === rel.bins.length - 1 && c <= b.hi)));
    if (!bin || bin.hitRate == null || bin.count < CALIBRATION_MIN_BIN_N) return c;
    const factor = Math.max(CALIBRATION_FACTOR_LO, Math.min(CALIBRATION_FACTOR_HI, bin.hitRate / overall));
    return Math.max(0, Math.min(1, c * factor));
  };

  return { calibrate, active: true, reason: null };
}
