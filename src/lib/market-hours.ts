// Absolute market-close instants, and the post-close window the daily review runs in.
//
// Pure (no network/DB) so it's unit-testable; the caller supplies the broker
// calendar. Existing close-time knowledge in the app is split between
// pipeline-schedule.ts (hardcoded DST rules, explicitly "holidays are not modeled")
// and the Alpaca clock (only answers about *now*, so it can't say when today's
// session ended once it has). Neither can place a window an hour after an early
// close, which is what the review needs — hence this module.

/**
 * Offset of `tz` from UTC at instant `at`, in milliseconds (positive east of UTC).
 * Reads the zone's own wall clock through Intl, so DST transitions and any future
 * rule change come from the platform's tz database rather than hardcoded dates.
 */
export function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // Some engines render midnight as hour 24; normalize before reassembling.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - at.getTime();
}

const ET = "America/New_York";

/**
 * The UTC instant of a "YYYY-MM-DD" + "HH:MM" ET wall-clock reading.
 *
 * The offset itself depends on the instant we're solving for, so this iterates:
 * guess with a zero offset, read the true offset at that guess, correct. Two passes
 * converge for every real zone — the only way the first correction lands in a
 * different offset is a DST transition, and the second pass settles it.
 */
export function etWallClockToUtc(date: string, time: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hh, mm] = [Number(tm[1]), Number(tm[2])];
  if (hh > 23 || mm > 59) return null;

  const naive = Date.UTC(y, mo - 1, d, hh, mm);
  let ms = naive;
  for (let i = 0; i < 2; i++) ms = naive - tzOffsetMs(ET, new Date(ms));
  return new Date(ms);
}

export type TradingSession = { date: string; open: string; close: string };

/** The absolute close instant of a session, or null if its fields are malformed. */
export function sessionCloseUtc(session: TradingSession): Date | null {
  return etWallClockToUtc(session.date, session.close);
}

/**
 * The session whose close most recently preceded `now`, from a calendar covering
 * `now`. Returns null when the calendar has no session that has closed yet — which
 * is the correct answer before today's close and on a non-trading day.
 */
export function lastClosedSession(sessions: TradingSession[], now: Date): { session: TradingSession; closeAt: Date } | null {
  let best: { session: TradingSession; closeAt: Date } | null = null;
  for (const session of sessions) {
    const closeAt = sessionCloseUtc(session);
    if (!closeAt || closeAt.getTime() > now.getTime()) continue;
    if (!best || closeAt.getTime() > best.closeAt.getTime()) best = { session, closeAt };
  }
  return best;
}

/**
 * Minutes elapsed since the most recent close, or null if nothing has closed yet.
 * The review's window gate is a range over this: a dense cron ticks through the
 * whole afternoon and only the ticks inside the range do any work.
 */
export function minutesSinceClose(sessions: TradingSession[], now: Date): number | null {
  const last = lastClosedSession(sessions, now);
  if (!last) return null;
  return (now.getTime() - last.closeAt.getTime()) / 60_000;
}

/**
 * Static UTC fallback for when the broker calendar is unreachable — the counterpart
 * of withinStaticCloseWindow in the paper stage. Allows the window after BOTH
 * possible regular closes (20:00 UTC in EDT, 21:00 in EST) on weekdays. Early
 * closes and holidays are invisible here, which is exactly why the calendar is
 * preferred: this only ever runs when the broker can't be reached.
 */
export function withinStaticAfterCloseWindow(now: Date, fromMin: number, toMin: number): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const after = (close: number) => mins >= close + fromMin && mins < close + toMin;
  return after(20 * 60) || after(21 * 60);
}
