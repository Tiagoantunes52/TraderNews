import { runInsiderStage } from "@/lib/pipeline";
import { stageRoute } from "@/lib/pipeline-route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = stageRoute("insider", runInsiderStage);
export const GET = handle;
export const POST = handle;
