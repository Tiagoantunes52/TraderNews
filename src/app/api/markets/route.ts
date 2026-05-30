import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";

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
