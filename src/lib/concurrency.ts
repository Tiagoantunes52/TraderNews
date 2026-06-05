// Bounded-concurrency worker pool with a wall-clock budget.
//
// The pipeline's per-stock stages (sentiment, quant, estimate) run on serverless
// invocations with a hard ~300s ceiling. `processWithBudget` lets a stage chew
// through a worklist with a few requests in flight at once, but stop scheduling
// new items once a deadline is reached — so the invocation always returns before
// the platform kills it. Items already in flight are awaited; whatever's left is
// reported as `remaining` so a follow-up invocation can resume (the stages'
// per-day dedup guards make the worklist naturally shrink each run).

export type BudgetOutcome = {
  /** Items that finished this invocation. */
  processed: number;
  /** Items never started because the deadline hit first. */
  remaining: number;
  /** True when the whole worklist was drained. */
  done: boolean;
};

/**
 * Run `worker` over `items` with at most `concurrency` in flight, stopping the
 * scheduling of new items once `Date.now() >= deadline`. The worker is invoked
 * once per item; throwing is the worker's own concern (it should catch and
 * record per-item failures so one bad item doesn't abort the pool).
 */
export async function processWithBudget<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: { concurrency: number; deadline: number }
): Promise<BudgetOutcome> {
  const concurrency = Math.max(1, Math.min(opts.concurrency, items.length || 1));
  let nextIndex = 0;
  let processed = 0;

  async function runLane(): Promise<void> {
    while (true) {
      // Stop pulling new work once we're out of budget — in-flight items in the
      // other lanes still finish via the Promise.all below.
      if (Date.now() >= opts.deadline) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index], index);
      processed++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runLane));

  const remaining = items.length - processed;
  return { processed, remaining, done: remaining === 0 };
}
