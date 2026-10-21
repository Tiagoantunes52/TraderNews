// @vitest-environment node
//
// Node environment, not the jsdom default: this suite pulls in `lib/pipeline` →
// `lib/observability` → `@sentry/nextjs`, whose vendored orchestrion webpack shim
// branches on `typeof document` and dies under jsdom. Nothing here touches the DOM.
import { describe, it, expect } from "vitest";
import { REQUEST_TIMEOUT_MS, LlmResponseError, LlmHttpError } from "@/lib/llm";
import {
  SENTIMENT_BUDGET_MS,
  SENTIMENT_CONCURRENCY,
  SENTIMENT_MAX_ATTEMPTS_PER_DAY,
  SENTIMENT_RETRY_BACKOFF_MS,
  shouldAttemptSentiment,
  llmFailureSummary,
} from "@/lib/pipeline/sentiment";

// Every pipeline route declares `export const maxDuration = 300`.
const ROUTE_MAX_DURATION_MS = 300_000;

describe("sentiment stage budget", () => {
  it("leaves room for one in-flight LLM call to finish after the deadline", () => {
    // processWithBudget stops *scheduling* at the deadline but awaits what is
    // already running, so an invocation's real ceiling is budget + timeout. Blow
    // through maxDuration and Vercel kills the invocation, losing the whole slice
    // — not just the slow call. The pre-2026-09-14 pairing (240s + 60s after the
    // retry doubling) sat exactly on the limit with zero headroom.
    expect(SENTIMENT_BUDGET_MS + REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(ROUTE_MAX_DURATION_MS);
  });

  it("keeps a real margin, not just a passing sum", () => {
    const headroom = ROUTE_MAX_DURATION_MS - (SENTIMENT_BUDGET_MS + REQUEST_TIMEOUT_MS);
    expect(headroom).toBeGreaterThanOrEqual(30_000);
  });

  it("can clear the ~110-name universe in a couple of polls", () => {
    // Throughput per invocation = budget x concurrency / latency. Nemotron 3 Ultra
    // answers at ~30s (median implied from run #861); allow 40s to stay pessimistic
    // about the tail now that the timeout admits calls up to 60s.
    const PESSIMISTIC_LATENCY_MS = 40_000;
    const UNIVERSE = 110;
    const perInvocation = (SENTIMENT_BUDGET_MS * SENTIMENT_CONCURRENCY) / PESSIMISTIC_LATENCY_MS;
    const polls = Math.ceil(UNIVERSE / perInvocation);
    expect(polls).toBeLessThanOrEqual(3); // x ~185s/poll, comfortably inside timeout-minutes: 20
  });
});

describe("failed LLM calls", () => {
  const now = new Date("2026-10-21T15:00:00Z");
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("attempts a stock with no failures today", () => {
    expect(shouldAttemptSentiment([], now)).toBe(true);
  });

  it("does not retry inside the same pipeline run", () => {
    // A run is capped by the job's 20-minute timeout; the backoff must outlast it, or a
    // broad outage re-attempts every name on every poll and the stage never reports
    // done — starving quant/estimate/paper behind it.
    const JOB_TIMEOUT_MS = 20 * 60_000;
    expect(SENTIMENT_RETRY_BACKOFF_MS).toBeGreaterThan(JOB_TIMEOUT_MS);
    expect(shouldAttemptSentiment([minsAgo(5)], now)).toBe(false);
    expect(shouldAttemptSentiment([minsAgo(19)], now)).toBe(false);
  });

  it("retries on a later run, measured from the most recent failure", () => {
    expect(shouldAttemptSentiment([minsAgo(180)], now)).toBe(true);
    expect(shouldAttemptSentiment([minsAgo(300), minsAgo(10)], now)).toBe(false);
  });

  it("stops after the daily attempt cap however long ago they were", () => {
    const capped = Array.from({ length: SENTIMENT_MAX_ATTEMPTS_PER_DAY }, (_, i) => minsAgo(600 - i * 180));
    expect(shouldAttemptSentiment(capped, now)).toBe(false);
  });

  it("summarises the failure on the row without pretending it is a reading", () => {
    expect(llmFailureSummary(new LlmResponseError("Empty model response."))).toBe("LLM call failed: Empty model response.");
    expect(llmFailureSummary(new DOMException("aborted", "AbortError"))).toBe("LLM call failed: timed out.");
    expect(llmFailureSummary(new LlmHttpError(503))).toBe("LLM call failed: LLM error: 503");
    expect(llmFailureSummary(new Error("x".repeat(500))).length).toBeLessThanOrEqual(200);
  });
});
