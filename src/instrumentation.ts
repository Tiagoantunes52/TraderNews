// Server instrumentation entry (Next.js convention). Initialises Sentry per
// runtime and forwards uncaught request errors to both Sentry and the logger.
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { logger } from "@/lib/logger";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Fires when Next catches a server error it didn't expect — Server Component
// renders, Route Handlers, Server Actions, and proxy/middleware. Route handlers
// wrapped with `withRoute` report their own errors first, so this mainly covers
// page/render-time failures that otherwise vanish on Hobby's 1-hour log window.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  Sentry.captureRequestError(err, request, context);

  const e = err as { message?: unknown; digest?: unknown };
  logger.error("request_error", {
    message: typeof e?.message === "string" ? e.message : String(err),
    digest: typeof e?.digest === "string" ? e.digest : undefined,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
  });
  await logger.flush();
};
