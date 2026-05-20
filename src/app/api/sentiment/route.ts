import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";

export async function GET() {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          sentiments: {
            orderBy: { date: "desc" },
            take: 30,
          },
        },
      },
    },
  });

  const data = userStocks.map(({ stock }) => ({
    id: stock.id,
    ticker: stock.ticker,
    name: stock.name,
    latest: stock.sentiments[0] ?? null,
    history: stock.sentiments
      .slice()
      .reverse()
      .map((s) => ({
        date: s.date.toISOString(),
        score: parseFloat(s.score.toFixed(3)),
        summary: s.summary,
      })),
  }));

  return NextResponse.json(data);
}
