import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRaw = vi.fn();
const executeRaw = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    $executeRaw: (...args: unknown[]) => executeRaw(...args),
  },
}));

const { acquireLease, releaseLease, LEASE_TTL_SECONDS } = await import("@/lib/pipeline-lease");

// The template-literal tag receives the static string parts first; join them so a test
// can assert on the SQL that was actually issued.
const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");

describe("acquireLease()", () => {
  beforeEach(() => {
    queryRaw.mockReset();
    executeRaw.mockReset();
  });

  it("returns a handle when the upsert returns a row", async () => {
    queryRaw.mockResolvedValue([{ holder: "whatever" }]);
    const lease = await acquireLease("paper");
    expect(lease).not.toBeNull();
    expect(lease!.stage).toBe("paper");
    expect(lease!.holder).toMatch(/[0-9a-f-]{36}/); // per-run id, not a constant
  });

  it("returns null when another run holds a live lease", async () => {
    // No row comes back: the ON CONFLICT ... WHERE expiresAt < now() guard didn't match.
    queryRaw.mockResolvedValue([]);
    expect(await acquireLease("paper")).toBeNull();
  });

  it("acquires in ONE statement that only steals an expired lease", async () => {
    // The atomicity is the whole point — a read-then-write would reintroduce the race
    // this exists to close.
    queryRaw.mockResolvedValue([{ holder: "x" }]);
    await acquireLease("paper");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/WHERE\s+"PipelineLease"\."expiresAt"\s*<\s*now\(\)/i);
    expect(sql).toMatch(/RETURNING/i);
  });

  it("gives every run a distinct holder", async () => {
    queryRaw.mockResolvedValue([{ holder: "x" }]);
    const a = await acquireLease("paper");
    const b = await acquireLease("paper");
    expect(a!.holder).not.toBe(b!.holder);
  });

  it("fails OPEN when the lease table is unreachable", async () => {
    // Refusing to run because the lock is unavailable trades a rare double-run for a
    // guaranteed no-run; the per-day marker still bounds the damage.
    queryRaw.mockRejectedValue(new Error("connection refused"));
    expect(await acquireLease("paper")).not.toBeNull();
  });

  it("defaults to a TTL comfortably longer than the 300s stage budget", async () => {
    expect(LEASE_TTL_SECONDS).toBeGreaterThan(300);
  });
});

describe("releaseLease()", () => {
  beforeEach(() => {
    queryRaw.mockReset();
    executeRaw.mockReset();
  });

  it("deletes only the row it still holds", async () => {
    // A run that overran its TTL and had the lease stolen must not delete the new
    // holder's lease on its way out.
    executeRaw.mockResolvedValue(1);
    await releaseLease({ stage: "paper", holder: "me" });
    const sql = sqlOf(executeRaw.mock.calls[0]);
    expect(sql).toMatch(/DELETE FROM "PipelineLease"/i);
    expect(sql).toMatch(/"holder"\s*=/i);
  });

  it("never throws — expiry is the backstop", async () => {
    executeRaw.mockRejectedValue(new Error("gone"));
    await expect(releaseLease({ stage: "paper", holder: "me" })).resolves.toBeUndefined();
  });
});
