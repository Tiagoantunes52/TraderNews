import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";
import { requireAdmin } from "@/lib/auth";
import { withRoute, logStageResult, newRunId } from "@/lib/observability";

// Admin "run now" button — runs every stage to completion. May approach the
// limit on a large watchlist; partial progress persists and the scheduled cron
// finishes the rest, since every stage is idempotent and resumable.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export const POST = withRoute("pipeline/trigger", async (): Promise<Response> => {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const runId = newRunId();
  const startedAt = Date.now();
  const result = await runPipeline();
  logStageResult("trigger", runId, startedAt, result);
  return NextResponse.json(result);
});
