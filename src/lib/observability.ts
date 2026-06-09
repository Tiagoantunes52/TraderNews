/**
 * Server-side observability helpers built on top of the structured logger and
 * Sentry. Import only from server code (route handlers, the pipeline, libs) —
 * never from Client Components.
 *
 *  - `reportError`  : log an error (structured) AND capture it in Sentry with
 *                     context. Use at catch sites you care about.
 *  - `withRoute`    : wrap a route handler so every request is timed/logged and
 *                     any uncaught throw is reported + turned into a clean 500.
 *  - `logStageResult`: emit one queryable record per pipeline stage invocation.
 *  - `newRunId`     : correlation id tying a pipeline run's stages together.
 */
import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";

type Fields = Record<string, unknown>;

/** Flatten an unknown thrown value into JSON-friendly fields for logging. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = cause instanceof Error ? cause.message : String(cause);
    return out;
  }
  return { message: stringify(err) };
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(stringify(err));
}

/**
 * Log an error with structured context and capture it in Sentry. Scalar context
 * fields are promoted to Sentry tags so they're filterable (e.g. stage, ticker).
 * No-ops gracefully when Sentry has no DSN. Never throws.
 */
export function reportError(message: string, err: unknown, fields: Fields = {}): void {
  const error = toError(err);
  logger.error(message, { ...fields, err: serializeError(error) });

  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      tags[k] = String(v);
    }
  }
  try {
    Sentry.captureException(error, { tags, extra: { message, ...fields } });
  } catch {
    /* capture must never break the caller */
  }
}

// Loose constraint that accepts any route-handler signature (incl. dynamic
// routes whose 2nd arg is `{ params: Promise<...> }`) without using `any`.
type AnyRouteHandler = (...args: never[]) => Response | Promise<Response>;

/**
 * Wrap a Next.js route handler with request logging and error reporting.
 * The wrapped handler keeps the exact signature of `handler`, so Next's route
 * type-checking and dynamic `params` still work. Uncaught errors are reported
 * to Sentry + the logger and converted to a generic 500 (no internals leak).
 */
export function withRoute<H extends AnyRouteHandler>(name: string, handler: H): H {
  const wrapped = async (...args: Parameters<H>): Promise<Response> => {
    const req = args[0] as unknown as Request;
    const start = Date.now();
    let method = "?";
    let path = name;
    try {
      method = req.method;
      path = new URL(req.url).pathname;
    } catch {
      /* first arg wasn't a Request — keep defaults */
    }
    const log = logger.child({ route: name, method, path });
    try {
      const res = await handler(...args);
      log.info("request", { status: res.status, durationMs: Date.now() - start });
      return res;
    } catch (err) {
      reportError("request_failed", err, { route: name, method, path, durationMs: Date.now() - start });
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    } finally {
      // Serverless instances can freeze after the response; ship buffered logs now.
      await log.flush();
    }
  };
  return wrapped as unknown as H;
}

/** A correlation id shared across the stages of one pipeline run. */
export function newRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/**
 * Emit one structured record per pipeline-stage invocation (counts, duration,
 * done/remaining, and the full errors array — all queryable in Axiom). Stage
 * errors are surfaced as a warn; the underlying Error objects are captured with
 * stack traces at their catch sites in pipeline.ts.
 */
export function logStageResult(
  stage: string,
  runId: string,
  startedAt: number,
  result: { errors?: string[] } & Record<string, unknown>,
): void {
  const durationMs = Date.now() - startedAt;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  logger.info("pipeline_stage", { ...result, stage, runId, durationMs, errorCount: errors.length });
  if (errors.length > 0) {
    logger.warn("pipeline_stage_errors", { stage, runId, errorCount: errors.length, errors });
  }
}
