import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { searchStocks } from "@/lib/finnhub";
import { getOrCreateUser } from "@/lib/get-or-create-user";

function marketNamesForTicker(ticker: string): string[] {
  if (ticker.endsWith(".LS")) return ["EURONEXT_LISBON"];
  if (ticker.endsWith(".L"))  return ["LSE"];
  if (ticker.endsWith(".PA")) return ["EURONEXT_PARIS"];
  if (ticker.endsWith(".DE")) return ["XETRA"];
  if (ticker.endsWith(".AS")) return ["EURONEXT_AMSTERDAM"];
  if (ticker.endsWith("-USD")) return ["CRYPTO"];
  return ["NYSE", "NASDAQ"];
}

async function inferMarket(ticker: string) {
  const names = marketNamesForTicker(ticker);
  return (
    await db.market.findFirst({ where: { name: { in: names } } }) ??
    await db.market.findFirst()
  );
}

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

  const saved = await Promise.all(
    stocks.map(async (s) => {
      const market = await inferMarket(s.symbol);
      if (!market) return null;
      return db.stock.upsert({
        where: { ticker: s.symbol },
        update: { name: s.description, marketId: market.id },
        create: { ticker: s.symbol, name: s.description, marketId: market.id },
      });
    })
  ).then((results) => results.filter(Boolean) as Awaited<ReturnType<typeof db.stock.upsert>>[]);

  // Deduplicate by ID before returning (defensive)
  const unique = [...new Map(saved.map((s) => [s.id, s])).values()];
  return NextResponse.json(unique);
}
