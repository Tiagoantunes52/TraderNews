import { db } from "@/lib/db";

/** Key under which the watchlist cap is stored in the AppSetting table. */
export const WATCHLIST_LIMIT_KEY = "watchlistLimit";

/** Default cap on combined watchlist items (stocks + ETFs + crypto) per user. */
export const DEFAULT_WATCHLIST_LIMIT = 20;
export const MIN_WATCHLIST_LIMIT = 1;
export const MAX_WATCHLIST_LIMIT = 500;

/** Coerce any number into a valid integer limit within [MIN, MAX]. */
export function clampWatchlistLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WATCHLIST_LIMIT;
  return Math.min(MAX_WATCHLIST_LIMIT, Math.max(MIN_WATCHLIST_LIMIT, Math.floor(n)));
}

/** Parse a stored string value into a valid limit, falling back to the default. */
export function parseWatchlistLimit(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_WATCHLIST_LIMIT;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? DEFAULT_WATCHLIST_LIMIT : clampWatchlistLimit(n);
}

/** Read the current global watchlist limit (or the default if unset). */
export async function getWatchlistLimit(): Promise<number> {
  const row = await db.appSetting.findUnique({ where: { key: WATCHLIST_LIMIT_KEY } });
  return parseWatchlistLimit(row?.value);
}

/** Persist a new global watchlist limit; returns the clamped value actually stored. */
export async function setWatchlistLimit(n: number): Promise<number> {
  const value = clampWatchlistLimit(n);
  await db.appSetting.upsert({
    where: { key: WATCHLIST_LIMIT_KEY },
    update: { value: String(value) },
    create: { key: WATCHLIST_LIMIT_KEY, value: String(value) },
  });
  return value;
}
