import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

// Per-user rate limiting (#19), backed by Upstash Redis so the budget is shared
// across serverless instances. Best-effort: if Upstash isn't configured the limiter
// no-ops (allows the request) — matching the app's other optional integrations. Set
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to activate it in production.

// Vercel's Upstash (Redis) integration provisions the REST credentials under its own
// names — and lets you set a custom prefix — so they rarely match the canonical
// UPSTASH_REDIS_REST_* pair. Accept the explicit names first, then any env var whose
// name ends in the integration's REST suffix (covers the prefixed case). We need the
// READ-WRITE token (the limiter increments counters): `endsWith("KV_REST_API_TOKEN")`
// deliberately skips `…KV_REST_API_READ_ONLY_TOKEN`, and the URL suffix skips the
// `KV_URL` / `REDIS_URL` connection strings (those are `rediss://`, not the REST API).
function fromEnvBySuffix(suffix: string): string | undefined {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && key.endsWith(suffix)) return value;
  }
  return undefined;
}

const REST_URL = process.env.UPSTASH_REDIS_REST_URL ?? fromEnvBySuffix("KV_REST_API_URL");
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? fromEnvBySuffix("KV_REST_API_TOKEN");
const ENABLED = Boolean(REST_URL && REST_TOKEN);

export function isRateLimitConfigured(): boolean {
  return ENABLED;
}

export type RateBucket = "search" | "mutation";

// Sliding-window budget per user, per bucket. Search is the priority (every keystroke
// can hit Finnhub + upsert), but typeahead is bursty — the window is generous for
// normal use while capping a runaway client or stolen session.
const BUDGETS: Record<RateBucket, { tokens: number; window: `${number} s` }> = {
  search: { tokens: 30, window: "10 s" },
  mutation: { tokens: 20, window: "10 s" },
};

const redis = ENABLED ? new Redis({ url: REST_URL!, token: REST_TOKEN! }) : null;
const limiters = new Map<RateBucket, Ratelimit>();

function limiterFor(bucket: RateBucket): Ratelimit | null {
  if (!redis) return null;
  let limiter = limiters.get(bucket);
  if (!limiter) {
    const { tokens, window } = BUDGETS[bucket];
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(tokens, window),
      prefix: `rl:${bucket}`,
      analytics: false,
    });
    limiters.set(bucket, limiter);
  }
  return limiter;
}

let warned = false;

/**
 * Enforce the per-user limit for `bucket`. Returns a 429 `NextResponse` to return
 * from the route when the budget is exceeded, or `null` to proceed. Fails OPEN
 * (allows the request) when Upstash is unconfigured or unreachable — we favour
 * availability over strictness, and a Redis hiccup must never break the app.
 */
export async function enforceRateLimit(bucket: RateBucket, identifier: string): Promise<NextResponse | null> {
  const limiter = limiterFor(bucket);
  if (!limiter) {
    if (!warned && process.env.VERCEL_ENV === "production") {
      warned = true;
      console.warn("[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN unset — rate limiting is DISABLED");
    }
    return null;
  }
  try {
    const { success, reset } = await limiter.limit(identifier);
    if (success) return null;
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return NextResponse.json(
      { error: "Too many requests — please slow down." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  } catch (e) {
    console.warn(`[rate-limit] limiter error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
