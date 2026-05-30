"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, Loader2 } from "lucide-react";

export function WatchlistRow({
  stockId,
  ticker,
  children,
}: {
  stockId: string;
  ticker: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removed, setRemoved] = useState(false);

  const remove = () => {
    setRemoved(true);
    startTransition(async () => {
      try {
        const res = await fetch("/api/watchlist", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(`Removed ${ticker} from watchlist`);
        router.refresh();
      } catch (err) {
        setRemoved(false);
        toast.error(`Couldn't remove ${ticker}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    });
  };

  if (removed) return null;

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          {children}
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={pending}
            aria-label={`Remove ${ticker} from watchlist`}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <X className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}
