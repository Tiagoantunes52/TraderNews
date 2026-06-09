// Resilient fetch for flaky third-party APIs.
//
// Free-tier news/price endpoints fail at the transport level surprisingly often
// — undici throws `TypeError: fetch failed` on connect timeouts, DNS blips, and
// dropped keep-alive sockets (common when an adapter paces requests with long
// idle sleeps). A bare `fetch` turns any such blip into a hard failure.
//
// fetchWithRetry adds a per-attempt timeout and a few retries with linear
// backoff. It returns the Response unchanged, so callers keep their own
// `res.ok` / status handling. Retries cover transport rejections and 5xx; it
// deliberately does NOT retry 4xx (e.g. 403 permission, 429 rate limit), where
// retrying is pointless or harmful.

import { logger } from "@/lib/logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostOf(input: string | URL): string {
  try {
    return new URL(input.toString()).host;
  } catch {
    return "unknown";
  }
}

export type FetchRetryOptions = {
  timeoutMs?: number;          // per-attempt timeout
  attempts?: number;           // total attempts including the first
  retryDelayMs?: number;       // base backoff, multiplied by attempt number
  retryOnServerError?: boolean; // retry on HTTP 5xx
};

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 15_000,
    attempts = 3,
    retryDelayMs = 500,
    retryOnServerError = true,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      if (retryOnServerError && res.status >= 500 && attempt < attempts) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return res; // success, or a non-retryable status the caller will handle
      }
    } catch (e) {
      lastErr = e;
      if (attempt >= attempts) throw e;
    } finally {
      clearTimeout(timer);
    }
    // Reached only when we're about to retry (success returns above; the final
    // failed attempt throws above). One warn per retry surfaces which upstream
    // is flapping without waiting for the caller to swallow it into a string.
    logger.warn("fetch_retry", {
      host: hostOf(input),
      attempt,
      attempts,
      reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    await sleep(retryDelayMs * attempt);
  }
  throw lastErr;
}
