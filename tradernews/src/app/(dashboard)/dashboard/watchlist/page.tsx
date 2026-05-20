"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Plus, X, TrendingUp, TrendingDown, Minus } from "lucide-react";

type Stock = { id: string; ticker: string; name: string; market: { name: string }; sentiments: { score: number }[] };

function SentimentIndicator({ score }: { score?: number }) {
  if (score === undefined) return <Badge variant="outline" className="text-xs">No data</Badge>;
  if (score > 0.2) return <Badge className="bg-green-500 hover:bg-green-600 text-xs"><TrendingUp className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
  if (score < -0.2) return <Badge className="bg-red-500 hover:bg-red-600 text-xs"><TrendingDown className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
  return <Badge variant="secondary" className="text-xs"><Minus className="h-3 w-3 mr-1" />{score.toFixed(2)}</Badge>;
}

export default function WatchlistPage() {
  const [watchlist, setWatchlist] = useState<Stock[]>([]);
  const [searchResults, setSearchResults] = useState<Stock[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  const fetchWatchlist = useCallback(async () => {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    setWatchlist(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchWatchlist(); }, [fetchWatchlist]);

  useEffect(() => {
    if (query.length < 1) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`);
      setSearchResults(await res.json());
      setSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [query]);

  const addStock = async (stockId: string) => {
    await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stockId }) });
    setQuery("");
    setSearchResults([]);
    fetchWatchlist();
  };

  const removeStock = async (stockId: string) => {
    await fetch("/api/watchlist", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stockId }) });
    setWatchlist((prev) => prev.filter((s) => s.id !== stockId));
  };

  const watchlistIds = new Set(watchlist.map((s) => s.id));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Watchlist</h1>
        <p className="text-muted-foreground text-sm mt-1">Track stocks and see their sentiment</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search stocks to add (e.g. AAPL, Tesla)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(searchResults.length > 0 || searching) && (
          <Card className="absolute z-10 w-full mt-1 shadow-lg">
            <CardContent className="p-1">
              {searching && <div className="px-3 py-2 text-sm text-muted-foreground">Searching...</div>}
              {searchResults.map((stock) => (
                <div key={stock.id} className="flex items-center justify-between px-3 py-2 hover:bg-muted rounded cursor-pointer">
                  <div>
                    <span className="font-medium text-sm">{stock.ticker}</span>
                    <span className="text-muted-foreground text-sm ml-2">{stock.name}</span>
                  </div>
                  {watchlistIds.has(stock.id) ? (
                    <Badge variant="secondary" className="text-xs">Added</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => addStock(stock.id)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : watchlist.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No stocks in your watchlist yet. Search above to add some.
            </CardContent>
          </Card>
        ) : (
          watchlist.map((stock) => (
            <Card key={stock.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <CardTitle className="text-base">{stock.ticker}</CardTitle>
                      <p className="text-xs text-muted-foreground">{stock.name} · {stock.market.name}</p>
                    </div>
                    <SentimentIndicator score={stock.sentiments[0]?.score} />
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeStock(stock.id)}>
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </CardHeader>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
