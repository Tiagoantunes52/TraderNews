import { NextResponse } from "next/server";
import { runNewsStage } from "@/lib/pipeline";
import { isPipelineAuthorized } from "@/lib/cron-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (!isPipelineAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runNewsStage());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
