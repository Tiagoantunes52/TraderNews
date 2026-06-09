// Sentry init for the Node.js server runtime. Loaded by `register()` in
// instrumentation.ts. No DSN ⇒ disabled (safe for local dev / CI).
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Trace a sample of requests for performance; keep low on the free tier.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  // We attach context explicitly via reportError; don't auto-collect PII.
  sendDefaultPii: false,
});
