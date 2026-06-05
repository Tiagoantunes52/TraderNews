import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";
import { requireAdmin } from "@/lib/auth";

// Admin "run now" button — runs every stage to completion. May approach the
// limit on a large watchlist; partial progress persists and the scheduled cron
// finishes the rest, since every stage is idempotent and resumable.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

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
