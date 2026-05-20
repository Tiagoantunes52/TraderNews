import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";

export async function GET() {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [markets, followed] = await Promise.all([
    db.market.findMany({ orderBy: { name: "asc" } }),
    db.userMarket.findMany({ where: { userId: user.id }, select: { marketId: true } }),
  ]);

  const followedIds = new Set(followed.map((f) => f.marketId));

  return NextResponse.json(
    markets.map((m) => ({ ...m, followed: followedIds.has(m.id) }))
  );
}

export async function POST(req: Request) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { marketId } = await req.json();

  await db.userMarket.upsert({
    where: { userId_marketId: { userId: user.id, marketId } },
    update: {},
    create: { userId: user.id, marketId },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { marketId } = await req.json();

  await db.userMarket.deleteMany({ where: { userId: user.id, marketId } });

  return NextResponse.json({ ok: true });
}
