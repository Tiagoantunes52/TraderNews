"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Star, Loader2, Check } from "lucide-react";

export function WatchlistToggleButton({
  stockId,
  ticker,
  initialFollowed,
}: {
  stockId: string;
  ticker: string;
  initialFollowed: boolean;
}) {
  const [followed, setFollowed] = useState(initialFollowed);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = () => {
    const next = !followed;
    setFollowed(next);
    startTransition(async () => {
      try {
        const res = await fetch("/api/watchlist", {
          method: next ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(next ? `Added ${ticker} to watchlist` : `Removed ${ticker} from watchlist`);
        router.refresh();
      } catch (err) {
        setFollowed(!next);
        toast.error(`Couldn't ${next ? "add" : "remove"} ${ticker}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    });
  };

  return (
    <Button
      onClick={toggle}
      disabled={pending}
      variant={followed ? "secondary" : "default"}
      className="gap-2"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : followed ? (
        <Check className="h-4 w-4" />
      ) : (
        <Star className="h-4 w-4" />
      )}
      {followed ? "In watchlist" : "Add to watchlist"}
    </Button>
  );
}
