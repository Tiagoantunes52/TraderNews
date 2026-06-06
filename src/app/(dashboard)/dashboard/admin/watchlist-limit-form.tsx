"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListChecks, Loader2 } from "lucide-react";

const MIN = 1;
const MAX = 500;

export function WatchlistLimitForm({ initialLimit }: { initialLimit: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialLimit));
  const [saved, setSaved] = useState(initialLimit);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const parsed = Number.parseInt(value, 10);
  const valid = Number.isInteger(parsed) && parsed >= MIN && parsed <= MAX;
  const dirty = valid && parsed !== saved;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!valid) {
      setError(`Enter a whole number between ${MIN} and ${MAX}.`);
      return;
    }

    startSave(async () => {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watchlistLimit: parsed }),
      });
      const data = await res.json().catch(() => ({} as { error?: string; watchlistLimit?: number }));
      if (!res.ok) {
        const message = data.error ?? `Failed to save (HTTP ${res.status})`;
        setError(message);
        toast.error("Couldn't update watchlist limit", { description: message });
        return;
      }
      const next = data.watchlistLimit ?? parsed;
      setSaved(next);
      setValue(String(next));
      router.refresh();
      toast.success(`Watchlist limit set to ${next}`);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ListChecks className="h-4 w-4" /> Watchlist limit
        </CardTitle>
        <CardDescription>
          Maximum combined stocks, ETFs, and crypto each user can keep in their watchlist.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex gap-2 items-start">
          <div>
            <Input
              type="number"
              inputMode="numeric"
              min={MIN}
              max={MAX}
              step={1}
              className="w-28"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={saving}
              aria-label="Watchlist limit"
            />
          </div>
          <Button type="submit" disabled={saving || !dirty} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </form>
        {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
      </CardContent>
    </Card>
  );
}
