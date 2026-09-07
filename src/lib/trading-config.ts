// DB-backed trading-strategy configuration (issue: "too many env vars per deploy").
//
// Secrets and feature FLAGS (PAPER_RISK_BOOKS, PAPER_BROKER_STOPS, PAPER_RISK_LIMITS,
// PAPER_TRADE_NEAR_CLOSE) stay in env — they gate what runs and differ per
// environment. The numeric TUNING KNOBS (exit ladder, sizing, portfolio caps) live
// in one AppSetting row (`tradingConfig`) as a partial JSON object of overrides,
// editable from the admin page without a redeploy.
//
// Per-field precedence: env var (break-glass, wins if set) > DB override > code
// default. Out-of-bounds / unknown / non-numeric values are DROPPED with an issue
// string (never clamped — a typo like `stopLossPct: 8` meaning 8% must not silently
// become a 50% stop), so a bad value degrades to the next layer. That rule binds every
// source: the env break-glass skipped the bounds until 2026-09-07, which meant the
// layer with the highest precedence was the one layer nothing checked.
//
// TRADING_KNOBS is the single source of truth: bounds, env names, and the admin-UI
// grouping all render from it, and a unit test pins it to DEFAULT_RISK_CONFIG /
// DEFAULT_RISK_LIMITS so the registry can't drift from the code defaults.

import { db } from "@/lib/db";
import { DEFAULT_RISK_CONFIG, type RiskConfig } from "@/lib/paper-trading";
import { DEFAULT_RISK_LIMITS, type RiskLimits } from "@/lib/portfolio-risk";

/** Key under which the strategy overrides are stored in the AppSetting table. */
export const TRADING_CONFIG_KEY = "tradingConfig";

export type TradingKnobKey = keyof RiskConfig | keyof RiskLimits;

export type TradingKnobGroup = "entry" | "exits" | "sizing" | "portfolio" | "events";

export type TradingKnobSpec = {
  env: string; // the legacy env var — still honored as a break-glass override
  def: number;
  min: number;
  max: number;
  int?: boolean; // integers only (run counts, position counts, day windows)
  group: TradingKnobGroup;
  label: string; // short admin-UI description
};

export const TRADING_KNOBS: Record<TradingKnobKey, TradingKnobSpec> = {
  // ── Entry gates ──────────────────────────────────────────────────────────────
  entryScoreMin: { env: "PAPER_ENTRY_SCORE_MIN", def: DEFAULT_RISK_CONFIG.entryScoreMin, min: 0, max: 1, group: "entry", label: "Score required to open (deadband above the BUY line)" },
  entryScoreMax: { env: "PAPER_ENTRY_SCORE_MAX", def: DEFAULT_RISK_CONFIG.entryScoreMax, min: 0, max: 1, group: "entry", label: "Score above which NOT to open (1 disables; 0.6 excludes STRONG_BUY, where the signal loses)" },
  minConfidence: { env: "PAPER_MIN_CONFIDENCE", def: DEFAULT_RISK_CONFIG.minConfidence, min: 0, max: 1, group: "entry", label: "Confidence floor for an entry" },
  combinedEntryUsesQuant: { env: "PAPER_COMBINED_ENTRY_QUANT", def: DEFAULT_RISK_CONFIG.combinedEntryUsesQuant, min: 0, max: 1, int: true, group: "entry", label: "COMBINED_RM entry reads the quant leg (0 = sentiment only; exits keep quant either way)" },
  // ── Sizing ───────────────────────────────────────────────────────────────────
  riskPerTrade: { env: "PAPER_RISK_PER_TRADE", def: DEFAULT_RISK_CONFIG.riskPerTrade, min: 1, max: 10_000, group: "sizing", label: "$ lost if the stop fires at confidence 1" },
  // ── Exit ladder ──────────────────────────────────────────────────────────────
  stopLossPct: { env: "PAPER_STOP_LOSS_PCT", def: DEFAULT_RISK_CONFIG.stopLossPct, min: 0.01, max: 0.5, group: "exits", label: "Hard stop below entry (fallback if no ATR)" },
  trailPct: { env: "PAPER_TRAIL_PCT", def: DEFAULT_RISK_CONFIG.trailPct, min: 0.01, max: 0.5, group: "exits", label: "Trailing stop below peak (fallback if no ATR)" },
  trailActivatePct: { env: "PAPER_TRAIL_ACTIVATE_PCT", def: DEFAULT_RISK_CONFIG.trailActivatePct, min: 0, max: 1, group: "exits", label: "Gain that arms the trailing stop" },
  trailRatchetActivatePct: { env: "PAPER_TRAIL_RATCHET_ACTIVATE_PCT", def: DEFAULT_RISK_CONFIG.trailRatchetActivatePct, min: 0, max: 2, group: "exits", label: "Gain past which the trail tightens (0 disables)" },
  trailRatchetFrac: { env: "PAPER_TRAIL_RATCHET_FRAC", def: DEFAULT_RISK_CONFIG.trailRatchetFrac, min: 0.05, max: 1, group: "exits", label: "Fraction of the trail kept once ratcheted" },
  atrStopMult: { env: "PAPER_ATR_STOP_MULT", def: DEFAULT_RISK_CONFIG.atrStopMult, min: 0, max: 10, group: "exits", label: "ATR multiple for stop/trail (0 disables ATR scaling)" },
  atrStopFloorPct: { env: "PAPER_ATR_STOP_FLOOR_PCT", def: DEFAULT_RISK_CONFIG.atrStopFloorPct, min: 0.01, max: 0.5, group: "exits", label: "Floor for the ATR-scaled distance" },
  atrStopCapPct: { env: "PAPER_ATR_STOP_CAP_PCT", def: DEFAULT_RISK_CONFIG.atrStopCapPct, min: 0.01, max: 0.5, group: "exits", label: "Cap for the ATR-scaled distance" },
  signalConfirmRuns: { env: "PAPER_SIGNAL_CONFIRM_RUNS", def: DEFAULT_RISK_CONFIG.signalConfirmRuns, min: 1, max: 30, int: true, group: "exits", label: "Consecutive bearish days before a signal exit" },
  decayRuns: { env: "PAPER_DECAY_RUNS", def: DEFAULT_RISK_CONFIG.decayRuns, min: 0, max: 60, int: true, group: "exits", label: "No-conviction days before a profitable exit (0 disables)" },
  brokerReentryRuns: { env: "PAPER_BROKER_REENTRY_RUNS", def: DEFAULT_RISK_CONFIG.brokerReentryRuns, min: 0, max: 120, int: true, group: "entry", label: "Days before the live book may re-enter a name it exited (0 = never)" },
  minHoldRuns: { env: "PAPER_MIN_HOLD_RUNS", def: DEFAULT_RISK_CONFIG.minHoldRuns, min: 0, max: 30, int: true, group: "exits", label: "Days suppressing trail/signal/decay exits (stop stays live)" },
  timeStopRuns: { env: "PAPER_TIME_STOP_RUNS", def: DEFAULT_RISK_CONFIG.timeStopRuns, min: 0, max: 120, int: true, group: "exits", label: "Days of dead money before a time stop (0 disables)" },
  timeStopBandPct: { env: "PAPER_TIME_STOP_BAND_PCT", def: DEFAULT_RISK_CONFIG.timeStopBandPct, min: 0, max: 0.2, group: "exits", label: "± band around entry that counts as dead money" },
  // ── Insider event book (issue #57) ───────────────────────────────────────────
  insiderHoldDays: { env: "PAPER_INSIDER_HOLD_DAYS", def: DEFAULT_RISK_CONFIG.insiderHoldDays, min: 7, max: 180, int: true, group: "events", label: "Fixed holding period for insider-event positions (calendar days)" },
  insiderNotional: { env: "PAPER_INSIDER_NOTIONAL", def: DEFAULT_RISK_CONFIG.insiderNotional, min: 50, max: 50_000, group: "events", label: "$ per insider-event position (flat sizing)" },
  // ── Portfolio limits ─────────────────────────────────────────────────────────
  maxGrossExposurePct: { env: "PAPER_MAX_GROSS_PCT", def: DEFAULT_RISK_LIMITS.maxGrossExposurePct, min: 0.05, max: 1, group: "portfolio", label: "Gross exposure ceiling (Σ notional ÷ equity)" },
  maxPositions: { env: "PAPER_MAX_POSITIONS", def: DEFAULT_RISK_LIMITS.maxPositions, min: 1, max: 100, int: true, group: "portfolio", label: "Concurrent open names" },
  maxPositionPct: { env: "PAPER_MAX_POSITION_PCT", def: DEFAULT_RISK_LIMITS.maxPositionPct, min: 0.01, max: 1, group: "portfolio", label: "Single-name notional ÷ equity" },
  maxClusterPct: { env: "PAPER_MAX_CLUSTER_PCT", def: DEFAULT_RISK_LIMITS.maxClusterPct, min: 0.01, max: 1, group: "portfolio", label: "Single correlation-cluster notional ÷ equity" },
  maxClusterPositions: { env: "PAPER_MAX_CLUSTER_POSITIONS", def: DEFAULT_RISK_LIMITS.maxClusterPositions, min: 0, max: 50, int: true, group: "portfolio", label: "Names per cluster (0 disables)" },
  killSwitchDrawdownPct: { env: "PAPER_KILL_SWITCH_DD_PCT", def: DEFAULT_RISK_LIMITS.killSwitchDrawdownPct, min: 0.02, max: 0.9, group: "portfolio", label: "Drawdown that halts ALL new buys" },
  deriskStartDrawdownPct: { env: "PAPER_DERISK_START_DD_PCT", def: DEFAULT_RISK_LIMITS.deriskStartDrawdownPct, min: 0, max: 0.9, group: "portfolio", label: "Drawdown where the gross-cap step-down begins" },
  peakWindowDays: { env: "PAPER_PEAK_WINDOW_DAYS", def: DEFAULT_RISK_LIMITS.peakWindowDays, min: 0, max: 3650, int: true, group: "portfolio", label: "Rolling window for the drawdown peak (0 = all-time)" },
  regimeMaWindow: { env: "PAPER_REGIME_MA_WINDOW", def: DEFAULT_RISK_LIMITS.regimeMaWindow, min: 0, max: 400, int: true, group: "portfolio", label: "SPY moving-average window for the regime filter (0 disables)" },
  regimeRiskOffGrossFrac: { env: "PAPER_REGIME_RISKOFF_GROSS_FRAC", def: DEFAULT_RISK_LIMITS.regimeRiskOffGrossFrac, min: 0, max: 1, group: "portfolio", label: "Fraction of the gross cap allowed while SPY is below its MA" },
};

export const TRADING_KNOB_KEYS = Object.keys(TRADING_KNOBS) as TradingKnobKey[];

export type TradingOverrides = Partial<Record<TradingKnobKey, number>>;

/**
 * Check ONE candidate value against a knob's spec.
 *
 * The single gate every source goes through — DB overrides and the env break-glass
 * alike. It exists as a shared function rather than an inlined check because the two
 * paths drifted: the env reader only ever tested `Number.isFinite`, so bounds and the
 * integer rule were enforced on the DB path and skipped on the one with the HIGHEST
 * precedence. `label` names the value the way the operator wrote it (the knob key for
 * a DB override, the env var name for a break-glass), so the issue points at the thing
 * they need to go and edit.
 */
function checkKnobValue(
  label: string,
  spec: TradingKnobSpec,
  raw: unknown
): { value: number } | { issue: string } {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (typeof raw === "boolean" || !Number.isFinite(n)) return { issue: `${label}: not a number` };
  if (spec.int && !Number.isInteger(n)) return { issue: `${label}: must be an integer` };
  if (n < spec.min || n > spec.max) return { issue: `${label}: ${n} outside [${spec.min}, ${spec.max}]` };
  return { value: n };
}

/**
 * Validate a candidate overrides object (from the DB row or an admin PATCH).
 * Unknown keys, non-finite numbers, out-of-bounds values, and non-integers on
 * integer knobs are dropped and reported — never clamped or guessed at.
 */
export function validateTradingOverrides(value: unknown): { overrides: TradingOverrides; issues: string[] } {
  const overrides: TradingOverrides = {};
  const issues: string[] = [];
  if (value == null) return { overrides, issues };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { overrides, issues: ["overrides must be a JSON object"] };
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const spec = TRADING_KNOBS[key as TradingKnobKey];
    if (!spec) {
      issues.push(`${key}: unknown knob`);
      continue;
    }
    const checked = checkKnobValue(key, spec, raw);
    if ("issue" in checked) {
      issues.push(checked.issue);
      continue;
    }
    overrides[key as TradingKnobKey] = checked.value;
  }
  return { overrides, issues };
}

/** Parse the stored AppSetting JSON string into validated overrides. */
export function parseTradingOverrides(raw: string | null | undefined): { overrides: TradingOverrides; issues: string[] } {
  if (raw == null || raw === "") return { overrides: {}, issues: [] };
  try {
    return validateTradingOverrides(JSON.parse(raw));
  } catch {
    return { overrides: {}, issues: ["stored tradingConfig is not valid JSON"] };
  }
}

/**
 * A validly set env var for the knob (break-glass override; unset/empty = no).
 *
 * Held to the SAME bounds as a DB override. Being the break-glass makes this stricter,
 * not looser: it outranks every other source, so an unchecked value here is the one
 * that reaches the book. A violation is dropped (falling through to the DB override,
 * then the default) and reported, exactly as the module header requires — "a typo like
 * `stopLossPct: 8` meaning 8% must not silently become a 50% stop" is not a rule about
 * where the number came from.
 */
function envValue(spec: TradingKnobSpec, issues: string[]): number | undefined {
  const raw = process.env[spec.env];
  if (raw == null || raw === "") return undefined;
  const checked = checkKnobValue(spec.env, spec, raw);
  if ("issue" in checked) {
    issues.push(checked.issue);
    return undefined;
  }
  return checked.value;
}

function resolveKnob(key: TradingKnobKey, overrides: TradingOverrides, issues: string[]): number {
  const spec = TRADING_KNOBS[key];
  return envValue(spec, issues) ?? overrides[key] ?? spec.def;
}

export type ResolvedTradingConfig = {
  risk: RiskConfig;
  limits: RiskLimits;
  issues: string[]; // validation problems from EITHER source — stored override or env (fell back per-field)
};

/**
 * Pure per-field merge: env var > DB override > code default.
 *
 * `issues` accumulates problems from BOTH sources — the stored-override issues handed
 * in by the caller, plus any env break-glass dropped here. The paper stage pushes the
 * result into its stage errors (`pipeline/paper.ts`), so a knob that failed validation
 * surfaces in the daily review instead of being silently absent: an operator who set a
 * break-glass needs to learn that it did NOT take effect, or they will read the book's
 * behaviour as evidence about a parameter that was never applied.
 */
export function resolveTradingConfig(overrides: TradingOverrides, issues: string[] = []): ResolvedTradingConfig {
  // Copied, not appended to in place — callers pass an array they still own, and this
  // function is pure enough elsewhere that mutating it would be a surprise.
  const all = [...issues];
  const risk = Object.fromEntries(
    (Object.keys(DEFAULT_RISK_CONFIG) as (keyof RiskConfig)[]).map((k) => [k, resolveKnob(k, overrides, all)])
  ) as RiskConfig;
  const limits = Object.fromEntries(
    (Object.keys(DEFAULT_RISK_LIMITS) as (keyof RiskLimits)[]).map((k) => [k, resolveKnob(k, overrides, all)])
  ) as RiskLimits;
  return { risk, limits, issues: all };
}

/**
 * Knobs currently pinned by an env var (the DB override is ignored for these).
 *
 * An INVALID env var is not a pin: it is dropped, so the DB override is what actually
 * applies and the admin page must not grey the field out as env-controlled.
 */
export function envPinnedKnobs(): TradingKnobKey[] {
  return TRADING_KNOB_KEYS.filter((k) => envValue(TRADING_KNOBS[k], []) !== undefined);
}

/**
 * Load the active strategy configuration: the `tradingConfig` AppSetting row merged
 * over env vars and code defaults. A missing row, bad JSON, or a DB error all
 * degrade to env/defaults (with the problem reported in `issues`) — the paper stage
 * must never fail because config couldn't be read.
 */
export async function loadTradingConfig(): Promise<ResolvedTradingConfig> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: TRADING_CONFIG_KEY } });
    const { overrides, issues } = parseTradingOverrides(row?.value);
    return resolveTradingConfig(overrides, issues);
  } catch (e) {
    return resolveTradingConfig({}, [`tradingConfig read failed: ${String(e)}`]);
  }
}

/** Read the raw stored overrides (for the admin form). Empty object if unset/bad. */
export async function getTradingOverrides(): Promise<TradingOverrides> {
  const row = await db.appSetting.findUnique({ where: { key: TRADING_CONFIG_KEY } });
  return parseTradingOverrides(row?.value).overrides;
}

/**
 * Replace the stored override set (the admin form sends the complete set each save;
 * resetting a knob to default = omitting it). Returns what was actually stored.
 * Throws on validation issues — the route turns that into a 400.
 */
export async function setTradingOverrides(value: unknown): Promise<TradingOverrides> {
  const { overrides, issues } = validateTradingOverrides(value);
  if (issues.length > 0) throw new Error(issues.join("; "));
  await db.appSetting.upsert({
    where: { key: TRADING_CONFIG_KEY },
    update: { value: JSON.stringify(overrides) },
    create: { key: TRADING_CONFIG_KEY, value: JSON.stringify(overrides) },
  });
  return overrides;
}
