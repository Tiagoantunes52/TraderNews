import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { runPipeline } from "@/lib/pipeline";

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await runPipeline();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
