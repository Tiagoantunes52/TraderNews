// @vitest-environment node
//
// Node environment, not the jsdom default: this suite pulls in `lib/pipeline` →
// `lib/observability` → `@sentry/nextjs`, whose vendored orchestrion webpack shim
// branches on `typeof document` and dies under jsdom. Nothing here touches the DOM.
import { describe, it, expect } from "vitest";
import { REQUEST_TIMEOUT_MS } from "@/lib/llm";
import { SENTIMENT_BUDGET_MS, SENTIMENT_CONCURRENCY } from "@/lib/pipeline/sentiment";

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
