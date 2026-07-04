import { describe, it, expect } from "vitest";
import {
  detectSignalChange,
  detectVelocitySpike,
  detectRsiCross,
  detectDrawdownBreach,
  detectOrderFailures,
  detectBrokerUnreachable,
  detectStalePipeline,
  detectMissedPaperDays,
  humanizeSignal,
} from "@/lib/alerts";

describe("humanizeSignal", () => {
  it("title-cases underscore-separated signals", () => {
    expect(humanizeSignal("STRONG_BUY")).toBe("Strong Buy");
    expect(humanizeSignal("NEUTRAL")).toBe("Neutral");
  });
});

describe("detectSignalChange", () => {
  it("fires on an upgrade and notes the direction", () => {
    const a = detectSignalChange("AAPL", "NEUTRAL", "BUY");
    expect(a).not.toBeNull();
    expect(a!.type).toBe("SIGNAL_CHANGE");
    expect(a!.title).toContain("upgraded");
    expect(a!.title).toContain("Buy");
    expect(a!.message).toContain("📈");
  });

  it("fires on a downgrade", () => {
    const a = detectSignalChange("AAPL", "BUY", "SELL");
    expect(a!.title).toContain("downgraded");
    expect(a!.message).toContain("📉");
  });

  it("does not fire when the signal is unchanged", () => {
    expect(detectSignalChange("AAPL", "BUY", "BUY")).toBeNull();
  });

  it("does not fire without a previous signal (first reading)", () => {
    expect(detectSignalChange("AAPL", null, "BUY")).toBeNull();
    expect(detectSignalChange("AAPL", undefined, "BUY")).toBeNull();
  });

  it("ignores unknown signal labels", () => {
    expect(detectSignalChange("AAPL", "WAT", "BUY")).toBeNull();
    expect(detectSignalChange("AAPL", "BUY", "WAT")).toBeNull();
  });
});

describe("detectVelocitySpike", () => {
  it("fires at or above the threshold", () => {
    const a = detectVelocitySpike("TSLA", 3.0);
    expect(a).not.toBeNull();
    expect(a!.type).toBe("VELOCITY_SPIKE");
    expect(a!.value).toBe(3.0);
    expect(a!.message).toContain("3.0×");
  });

  it("fires exactly at the threshold (2.5)", () => {
    expect(detectVelocitySpike("TSLA", 2.5)).not.toBeNull();
  });

  it("does not fire below the threshold", () => {
    expect(detectVelocitySpike("TSLA", 2.49)).toBeNull();
  });

  it("respects a custom threshold", () => {
    expect(detectVelocitySpike("TSLA", 2.0, 1.5)).not.toBeNull();
    expect(detectVelocitySpike("TSLA", 2.0, 3.0)).toBeNull();
  });

  it("does not fire on null or non-finite input", () => {
    expect(detectVelocitySpike("TSLA", null)).toBeNull();
    expect(detectVelocitySpike("TSLA", undefined)).toBeNull();
    expect(detectVelocitySpike("TSLA", Infinity)).toBeNull();
  });
});

describe("detectRsiCross", () => {
  it("fires when crossing into oversold (>=30 → <30)", () => {
    const a = detectRsiCross("NVDA", 32, 28);
    expect(a).not.toBeNull();
    expect(a!.type).toBe("RSI_EXTREME");
    expect(a!.title).toContain("oversold");
    expect(a!.value).toBe(28);
  });

  it("fires when crossing into overbought (<=70 → >70)", () => {
    const a = detectRsiCross("NVDA", 68, 73);
    expect(a!.title).toContain("overbought");
  });

  it("does not fire when already oversold (no crossing)", () => {
    expect(detectRsiCross("NVDA", 25, 22)).toBeNull();
  });

  it("does not fire when already overbought (no crossing)", () => {
    expect(detectRsiCross("NVDA", 75, 80)).toBeNull();
  });

  it("does not fire inside the neutral band", () => {
    expect(detectRsiCross("NVDA", 50, 55)).toBeNull();
  });

  it("requires both previous and new readings", () => {
    expect(detectRsiCross("NVDA", null, 28)).toBeNull();
    expect(detectRsiCross("NVDA", 32, null)).toBeNull();
  });
});

describe("account-health alerts (issue #56)", () => {
  describe("detectDrawdownBreach", () => {
    it("fires at/above the kill-switch threshold and carries the drawdown", () => {
      const a = detectDrawdownBreach("ALPACA", 0.22, 0.2);
      expect(a).not.toBeNull();
      expect(a!.type).toBe("ACCOUNT_DRAWDOWN");
      expect(a!.title).toContain("22.0%");
      expect(a!.value).toBe(0.22);
    });
    it("does not fire below the threshold", () => {
      expect(detectDrawdownBreach("ALPACA", 0.19, 0.2)).toBeNull();
    });
    it("ignores non-finite drawdown", () => {
      expect(detectDrawdownBreach("ALPACA", NaN, 0.2)).toBeNull();
    });
  });

  describe("detectOrderFailures", () => {
    it("fires once one or more orders failed", () => {
      const a = detectOrderFailures(1);
      expect(a!.type).toBe("ORDER_FAILURES");
      expect(a!.value).toBe(1);
      expect(a!.title).toContain("1 order failure");
    });
    it("pluralizes and respects a custom threshold", () => {
      expect(detectOrderFailures(3)!.title).toContain("3 order failures");
      expect(detectOrderFailures(0)).toBeNull();
      expect(detectOrderFailures(1, 2)).toBeNull();
    });
  });

  describe("detectBrokerUnreachable", () => {
    it("always returns a draft (only called on a thrown error)", () => {
      const a = detectBrokerUnreachable();
      expect(a.type).toBe("BROKER_UNREACHABLE");
      expect(a.value).toBeNull();
    });
  });

  describe("detectStalePipeline", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");
    it("fires when the freshest data is older than the threshold", () => {
      const old = new Date("2026-06-18T12:00:00.000Z"); // 72h old
      const a = detectStalePipeline(old, now, 48);
      expect(a!.type).toBe("STALE_PIPELINE");
      expect(a!.value).toBeCloseTo(72, 0);
    });
    it("fires when there is no data at all", () => {
      const a = detectStalePipeline(null, now, 48);
      expect(a).not.toBeNull();
      expect(a!.value).toBeNull();
      expect(a!.title).toContain("missing");
    });
    it("does not fire when data is fresh", () => {
      const recent = new Date("2026-06-21T06:00:00.000Z"); // 6h old
      expect(detectStalePipeline(recent, now, 48)).toBeNull();
    });
  });

  describe("detectMissedPaperDays", () => {
    const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

    it("fires for weekday gaps between the previous snapshot and today", () => {
      // Prev snapshot Wed 07-01, today Sat 07-04 → Thu 07-02 + Fri 07-03 missed.
      const a = detectMissedPaperDays(d("2026-07-01"), d("2026-07-04"));
      expect(a).not.toBeNull();
      expect(a!.type).toBe("MISSED_PAPER_DAYS");
      expect(a!.value).toBe(2);
      expect(a!.message).toContain("2026-07-02");
      expect(a!.message).toContain("2026-07-03");
    });

    it("does not fire for consecutive trading days or a plain weekend gap", () => {
      expect(detectMissedPaperDays(d("2026-07-01"), d("2026-07-02"))).toBeNull();
      // Fri → Mon: Sat/Sun aren't trading days.
      expect(detectMissedPaperDays(d("2026-06-26"), d("2026-06-29"))).toBeNull();
    });

    it("uses the broker calendar to ignore holidays when provided", () => {
      // Weekday 07-03 was a holiday per the calendar → not a miss.
      expect(detectMissedPaperDays(d("2026-07-02"), d("2026-07-06"), ["2026-07-06"])).toBeNull();
      // But a calendar trading day with no snapshot still fires.
      const a = detectMissedPaperDays(d("2026-07-01"), d("2026-07-06"), ["2026-07-02", "2026-07-06"]);
      expect(a!.value).toBe(1);
      expect(a!.message).toContain("2026-07-02");
      expect(a!.message).toContain("broker calendar");
    });

    it("is silent with no prior snapshot (nothing to miss yet)", () => {
      expect(detectMissedPaperDays(null, d("2026-07-04"))).toBeNull();
    });
  });
});
