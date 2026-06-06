import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  setWatchlistLimit,
  MIN_WATCHLIST_LIMIT,
  MAX_WATCHLIST_LIMIT,
} from "@/lib/settings";

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
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
}
