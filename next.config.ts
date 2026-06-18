import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const isDev = process.env.NODE_ENV === "development";

// Content-Security-Policy ships in REPORT-ONLY mode first (#15): the browser reports
// violations (console + report-uri) without blocking, so we can observe what Clerk,
// Sentry, and Vercel Analytics/Speed-Insights actually load before flipping to
// enforcement. script/style still allow 'unsafe-inline' — next-themes injects an
// anti-FOUC inline script, and Clerk + recharts emit inline styles; 'unsafe-eval' is
// dev-only (React's dev build uses eval). Tightening to a nonce-based policy (and
// dropping 'unsafe-inline') is the follow-up once reports are quiet. Keep the
// third-party domains here in sync with what the app embeds.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.clerk.accounts.dev https://challenges.cloudflare.com https://va.vercel-scripts.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://img.clerk.com",
  "font-src 'self'",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.ingest.sentry.io https://*.ingest.de.sentry.io https://vitals.vercel-insights.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://challenges.cloudflare.com",
  "upgrade-insecure-requests",
].join("; ");

// Static hardening headers — enforced immediately (no tuning needed). X-Frame-Options
// closes the clickjacking hole now; CSP frame-ancestors is the modern backstop once it
// flips from report-only to enforcing.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.109"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

// Sentry wraps the config to inject client init and (when a token is present)
// upload source maps. Everything degrades gracefully without env vars: no DSN
// means the runtime SDK is disabled, and no SENTRY_AUTH_TOKEN means source-map
// upload is skipped — the build never fails for missing Sentry config.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  silent: !process.env.CI,
  disableLogger: true, // strip Sentry's own debug logging from the client bundle
  telemetry: false,
});
