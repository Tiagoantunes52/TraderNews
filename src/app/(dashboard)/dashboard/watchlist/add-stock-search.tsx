"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, Loader2 } from "lucide-react";

type SearchStock = { id: string; ticker: string; name: string };

export function AddStockSearch({ existingIds }: { existingIds: string[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchStock[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, startAdd] = useTransition();
  const [addingId, setAddingId] = useState<string | null>(null);
  // Locally remember which stocks the user just added so the dropdown shows "Added"
  // immediately, before the server-rendered list refreshes.
  const [optimisticAdded, setOptimisticAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (query.length < 1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on empty query
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`);
        setResults(await res.json());
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [query]);

  const addStock = (stock: SearchStock) => {
    setAddingId(stock.id);
    setOptimisticAdded((prev) => new Set(prev).add(stock.id));

    startAdd(async () => {
      try {
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockId: stock.id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(`Added ${stock.ticker} to watchlist`);
        setQuery("");
        setResults([]);
        router.refresh();
      } catch (err) {
        // Revert optimistic state on failure
        setOptimisticAdded((prev) => {
          const next = new Set(prev);
          next.delete(stock.id);
          return next;
        });
        toast.error(`Couldn't add ${stock.ticker}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setAddingId(null);
      }
    });
  };

  const isInWatchlist = (id: string) => existingIds.includes(id) || optimisticAdded.has(id);
  const showDropdown = results.length > 0 || searching;

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        className="pl-9"
        placeholder="Search stocks to add (e.g. AAPL, Tesla)..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {showDropdown && (
        <Card className="absolute z-10 w-full mt-1 shadow-lg">
          <CardContent className="p-1">
            {searching && (
              <div className="px-3 py-2 text-sm text-muted-foreground">Searching...</div>
            )}
            {results.map((stock) => {
              const already = isInWatchlist(stock.id);
              const isAdding = addingId === stock.id && adding;
              return (
                <div
                  key={stock.id}
                  className="flex items-center justify-between px-3 py-2 hover:bg-muted rounded"
                >
                  <div>
                    <span className="font-medium text-sm">{stock.ticker}</span>
                    <span className="text-muted-foreground text-sm ml-2">{stock.name}</span>
                  </div>
                  {already ? (
                    <Badge variant="secondary" className="text-xs">Added</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => addStock(stock)}
                      disabled={isAdding}
                      aria-label={`Add ${stock.ticker} to watchlist`}
                    >
                      {isAdding ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
