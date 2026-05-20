"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

type Market = {
  id: string;
  name: string;
  description: string | null;
  followed: boolean;
};

const MARKET_META: Record<string, { icon: string; color: string }> = {
  NYSE:   { icon: "🏛️", color: "bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800" },
  NASDAQ: { icon: "💻", color: "bg-purple-50 border-purple-200 dark:bg-purple-950 dark:border-purple-800" },
  LSE:    { icon: "🇬🇧", color: "bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800" },
  CRYPTO: { icon: "₿",  color: "bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800" },
  FOREX:  { icon: "💱", color: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" },
};

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data) => { setMarkets(data); setLoading(false); });
  }, []);

  const toggle = async (market: Market) => {
    setPending(market.id);
    const method = market.followed ? "DELETE" : "POST";
    await fetch("/api/markets", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: market.id }),
    });
    setMarkets((prev) =>
      prev.map((m) => m.id === market.id ? { ...m, followed: !m.followed } : m)
    );
    setPending(null);
  };

  const followed = markets.filter((m) => m.followed);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Markets</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select the markets you want to follow. News and sentiment will be filtered to your selection.
        </p>
      </div>

      {followed.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {followed.map((m) => (
            <Badge key={m.id} variant="secondary" className="text-xs gap-1">
              {MARKET_META[m.name]?.icon} {m.name}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)
          : markets.map((market) => {
              const meta = MARKET_META[market.name];
              return (
                <Card
                  key={market.id}
                  onClick={() => !pending && toggle(market)}
                  className={cn(
                    "cursor-pointer border-2 transition-all select-none",
                    market.followed
                      ? `${meta?.color} border-opacity-100`
                      : "hover:bg-muted/50 border-transparent",
                    pending === market.id && "opacity-60 pointer-events-none"
                  )}
                >
                  <CardHeader className="pb-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">{meta?.icon}</span>
                        <CardTitle className="text-base">{market.name}</CardTitle>
                      </div>
                      {market.followed && (
                        <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <CardDescription>{market.description}</CardDescription>
                  </CardContent>
                </Card>
              );
            })}
      </div>
    </div>
  );
}
