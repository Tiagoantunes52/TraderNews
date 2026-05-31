import { describe, it, expect } from "vitest";
import { mood, moodBucket } from "@/lib/mood";

describe("mood()", () => {
  it("returns Very Bullish for score > 0.6", () => {
    expect(mood(0.7).label).toBe("Very Bullish");
    expect(mood(1.0).label).toBe("Very Bullish");
  });

  it("returns Bullish for score in (0.2, 0.6]", () => {
    expect(mood(0.6).label).toBe("Bullish");
    expect(mood(0.3).label).toBe("Bullish");
    expect(mood(0.21).label).toBe("Bullish");
  });

  it("returns Neutral for score in (-0.2, 0.2]", () => {
    expect(mood(0).label).toBe("Neutral");
    expect(mood(0.2).label).toBe("Neutral");
    expect(mood(-0.19).label).toBe("Neutral");
  });

  it("returns Bearish for score in (-0.6, -0.2]", () => {
    expect(mood(-0.2).label).toBe("Bearish");
    expect(mood(-0.21).label).toBe("Bearish");
    expect(mood(-0.4).label).toBe("Bearish");
    expect(mood(-0.59).label).toBe("Bearish");
  });

  it("returns Very Bearish for score <= -0.6", () => {
    expect(mood(-0.6).label).toBe("Very Bearish");
    expect(mood(-0.61).label).toBe("Very Bearish");
    expect(mood(-1.0).label).toBe("Very Bearish");
  });

  it("always returns all required fields", () => {
    for (const score of [1, 0.5, 0, -0.5, -1]) {
      const m = mood(score);
      expect(m).toHaveProperty("emoji");
      expect(m).toHaveProperty("label");
      expect(m).toHaveProperty("gradient");
      expect(m).toHaveProperty("chartColor");
      expect(m).toHaveProperty("text");
    }
  });
});

describe("moodBucket()", () => {
  it("returns 'none' for undefined or null", () => {
    expect(moodBucket(undefined)).toBe("none");
    expect(moodBucket(null)).toBe("none");
  });

  it("returns 'bull' for score > 0.2", () => {
    expect(moodBucket(0.21)).toBe("bull");
    expect(moodBucket(1)).toBe("bull");
  });

  it("returns 'bear' for score < -0.2", () => {
    expect(moodBucket(-0.21)).toBe("bear");
    expect(moodBucket(-1)).toBe("bear");
  });

  it("returns 'neutral' for score in [-0.2, 0.2]", () => {
    expect(moodBucket(0)).toBe("neutral");
    expect(moodBucket(0.2)).toBe("neutral");
    expect(moodBucket(-0.2)).toBe("neutral");
  });
});
