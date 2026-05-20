import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { searchStocks } from "@/lib/finnhub";
import { getOrCreateUser } from "@/lib/get-or-create-user";

export async function GET(req: Request) {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  if (!q || q.length < 1) return NextResponse.json([]);

  const result = await searchStocks(q);

  const stocks = result.result
    .filter((s) => s.type === "Common Stock" && s.symbol)
    .slice(0, 10);

  const saved = await Promise.all(
    stocks.map(async (s) => {
      let market = await db.market.findFirst({
        where: { name: { in: ["NYSE", "NASDAQ"] } },
      });
      if (!market) market = await db.market.findFirst();
      if (!market) return null;

      return db.stock.upsert({
        where: { ticker: s.symbol },
        update: { name: s.description },
        create: { ticker: s.symbol, name: s.description, marketId: market.id },
      });
    })
  );

  return NextResponse.json(saved.filter(Boolean));
}
