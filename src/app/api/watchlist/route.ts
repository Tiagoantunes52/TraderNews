import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { getWatchlistLimit } from "@/lib/settings";
import { withRoute } from "@/lib/observability";
import { enforceRateLimit } from "@/lib/rate-limit";

export const POST = withRoute("watchlist", async (req: Request) => {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await enforceRateLimit("mutation", user.id);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stockId = (body as { stockId?: unknown })?.stockId;
  if (typeof stockId !== "string" || !stockId) {
    return NextResponse.json({ error: "`stockId` is required" }, { status: 400 });
  }

  const limit = await getWatchlistLimit();

  // Count + create in one transaction so concurrent adds can't slip past the cap.
  // Re-adding a stock that's already watched is an idempotent no-op and never blocked.
  const created = await db.$transaction(async (tx) => {
    const existing = await tx.userStock.findUnique({
      where: { userId_stockId: { userId: user.id, stockId } },
      select: { id: true },
    });
    if (existing) return true;
    const count = await tx.userStock.count({ where: { userId: user.id } });
    if (count >= limit) return false;
    await tx.userStock.create({ data: { userId: user.id, stockId } });
    return true;
  });

  if (!created) {
    return NextResponse.json(
      { error: `Watchlist limit reached (${limit}). Remove a stock to add another.`, limit },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
});

export const DELETE = withRoute("watchlist", async (req: Request) => {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await enforceRateLimit("mutation", user.id);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stockId = (body as { stockId?: unknown })?.stockId;
  if (typeof stockId !== "string" || !stockId) {
    return NextResponse.json({ error: "`stockId` is required" }, { status: 400 });
  }

  await db.userStock.deleteMany({ where: { userId: user.id, stockId } });

  return NextResponse.json({ ok: true });
});
