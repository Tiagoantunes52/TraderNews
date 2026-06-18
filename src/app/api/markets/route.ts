import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { withRoute } from "@/lib/observability";
import { enforceRateLimit } from "@/lib/rate-limit";

// Parse the JSON body and require a non-empty string `marketId` — mirrors the
// watchlist-POST validation so malformed input is a 400, not a 500 + Sentry noise
// (and never reaches Prisma as a non-string). Returns the id or an error response.
async function readMarketId(req: Request): Promise<string | NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const marketId = (body as { marketId?: unknown })?.marketId;
  if (typeof marketId !== "string" || !marketId) {
    return NextResponse.json({ error: "`marketId` is required" }, { status: 400 });
  }
  return marketId;
}

export const POST = withRoute("markets", async (req: Request) => {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await enforceRateLimit("mutation", user.id);
  if (limited) return limited;

  const marketId = await readMarketId(req);
  if (marketId instanceof NextResponse) return marketId;

  await db.userMarket.upsert({
    where: { userId_marketId: { userId: user.id, marketId } },
    update: {},
    create: { userId: user.id, marketId },
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withRoute("markets", async (req: Request) => {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await enforceRateLimit("mutation", user.id);
  if (limited) return limited;

  const marketId = await readMarketId(req);
  if (marketId instanceof NextResponse) return marketId;

  await db.userMarket.deleteMany({ where: { userId: user.id, marketId } });

  return NextResponse.json({ ok: true });
});
