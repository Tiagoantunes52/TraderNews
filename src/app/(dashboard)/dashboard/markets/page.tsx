import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/get-or-create-user";
import { MarketToggleCard } from "./market-toggle-card";

export const metadata = { title: "Markets — TraderNews" };

const MARKET_META: Record<string, { icon: string; color: string }> = {
  NYSE:   { icon: "🏛️", color: "bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800" },
  NASDAQ: { icon: "💻", color: "bg-purple-50 border-purple-200 dark:bg-purple-950 dark:border-purple-800" },
  LSE:    { icon: "🇬🇧", color: "bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800" },
  CRYPTO: { icon: "₿",  color: "bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800" },
  FOREX:  { icon: "💱", color: "bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800" },
};

export default async function MarketsPage() {
  const user = await getOrCreateUser();
  if (!user) return null;

  const [markets, followed] = await Promise.all([
    db.market.findMany({ orderBy: { name: "asc" } }),
    db.userMarket.findMany({ where: { userId: user.id }, select: { marketId: true } }),
  ]);

  const followedIds = new Set(followed.map((f) => f.marketId));
  const decorated = markets.map((m) => ({ ...m, followed: followedIds.has(m.id) }));
  const followedMarkets = decorated.filter((m) => m.followed);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Markets</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select the markets you want to follow. News and sentiment will be filtered to your selection.
        </p>
      </div>

      {followedMarkets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {followedMarkets.map((m) => (
            <Badge key={m.id} variant="secondary" className="text-xs gap-1">
              {MARKET_META[m.name]?.icon} {m.name}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {decorated.map((market) => {
          const meta = MARKET_META[market.name] ?? { icon: "📊", color: "" };
          return (
            <MarketToggleCard
              key={market.id}
              marketId={market.id}
              name={market.name}
              description={market.description}
              followed={market.followed}
              icon={meta.icon}
              colorClass={meta.color}
            />
          );
        })}
      </div>
    </div>
  );
}
