import { describe, it, expect } from "vitest";
import {
  detectSignalChange,
  detectVelocitySpike,
  detectRsiCross,
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
