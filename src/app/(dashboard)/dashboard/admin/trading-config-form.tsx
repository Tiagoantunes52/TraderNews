"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SlidersHorizontal, Loader2, RotateCcw } from "lucide-react";

// Plain-data mirror of one TRADING_KNOBS entry (serialized by the server page).
export type KnobRow = {
  key: string;
  env: string;
  def: number;
  min: number;
  max: number;
  int?: boolean;
  group: string;
  label: string;
  envPinned: boolean; // an env var currently wins — the DB value is ignored
};

const GROUP_TITLES: Record<string, string> = {
  entry: "Entry gates",
  sizing: "Sizing",
  exits: "Exit ladder",
  portfolio: "Portfolio limits",
};
const GROUP_ORDER = ["entry", "sizing", "exits", "portfolio"];

export function TradingConfigForm({
  knobs,
  initialOverrides,
}: {
  knobs: KnobRow[];
  initialOverrides: Record<string, number>;
}) {
  const router = useRouter();
  // Field state as strings: "" = no override (use the default).
  const toStrings = (o: Record<string, number>) =>
    Object.fromEntries(knobs.map((k) => [k.key, o[k.key] != null ? String(o[k.key]) : ""]));
  const [values, setValues] = useState<Record<string, string>>(() => toStrings(initialOverrides));
  const [saved, setSaved] = useState<Record<string, string>>(() => toStrings(initialOverrides));
  const [saving, startSave] = useTransition();

  const parseField = (k: KnobRow, raw: string): { ok: boolean; value?: number } => {
    if (raw.trim() === "") return { ok: true }; // cleared = back to default
    const n = Number(raw);
    if (!Number.isFinite(n) || n < k.min || n > k.max || (k.int && !Number.isInteger(n))) return { ok: false };
    return { ok: true, value: n };
  };

  const fieldError = (k: KnobRow) => !parseField(k, values[k.key]).ok;
  const anyError = knobs.some(fieldError);
  const dirty = knobs.some((k) => values[k.key].trim() !== saved[k.key].trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (anyError) return;
    const overrides: Record<string, number> = {};
    for (const k of knobs) {
      const { value } = parseField(k, values[k.key]);
      if (value != null && value !== k.def) overrides[k.key] = value;
    }
    startSave(async () => {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradingConfig: overrides }),
      });
      const data = await res.json().catch(() => ({}) as { error?: string });
      if (!res.ok) {
        toast.error("Couldn't save strategy config", { description: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const next = toStrings(overrides);
      setValues(next);
      setSaved(next);
      router.refresh();
      toast.success(
        Object.keys(overrides).length > 0
          ? `Strategy config saved (${Object.keys(overrides).length} override${Object.keys(overrides).length === 1 ? "" : "s"})`
          : "Strategy config reset to defaults"
      );
    });
  };

  const overrideCount = knobs.filter((k) => saved[k.key].trim() !== "").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4" /> Trading strategy
        </CardTitle>
        <CardDescription>
          Tuning knobs for the risk-managed books and the live paper book. Empty = use the default. Changes apply on
          the next pipeline run — no redeploy. An env var, when set, overrides the value here.
          {overrideCount > 0 && ` Currently ${overrideCount} override${overrideCount === 1 ? "" : "s"}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-6">
          {GROUP_ORDER.map((group) => (
            <fieldset key={group} className="space-y-2">
              <legend className="text-sm font-semibold mb-1">{GROUP_TITLES[group] ?? group}</legend>
              {knobs
                .filter((k) => k.group === group)
                .map((k) => (
                  <div key={k.key} className="flex items-center gap-3">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={k.min}
                      max={k.max}
                      step={k.int ? 1 : "any"}
                      className={`w-28 shrink-0 ${fieldError(k) ? "border-red-500" : ""}`}
                      placeholder={String(k.def)}
                      value={values[k.key]}
                      onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                      disabled={saving || k.envPinned}
                      aria-label={k.key}
                    />
                    <div className="min-w-0 text-sm">
                      <span className="font-mono text-xs">{k.key}</span>
                      <span className="text-muted-foreground"> — {k.label}.</span>{" "}
                      <span className="text-muted-foreground/70 text-xs">
                        default {k.def}, range {k.min}–{k.max}
                        {k.envPinned && (
                          <span className="text-amber-600 dark:text-amber-500"> · pinned by {k.env}</span>
                        )}
                      </span>
                    </div>
                  </div>
                ))}
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !dirty || anyError} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving || knobs.every((k) => values[k.key].trim() === "")}
              onClick={() => setValues(Object.fromEntries(knobs.map((k) => [k.key, ""])))}
              className="gap-2"
            >
              <RotateCcw className="h-4 w-4" /> Clear all (use defaults)
            </Button>
          </div>
          {anyError && <p className="text-sm text-red-500">Fix the highlighted fields (out of range or not a number).</p>}
        </form>
      </CardContent>
    </Card>
  );
}
