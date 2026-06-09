import { runEstimateStage } from "@/lib/pipeline";
import { stageRoute } from "@/lib/pipeline-route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = stageRoute("estimate", runEstimateStage);
export const GET = handle;
export const POST = handle;
