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

  // Deduplicate by symbol before upserting
  const seen = new Set<string>();
  const stocks = result.result
    .filter((s) => s.type === "Common Stock" && s.symbol && !seen.has(s.symbol) && seen.add(s.symbol))
    .slice(0, 10);

  const market = await db.market.findFirst({ where: { name: { in: ["NYSE", "NASDAQ"] } } })
    ?? await db.market.findFirst();
  if (!market) return NextResponse.json([]);

  const saved = await Promise.all(
    stocks.map((s) =>
      db.stock.upsert({
        where: { ticker: s.symbol },
        update: { name: s.description },
        create: { ticker: s.symbol, name: s.description, marketId: market.id },
      })
    )
  );

  // Deduplicate by ID before returning (defensive)
  const unique = [...new Map(saved.map((s) => [s.id, s])).values()];
  return NextResponse.json(unique);
}
