import { describe, it, expect } from "vitest";
import {
  TRADING_KNOBS,
  TRADING_KNOB_KEYS,
  validateTradingOverrides,
  parseTradingOverrides,
  resolveTradingConfig,
  envPinnedKnobs,
} from "@/lib/trading-config";
import { DEFAULT_RISK_CONFIG } from "@/lib/paper-trading";
import { DEFAULT_RISK_LIMITS } from "@/lib/portfolio-risk";

describe("TRADING_KNOBS registry", () => {
  it("covers exactly the RiskConfig + RiskLimits fields, with matching defaults", () => {
    const expected = [...Object.keys(DEFAULT_RISK_CONFIG), ...Object.keys(DEFAULT_RISK_LIMITS)].sort();
    expect([...TRADING_KNOB_KEYS].sort()).toEqual(expected);
    for (const [key, value] of Object.entries({ ...DEFAULT_RISK_CONFIG, ...DEFAULT_RISK_LIMITS })) {
      expect(TRADING_KNOBS[key as keyof typeof TRADING_KNOBS].def, key).toBe(value);
    }
  });

  it("every default sits inside its own bounds", () => {
    for (const key of TRADING_KNOB_KEYS) {
      const { def, min, max, int } = TRADING_KNOBS[key];
      expect(def, key).toBeGreaterThanOrEqual(min);
      expect(def, key).toBeLessThanOrEqual(max);
      if (int) expect(Number.isInteger(def), key).toBe(true);
    }
  });
});

describe("validateTradingOverrides()", () => {
  it("accepts in-bounds knobs and drops nothing", () => {
    expect(validateTradingOverrides({ stopLossPct: 0.1, decayRuns: 7 })).toEqual({
      overrides: { stopLossPct: 0.1, decayRuns: 7 },
      issues: [],
    });
  });

  it("drops (never clamps) out-of-bounds values — a typoed 8-meaning-8% must not become a 50% stop", () => {
    const { overrides, issues } = validateTradingOverrides({ stopLossPct: 8, trailPct: 0.2 });
    expect(overrides).toEqual({ trailPct: 0.2 });
    expect(issues).toEqual(["stopLossPct: 8 outside [0.01, 0.5]"]);
  });

  it("drops unknown keys, non-numbers, and non-integers on integer knobs", () => {
    const { overrides, issues } = validateTradingOverrides({
      notAKnob: 1,
      minConfidence: "abc",
      maxPositions: 2.5,
    });
    expect(overrides).toEqual({});
    expect(issues).toHaveLength(3);
  });

  it("rejects non-object payloads and treats null as empty", () => {
    expect(validateTradingOverrides([1, 2]).issues).toEqual(["overrides must be a JSON object"]);
    expect(validateTradingOverrides(null)).toEqual({ overrides: {}, issues: [] });
  });
});

describe("parseTradingOverrides()", () => {
  it("parses the stored JSON string", () => {
    expect(parseTradingOverrides('{"riskPerTrade":120}').overrides).toEqual({ riskPerTrade: 120 });
  });

  it("degrades malformed JSON to no overrides with an issue", () => {
    expect(parseTradingOverrides("{oops")).toEqual({
      overrides: {},
      issues: ["stored tradingConfig is not valid JSON"],
    });
    expect(parseTradingOverrides(null)).toEqual({ overrides: {}, issues: [] });
  });
});

describe("resolveTradingConfig() precedence", () => {
  it("returns pure defaults with no overrides and no env", () => {
    const { risk, limits } = resolveTradingConfig({});
    expect(risk).toEqual(DEFAULT_RISK_CONFIG);
    expect(limits).toEqual(DEFAULT_RISK_LIMITS);
  });

  it("DB overrides beat defaults, per-field", () => {
    const { risk, limits } = resolveTradingConfig({ stopLossPct: 0.1, peakWindowDays: 30 });
    expect(risk.stopLossPct).toBe(0.1);
    expect(risk.trailPct).toBe(DEFAULT_RISK_CONFIG.trailPct); // untouched field
    expect(limits.peakWindowDays).toBe(30);
  });

  it("an env var beats the DB override (break-glass), and shows as pinned", () => {
    const prev = process.env.PAPER_STOP_LOSS_PCT;
    try {
      process.env.PAPER_STOP_LOSS_PCT = "0.05";
      const { risk } = resolveTradingConfig({ stopLossPct: 0.1 });
      expect(risk.stopLossPct).toBe(0.05);
      expect(envPinnedKnobs()).toContain("stopLossPct");
    } finally {
      if (prev === undefined) delete process.env.PAPER_STOP_LOSS_PCT;
      else process.env.PAPER_STOP_LOSS_PCT = prev;
    }
  });

  it("an unparsable env var is ignored (falls through to the DB override)", () => {
    const prev = process.env.PAPER_DECAY_RUNS;
    try {
      process.env.PAPER_DECAY_RUNS = "banana";
      const { risk } = resolveTradingConfig({ decayRuns: 9 });
      expect(risk.decayRuns).toBe(9);
      expect(envPinnedKnobs()).not.toContain("decayRuns");
    } finally {
      if (prev === undefined) delete process.env.PAPER_DECAY_RUNS;
      else process.env.PAPER_DECAY_RUNS = prev;
    }
  });

  it("passes stored-value issues through for the stage to surface", () => {
    expect(resolveTradingConfig({}, ["stopLossPct: 8 outside [0.01, 0.5]"]).issues).toHaveLength(1);
  });
});
