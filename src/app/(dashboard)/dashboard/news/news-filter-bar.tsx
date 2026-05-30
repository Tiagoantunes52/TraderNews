"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const TIME_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;

const MOOD_OPTIONS = [
  { value: "all", label: "All" },
  { value: "bull", label: "Bullish 📈" },
  { value: "neutral", label: "Neutral 😐" },
  { value: "bear", label: "Bearish 📉" },
] as const;

export function NewsFilterBar({ tickers }: { tickers: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const currentQ = searchParams.get("q") ?? "";
  const currentTime = searchParams.get("time") ?? "all";
  const currentMood = searchParams.get("mood") ?? "all";
  const currentTicker = searchParams.get("ticker") ?? "all";

  const [searchValue, setSearchValue] = useState(currentQ);

  const updateParam = (key: string, value: string, { replace = false } = {}) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === "all" || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    startTransition(() => {
      if (replace) router.replace(url);
      else router.push(url);
    });
  };

  // Keep local input in sync if URL changes externally (e.g. clear filters)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional URL→input sync
    setSearchValue(currentQ);
  }, [currentQ]);

  // Debounce search input → URL
  useEffect(() => {
    if (searchValue === currentQ) return;
    const t = setTimeout(() => {
      updateParam("q", searchValue, { replace: true });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  const clearAll = () => {
    setSearchValue("");
    startTransition(() => {
      router.push(pathname);
    });
  };

  const hasAnyFilter =
    currentQ !== "" || currentTime !== "all" || currentMood !== "all" || currentTicker !== "all";

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9 pr-9"
          placeholder="Search headlines..."
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
        />
        {pending && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {/* Time + Mood chip rows */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 flex-wrap">
        <ChipGroup
          label="When"
          options={TIME_OPTIONS}
          value={currentTime}
          onChange={(v) => updateParam("time", v)}
        />
        <ChipGroup
          label="Mood"
          options={MOOD_OPTIONS}
          value={currentMood}
          onChange={(v) => updateParam("mood", v)}
        />
      </div>

      {/* Ticker chips (only if user has watchlist) */}
      {tickers.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-muted-foreground shrink-0">Ticker</span>
          <button
            type="button"
            onClick={() => updateParam("ticker", "all")}
            className={cn(
              "transition-colors",
              currentTicker === "all" ? "" : "opacity-50 hover:opacity-100"
            )}
          >
            <Badge variant={currentTicker === "all" ? "default" : "outline"} className="cursor-pointer">
              All
            </Badge>
          </button>
          {tickers.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => updateParam("ticker", t)}
              className={cn(
                "transition-colors",
                currentTicker === t ? "" : "opacity-60 hover:opacity-100"
              )}
            >
              <Badge variant={currentTicker === t ? "default" : "outline"} className="cursor-pointer">
                {t}
              </Badge>
            </button>
          ))}
        </div>
      )}

      {hasAnyFilter && (
        <Button variant="ghost" size="sm" onClick={clearAll} className="gap-1 h-7 px-2 text-xs">
          <X className="h-3 w-3" /> Clear filters
        </Button>
      )}
    </div>
  );
}

function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs font-medium text-muted-foreground shrink-0">{label}</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "text-xs px-2.5 py-1 rounded-full border transition-colors",
            value === opt.value
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-transparent text-muted-foreground border-border hover:bg-muted"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
