-- Execution-path state integrity (see model comments in schema.prisma).
--
-- Three parts, all from the same root cause: the paper stage could run twice
-- concurrently and nothing downstream could tell.
--
--   1. PaperOrder.clientOrderId — an idempotency key persisted BEFORE submission and
--      sent to Alpaca as client_order_id. Previously the only handle on an order was
--      alpacaOrderId, assigned *after* the broker responded, so a crash in between left
--      a live order the app could never recognise. Existing rows stay NULL.
--   2. PipelineLease — mutual exclusion for a stage. NOT a replacement for the per-day
--      idempotency marker (the SIM_COMBINED PaperEquitySnapshot row): the marker is
--      written last so a crashed run retries, a lease is taken first so a concurrent
--      run is excluded. Both are needed.
--   3. The partial unique index enforcing "one OPEN SimPosition per (stock, strategy)"
--      — documented as an invariant since the model was written, never enforced.

-- AlterTable
ALTER TABLE "PaperOrder" ADD COLUMN     "clientOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaperOrder_clientOrderId_key" ON "PaperOrder"("clientOrderId");

-- CreateIndex
CREATE INDEX "PaperOrder_status_idx" ON "PaperOrder"("status");

-- CreateTable
CREATE TABLE "PipelineLease" (
    "stage" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineLease_pkey" PRIMARY KEY ("stage")
);

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its
-- sole purpose is to deny the Supabase Data API (anon/authenticated) by default,
-- matching every other table (see 20260606190323_harden_rls_policies). Done inline
-- here so the table is never briefly exposed via the Data API.
ALTER TABLE "PipelineLease" ENABLE ROW LEVEL SECURITY;

-- Partial unique index: at most one OPEN position per (stock, strategy).
--
-- Postgres REFUSES to build a unique index over existing duplicates, and this migration
-- must not half-apply on the day a duplicate happens to exist — that would leave the
-- lease table created and the invariant unenforced. So fail loudly and explicitly
-- first, naming what to reconcile, rather than letting CREATE INDEX raise a message
-- that says nothing about which rows are at fault.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(format('%s/%s x%s', "stockId", strategy, n), ', ')
    INTO dupes
    FROM (
      SELECT "stockId", strategy, count(*) AS n
        FROM "SimPosition"
       WHERE status = 'OPEN'
       GROUP BY 1, 2
      HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce one-OPEN-position-per-(stock,strategy): duplicates exist -> %. '
      'Close or delete the redundant OPEN rows, then re-run this migration.', dupes;
  END IF;
END
$$;

CREATE UNIQUE INDEX "SimPosition_open_unique"
    ON "SimPosition"("stockId", strategy)
 WHERE status = 'OPEN';
