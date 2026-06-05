import { describe, it, expect } from "vitest";
import { processWithBudget } from "@/lib/concurrency";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("processWithBudget", () => {
  it("processes every item when the budget is ample", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const seen: number[] = [];
    const outcome = await processWithBudget(
      items,
      async (item) => {
        seen.push(item);
      },
      { concurrency: 3, deadline: Date.now() + 10_000 }
    );
    expect(outcome).toEqual({ processed: 10, remaining: 0, done: true });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("passes the item and its index to the worker", async () => {
    const pairs: Array<[string, number]> = [];
    await processWithBudget(
      ["a", "b", "c"],
      async (item, index) => {
        pairs.push([item, index]);
      },
      { concurrency: 1, deadline: Date.now() + 10_000 }
    );
    expect(pairs).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    await processWithBudget(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick();
        active--;
      },
      { concurrency: 4, deadline: Date.now() + 10_000 }
    );
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1); // proves it actually parallelised
  });

  it("stops scheduling new work once the deadline has passed", async () => {
    const seen: number[] = [];
    const outcome = await processWithBudget(
      Array.from({ length: 8 }, (_, i) => i),
      async (item) => {
        seen.push(item);
      },
      { concurrency: 2, deadline: Date.now() - 1 } // already expired
    );
    expect(seen).toHaveLength(0);
    expect(outcome.processed).toBe(0);
    expect(outcome.remaining).toBe(8);
    expect(outcome.done).toBe(false);
  });

  it("reports done for an empty worklist", async () => {
    const outcome = await processWithBudget([], async () => {}, { concurrency: 3, deadline: Date.now() + 1000 });
    expect(outcome).toEqual({ processed: 0, remaining: 0, done: true });
  });

  it("processes a partial slice when the budget runs out mid-run", async () => {
    // Budget allows ~3 sequential 20ms items before the 50ms deadline.
    const start = Date.now();
    const outcome = await processWithBudget(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        await tick(20);
      },
      { concurrency: 1, deadline: start + 50 }
    );
    expect(outcome.processed).toBeGreaterThan(0);
    expect(outcome.processed).toBeLessThan(20);
    expect(outcome.remaining).toBe(20 - outcome.processed);
    expect(outcome.done).toBe(false);
  });
});
