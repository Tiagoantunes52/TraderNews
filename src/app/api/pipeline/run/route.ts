import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";
import { isPipelineAuthorized } from "@/lib/cron-auth";
import { withRoute, logStageResult, newRunId } from "@/lib/observability";

// All-in-one run (every stage to completion). Kept for manual/legacy triggers;
// the scheduled GitHub Actions cron uses the per-stage endpoints so no single
// invocation runs the whole pipeline within one 300s window.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = withRoute("pipeline/run", async (req: Request): Promise<Response> => {
  if (!isPipelineAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const runId = newRunId();
  const startedAt = Date.now();
  const result = await runPipeline();
  logStageResult("run", runId, startedAt, result);
  return NextResponse.json(result);
});

export const GET = handle;
export const POST = handle;
