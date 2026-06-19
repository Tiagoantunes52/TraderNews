"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { nextDailyRefresh, nextPerformanceRefresh } from "@/lib/pipeline-schedule";

// After the scheduled time the pipeline still needs a few minutes to fetch, score
// and write fresh rows. Wait this long past the boundary before pulling new server
// data, so router.refresh() doesn't just re-render the same stale view.
const REFRESH_GRACE_MS = 3 * 60 * 1000;

type RefreshKind = "daily" | "marketClose";

const NEXT_RUN: Record<RefreshKind, (from?: Date) => Date> = {
  daily: nextDailyRefresh,
  marketClose: nextPerformanceRefresh,
};

const TOOLTIP: Record<RefreshKind, string> = {
  daily: "This page's data refreshes once a day, on the first pipeline run after 00:00 UTC.",
  marketClose: "Performance refreshes near the US market close on weekdays (20:00 UTC EDT / 21:00 UTC EST).",
};

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${h}h ${m}m`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/**
 * Live countdown to the next time this page's data refreshes — daily at 00:00 UTC
 * for most views, or the weekday US market close for performance. Once the target
 * passes it shows "Refreshing…" and, after a short grace window, pulls fresh server
 * data and rolls to the next slot.
 */
export function RefreshCountdown({
  kind = "daily",
  className,
}: {
  kind?: RefreshKind;
  className?: string;
}) {
  const router = useRouter();
  // null until mounted so the server and first client render match — the
  // per-second clock would otherwise trigger a hydration mismatch.
  const [remaining, setRemaining] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const nextRun = NEXT_RUN[kind];
    let target = nextRun();
    let refreshed = false;

    const tick = () => {
      const now = Date.now();
      const ms = target.getTime() - now;

      if (ms > 0) {
        setRefreshing(false);
        setRemaining(ms);
        refreshed = false;
        return;
      }

      // Past the target: a refresh is in progress. Surface "Refreshing…" and, once
      // the grace window has elapsed, fetch fresh data and advance to the next slot.
      setRefreshing(true);
      setRemaining(0);
      if (!refreshed && now - target.getTime() >= REFRESH_GRACE_MS) {
        refreshed = true;
        router.refresh();
        target = nextRun();
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [kind, router]);

  return (
    <Badge
      variant="outline"
      title={TOOLTIP[kind]}
      className={cn("gap-1.5 font-normal text-muted-foreground bg-muted/30", className)}
    >
      <Clock className="h-3 w-3" />
      {remaining === null ? (
        <span>Next refresh</span>
      ) : refreshing ? (
        <span>Refreshing…</span>
      ) : (
        <>
          <span className="hidden sm:inline">Next refresh in</span>
          <span className="tabular-nums">{formatRemaining(remaining)}</span>
        </>
      )}
    </Badge>
  );
}
