import { describe, it, expect } from "vitest";
import {
  tzOffsetMs,
  etWallClockToUtc,
  sessionCloseUtc,
  lastClosedSession,
  minutesSinceClose,
  withinStaticAfterCloseWindow,
  type TradingSession,
} from "@/lib/market-hours";

const session = (date: string, close = "16:00"): TradingSession => ({ date, open: "09:30", close });

describe("tzOffsetMs", () => {
  it("reads the summer and winter offsets for New York", () => {
    expect(tzOffsetMs("America/New_York", new Date("2026-07-21T12:00:00Z"))).toBe(-4 * 3_600_000);
    expect(tzOffsetMs("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe(-5 * 3_600_000);
  });

  it("is zero for UTC", () => {
    expect(tzOffsetMs("UTC", new Date("2026-07-21T12:00:00Z"))).toBe(0);
  });
});

describe("etWallClockToUtc", () => {
  it("converts a regular close in EDT and in EST", () => {
    expect(etWallClockToUtc("2026-07-21", "16:00")?.toISOString()).toBe("2026-07-21T20:00:00.000Z");
    expect(etWallClockToUtc("2026-01-15", "16:00")?.toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });

  it("converts an early close, which a fixed UTC schedule cannot model", () => {
    expect(etWallClockToUtc("2026-11-27", "13:00")?.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(etWallClockToUtc("2026-07-03", "13:00")?.toISOString()).toBe("2026-07-03T17:00:00.000Z");
  });

  it("handles both DST transition days", () => {
    expect(etWallClockToUtc("2026-03-08", "16:00")?.toISOString()).toBe("2026-03-08T20:00:00.000Z");
    expect(etWallClockToUtc("2026-11-01", "16:00")?.toISOString()).toBe("2026-11-01T21:00:00.000Z");
  });

  it("rejects malformed input rather than guessing", () => {
    expect(etWallClockToUtc("not-a-date", "16:00")).toBeNull();
    expect(etWallClockToUtc("2026-07-21", "99:99")).toBeNull();
    expect(etWallClockToUtc("2026-07-21", "")).toBeNull();
  });
});

describe("sessionCloseUtc", () => {
  it("resolves a session's close instant", () => {
    expect(sessionCloseUtc(session("2026-07-21"))?.toISOString()).toBe("2026-07-21T20:00:00.000Z");
  });

  it("returns null for a malformed session", () => {
    expect(sessionCloseUtc(session("2026-07-21", "bad"))).toBeNull();
  });
});

describe("lastClosedSession", () => {
  const sessions = [session("2026-07-20"), session("2026-07-21"), session("2026-07-22")];

  it("picks the most recent session that has already closed", () => {
    const at = new Date("2026-07-21T21:00:00Z");
    expect(lastClosedSession(sessions, at)?.session.date).toBe("2026-07-21");
  });

  it("ignores sessions that have not closed yet", () => {
    const at = new Date("2026-07-21T18:00:00Z"); // mid-session
    expect(lastClosedSession(sessions, at)?.session.date).toBe("2026-07-20");
  });

  it("returns null when nothing has closed", () => {
    expect(lastClosedSession([session("2026-07-22")], new Date("2026-07-21T12:00:00Z"))).toBeNull();
  });
});

describe("minutesSinceClose", () => {
  it("measures from the actual close", () => {
    expect(minutesSinceClose([session("2026-07-21")], new Date("2026-07-21T21:05:00Z"))).toBe(65);
  });

  it("measures from an early close, not the usual one", () => {
    // 13:00 ET = 17:00Z; an hour later is 18:00Z, which a 20:00Z-anchored window
    // would have missed entirely.
    expect(minutesSinceClose([session("2026-07-03", "13:00")], new Date("2026-07-03T18:00:00Z"))).toBe(60);
  });

  it("is null before the first close", () => {
    expect(minutesSinceClose([session("2026-07-21")], new Date("2026-07-21T15:00:00Z"))).toBeNull();
  });
});

describe("withinStaticAfterCloseWindow", () => {
  it("opens after the EDT close", () => {
    expect(withinStaticAfterCloseWindow(new Date("2026-07-21T21:05:00Z"), 55, 115)).toBe(true);
  });

  it("opens after the EST close", () => {
    expect(withinStaticAfterCloseWindow(new Date("2026-01-15T22:05:00Z"), 55, 115)).toBe(true);
  });

  it("stays shut before the window and after it", () => {
    expect(withinStaticAfterCloseWindow(new Date("2026-07-21T20:10:00Z"), 55, 115)).toBe(false);
    expect(withinStaticAfterCloseWindow(new Date("2026-07-21T23:30:00Z"), 55, 115)).toBe(false);
  });

  it("never opens at the weekend", () => {
    // 2026-07-25 is a Saturday, 2026-07-26 a Sunday.
    expect(withinStaticAfterCloseWindow(new Date("2026-07-25T21:05:00Z"), 55, 115)).toBe(false);
    expect(withinStaticAfterCloseWindow(new Date("2026-07-26T21:05:00Z"), 55, 115)).toBe(false);
  });
});
