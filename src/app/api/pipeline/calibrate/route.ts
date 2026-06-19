import { runCalibrateStage } from "@/lib/calibration-data";
import { stageRoute } from "@/lib/pipeline-route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = stageRoute("calibrate", runCalibrateStage);
export const GET = handle;
export const POST = handle;
