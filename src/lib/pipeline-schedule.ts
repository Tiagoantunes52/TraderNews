// Schedule math for the dashboard "next refresh" countdowns.
//
// The signal views all render data from the News Pipeline
// (.github/workflows/pipeline.yml). That workflow triggers every 3 hours, but its
// stages are idempotent per UTC day, so the data only *changes* once a day — not
// on every trigger. Two distinct refresh cadences result:
//
//   • Daily (sentiment, analysis, watchlist insights): the sentiment/quant/estimate stages
//     skip any stock that already has a row dated >= start-of-UTC-day, so they fill
//     in on the first run after UTC midnight. → refreshes daily at 00:00 UTC.
//   • Market close (performance): the paper stage runs with PAPER_TRADE_NEAR_CLOSE=1,
//     so it only acts in the ~30 min before the US close on weekdays (16:00 ET =
//     20:00 UTC in EDT, 21:00 UTC in EST). → refreshes on the weekday US close,
//     never on weekends.

/** Next 00:00 UTC strictly after `from` — the daily News Pipeline data refresh. */
export function nextDailyRefresh(from: Date = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // Today's UTC midnight is always <= now, so the next daily refresh is tomorrow's.
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Day-of-month (1-based) of the `n`th Sunday of a month, in UTC. */
function nthSundayUTC(year: number, monthZeroBased: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, monthZeroBased, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * Whether `d` falls in US Eastern Daylight Time (EDT, UTC-4). US DST runs from
 * 07:00 UTC on the 2nd Sunday of March to 06:00 UTC on the 1st Sunday of November.
 */
function isUsEasternDST(d: Date): boolean {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSundayUTC(y, 2, 2), 7); // 2nd Sun Mar, 07:00 UTC
  const end = Date.UTC(y, 10, nthSundayUTC(y, 10, 1), 6); // 1st Sun Nov, 06:00 UTC
  const t = d.getTime();
  return t >= start && t < end;
}

/** UTC hour of the 16:00 ET market close on the day `dayRef` falls in. */
function marketCloseHourUTC(dayRef: Date): number {
  return isUsEasternDST(dayRef) ? 20 : 21;
}

/**
 * Next weekday US market close strictly after `from` — when the performance page's
 * paper book refreshes. 20:00 UTC in EDT, 21:00 UTC in EST; weekends are skipped
 * (the market is closed). US market holidays are not modeled.
 */
export function nextPerformanceRefresh(from: Date = new Date()): Date {
  for (let i = 0; i < 8; i++) {
    // Date.UTC normalizes day-of-month overflow, so this walks day by day.
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue; // Sun/Sat: market closed
    // Resolve EDT/EST from local noon so the afternoon close lands on the correct
    // side of any (always-Sunday) DST switch.
    const noon = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
    const close = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), marketCloseHourUTC(noon))
    );
    if (close.getTime() > from.getTime()) return close;
  }
  // Unreachable: a weekday close always exists within the next 8 days.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
