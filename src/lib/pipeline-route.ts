import { NextResponse } from "next/server";
import { isPipelineAuthorized } from "@/lib/cron-auth";
import { withRoute, logStageResult, newRunId } from "@/lib/observability";
import { logger } from "@/lib/logger";

type StageResult = { errors?: string[]; [k: string]: unknown };

/**
 * Shared GET/POST handler for a single pipeline-stage endpoint. Adds, around the
 * stage runner:
 *  - cron authorization (same as before),
 *  - a run id (honouring an inbound `x-pipeline-run-id` header so all stages of
 *    one GitHub Actions run correlate),
 *  - a structured start record and a per-invocation result record (counts,
 *    duration, done/remaining, errors) shipped to Axiom,
 *  - withRoute's request logging + Sentry error reporting (replacing the old
 *    `catch (e) => String(e)` that lost the stack trace).
 */
export function stageRoute(stage: string, run: () => Promise<StageResult>) {
  return withRoute(`pipeline/${stage}`, async (req: Request): Promise<Response> => {
    if (!isPipelineAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const runId = req.headers.get("x-pipeline-run-id") ?? newRunId();
    const startedAt = Date.now();
    logger.child({ stage, runId }).info("pipeline_stage_start");
    const result = await run();
    logStageResult(stage, runId, startedAt, result);
    return NextResponse.json(result);
  });
}
