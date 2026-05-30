import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";

export async function POST(req: Request) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { stockId } = await req.json();

  await db.userStock.upsert({
    where: { userId_stockId: { userId: user.id, stockId } },
    update: {},
    create: { userId: user.id, stockId },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { stockId } = await req.json();

  await db.userStock.deleteMany({ where: { userId: user.id, stockId } });

  return NextResponse.json({ ok: true });
}
