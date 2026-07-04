import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  setWatchlistLimit,
  MIN_WATCHLIST_LIMIT,
  MAX_WATCHLIST_LIMIT,
} from "@/lib/settings";
import { validateTradingOverrides, setTradingOverrides } from "@/lib/trading-config";
import { withRoute } from "@/lib/observability";

export const PATCH = withRoute("admin/settings", async (req: Request) => {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Strategy knobs: the form sends the COMPLETE override set (a knob reset to its
  // default is simply omitted). Validation rejects the whole write on any issue so
  // a typo never half-applies.
  const tradingRaw = (body as { tradingConfig?: unknown })?.tradingConfig;
  if (tradingRaw !== undefined) {
    const { issues } = validateTradingOverrides(tradingRaw);
    if (issues.length > 0) {
      return NextResponse.json({ error: `Invalid tradingConfig — ${issues.join("; ")}` }, { status: 400 });
    }
    const tradingConfig = await setTradingOverrides(tradingRaw);
    return NextResponse.json({ tradingConfig });
  }

  const raw = (body as { watchlistLimit?: unknown })?.watchlistLimit;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < MIN_WATCHLIST_LIMIT || value > MAX_WATCHLIST_LIMIT) {
    return NextResponse.json(
      { error: `watchlistLimit must be an integer between ${MIN_WATCHLIST_LIMIT} and ${MAX_WATCHLIST_LIMIT}` },
      { status: 400 },
    );
  }

  const watchlistLimit = await setWatchlistLimit(value);
  return NextResponse.json({ watchlistLimit });
});
