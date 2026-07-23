import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isReviewSlackConfigured,
  buildFallbackMessage,
  interpretAndPostReview,
} from "@/lib/review-interpret";
import type { DailyReviewReport } from "@/lib/daily-review";

function makeReport(overrides: Partial<DailyReviewReport> = {}): DailyReviewReport {
  return {
    version: 1,
    date: "2026-07-23",
    generatedAt: "2026-07-23T23:00:00.000Z",
    status: "FAIL",
    summary: {
      findings: 2,
      fails: 1,
      warns: 1,
      openPositions: 11,
      openedToday: 0,
      closedToday: 0,
      realizedToday: 0,
      ordersSubmittedToday: 0,
      replayed: 0,
    },
    findings: [
      { severity: "fail", code: "OPEN_NO_STOP", title: "11 open position(s) with no protective order", detail: "Unprotected: DHR, GE, JNJ." },
      { severity: "warn", code: "SOME_WARN", title: "A warning", detail: "watch this" },
    ],
    strategies: [],
    books: [],
    notes: [],
    ...overrides,
  };
}

describe("review-interpret", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.VLLM_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.VLLM_MODEL;
    delete process.env.REVIEW_LLM_MODEL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("gates on the Slack webhook", () => {
    expect(isReviewSlackConfigured()).toBe(false);
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/x";
    expect(isReviewSlackConfigured()).toBe(true);
  });

  it("fallback message carries every fail title + detail and the warn count", () => {
    const msg = buildFallbackMessage(makeReport());
    expect(msg).toContain("11 open position(s) with no protective order");
    expect(msg).toContain("DHR, GE, JNJ");
    expect(msg).toContain("1 warning(s)");
    // warns are not listed individually — only failures are itemized
    expect(msg).not.toContain("A warning");
  });

  it("fallback message says 'No failures.' when clean", () => {
    const clean = makeReport({ status: "OK", findings: [], summary: { ...makeReport().summary, fails: 0, warns: 0 } });
    expect(buildFallbackMessage(clean)).toContain("No failures.");
  });

  it("returns ok:false without posting when no webhook is configured", async () => {
    const res = await interpretAndPostReview(makeReport(), []);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SLACK_WEBHOOK_URL/);
  });
});
