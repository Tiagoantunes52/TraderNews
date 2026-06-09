// Client instrumentation entry (Next.js convention). Runs in the browser before
// hydration. Only NEXT_PUBLIC_* env vars are available here. No DSN ⇒ disabled.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  // Session Replay off by default to conserve the free-tier quota; raise these
  // (e.g. replaysOnErrorSampleRate: 1.0) once a DSN is wired up if you want it.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  sendDefaultPii: false,
});

// Lets Sentry tie client-side navigations to traces.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
