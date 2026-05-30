"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function MarketToggleCard({
  marketId,
  name,
  description,
  followed: initialFollowed,
  icon,
  colorClass,
}: {
  marketId: string;
  name: string;
  description: string | null;
  followed: boolean;
  icon: string;
  colorClass: string;
}) {
  const router = useRouter();
  const [followed, setFollowed] = useState(initialFollowed);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !followed;
    setFollowed(next);
    startTransition(async () => {
      try {
        const res = await fetch("/api/markets", {
          method: next ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marketId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(next ? `Following ${name}` : `Unfollowed ${name}`);
        router.refresh();
      } catch (err) {
        setFollowed(!next);
        toast.error(`Couldn't ${next ? "follow" : "unfollow"} ${name}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={followed}
      aria-label={`${followed ? "Unfollow" : "Follow"} ${name}`}
      className="text-left"
    >
      <Card
        className={cn(
          "cursor-pointer border-2 transition-all select-none",
          followed ? `${colorClass} border-opacity-100` : "hover:bg-muted/50 border-transparent",
          pending && "opacity-80"
        )}
      >
        <CardHeader className="pb-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl" aria-hidden>{icon}</span>
              <CardTitle className="text-base">{name}</CardTitle>
            </div>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : followed ? (
              <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                <Check className="h-3 w-3 text-primary-foreground" />
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription>{description}</CardDescription>
        </CardContent>
      </Card>
    </button>
  );
}
