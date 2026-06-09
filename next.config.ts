import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.109"],
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
