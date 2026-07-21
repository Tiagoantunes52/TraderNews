import { runReviewStage } from "@/lib/pipeline";
import { stageRoute } from "@/lib/pipeline-route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = stageRoute("review", runReviewStage);
export const GET = handle;
export const POST = handle;
