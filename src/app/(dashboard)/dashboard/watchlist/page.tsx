import Link from "next/link";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { AddStockSearch } from "./add-stock-search";
import { WatchlistRow } from "./watchlist-row";

export const metadata = { title: "Watchlist — TraderNews" };

function SentimentIndicator({ score }: { score?: number }) {
  if (score === undefined) return <Badge variant="outline" className="text-xs">No data</Badge>;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 text-xs"><TrendingUp className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 text-xs"><TrendingDown className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
  return <Badge variant="secondary" className="text-xs"><Minus className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
}

export default async function WatchlistPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const userStocks = await db.userStock.findMany({
    where: { userId: user.id },
    include: {
      stock: {
        include: {
          market: { select: { name: true } },
          sentiments: { orderBy: { date: "desc" }, take: 1, select: { score: true } },
        },
      },
    },
    orderBy: { stock: { ticker: "asc" } },
  });

  const watchlist = userStocks.map((us) => us.stock);
  const watchlistIds = watchlist.map((s) => s.id);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Watchlist</h1>
        <p className="text-muted-foreground text-sm mt-1">Track stocks and see their sentiment</p>
      </div>

      <AddStockSearch existingIds={watchlistIds} />

      <div className="space-y-2">
        {watchlist.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No stocks in your watchlist yet. Search above to add some.
            </CardContent>
          </Card>
        ) : (
          watchlist.map((stock) => (
            <WatchlistRow key={stock.id} stockId={stock.id} ticker={stock.ticker}>
              <div className="flex items-center gap-3">
                <Link
                  href={`/dashboard/stocks/${stock.ticker}`}
                  className="-mx-1 px-1 py-0.5 rounded hover:bg-muted transition-colors"
                >
                  <CardTitle className="text-base">{stock.ticker}</CardTitle>
                  <p className="text-xs text-muted-foreground">{stock.name} · {stock.market.name}</p>
                </Link>
                <SentimentIndicator score={stock.sentiments[0]?.score} />
              </div>
            </WatchlistRow>
          ))
        )}
      </div>
    </div>
  );
}
