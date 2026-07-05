import { runPrivateCompaniesStage } from "@/lib/private-companies";
import { stageRoute } from "@/lib/pipeline-route";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const handle = stageRoute("private-companies", runPrivateCompaniesStage);
export const GET = handle;
export const POST = handle;
