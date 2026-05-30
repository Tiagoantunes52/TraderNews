import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";
import { requireAdmin } from "@/lib/auth";

export async function POST() {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  try {
    const result = await runPipeline();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
