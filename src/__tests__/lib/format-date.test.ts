import { describe, it, expect, vi, afterEach } from "vitest";
import { formatDistanceToNow } from "@/lib/format-date";

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

afterEach(() => vi.restoreAllMocks());

function ago(ms: number) {
  return new Date(NOW - ms);
}

describe("formatDistanceToNow()", () => {
  it('returns "just now" for less than 60 seconds ago', () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatDistanceToNow(ago(0))).toBe("just now");
    expect(formatDistanceToNow(ago(59_000))).toBe("just now");
  });

  it("returns minutes for 1–59 minutes ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatDistanceToNow(ago(60_000))).toBe("1m ago");
    expect(formatDistanceToNow(ago(90_000))).toBe("1m ago");
    expect(formatDistanceToNow(ago(59 * 60_000))).toBe("59m ago");
  });

  it("returns hours for 1–23 hours ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatDistanceToNow(ago(60 * 60_000))).toBe("1h ago");
    expect(formatDistanceToNow(ago(23 * 60 * 60_000))).toBe("23h ago");
  });

  it("returns days for 24+ hours ago", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatDistanceToNow(ago(24 * 60 * 60_000))).toBe("1d ago");
    expect(formatDistanceToNow(ago(7 * 24 * 60 * 60_000))).toBe("7d ago");
  });
});
