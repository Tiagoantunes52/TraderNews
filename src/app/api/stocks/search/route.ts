import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { searchStocks } from "@/lib/finnhub";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { marketNamesForTicker } from "@/lib/market-utils";
import { withRoute } from "@/lib/observability";
import { enforceRateLimit } from "@/lib/rate-limit";

async function inferMarket(ticker: string) {
  const names = marketNamesForTicker(ticker);
  return (
    await db.market.findFirst({ where: { name: { in: names } } }) ??
    await db.market.findFirst()
  );
}

type SearchStock = { id: string; ticker: string; name: string };

export const GET = withRoute("stocks/search", async (req: Request) => {
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Search hits Finnhub + upserts per keystroke — the hottest path, rate-limited first.
  const limited = await enforceRateLimit("search", user.id);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("q");
  if (!raw) return NextResponse.json([]);
  // Cap the query length — a real ticker/name is short; anything longer is wasted
  // Finnhub calls + a wider DB scan, and bounds the abuse surface here (#17).
  const q = raw.trim().slice(0, 50);
  if (!q) return NextResponse.json([]);

  // 1. Local DB first — covers everything we've seeded (crypto, ETFs, and the
  //    international listings Finnhub's symbol search filters out).
  const local = await db.stock.findMany({
    where: {
      OR: [
        { ticker: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, ticker: true, name: true },
    orderBy: { ticker: "asc" },
    take: 10,
  });

  // 2. Finnhub for discovering US tickers not yet in the DB. Don't let a Finnhub
  //    failure block the local results.
  const byTicker = new Map<string, SearchStock>(local.map((s) => [s.ticker, s]));
  try {
    const result = await searchStocks(q);
    const seen = new Set<string>();
    const candidates = result.result
      .filter((s) => s.type === "Common Stock" && s.symbol && !seen.has(s.symbol) && seen.add(s.symbol))
      .filter((s) => !byTicker.has(s.symbol))
      .slice(0, 10);

    for (const s of candidates) {
      const market = await inferMarket(s.symbol);
      if (!market) continue;
      // Create-only: never mutate a shared Stock row from a search. The old `update`
      // branch let any user's typeahead overwrite the name/market that everyone sees
      // (shared-data pollution, #17). New tickers are still discovered and inserted.
      const stock = await db.stock.upsert({
        where: { ticker: s.symbol },
        update: {},
        create: { ticker: s.symbol, name: s.description, marketId: market.id },
      });
      if (!byTicker.has(stock.ticker)) {
        byTicker.set(stock.ticker, { id: stock.id, ticker: stock.ticker, name: stock.name });
      }
    }
  } catch {
    // Finnhub unavailable — local results still stand.
  }

  return NextResponse.json([...byTicker.values()].slice(0, 15));
});
