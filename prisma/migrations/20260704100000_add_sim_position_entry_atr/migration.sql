-- AlterTable
-- ATR% captured at entry for the _RM books, so stop/trail distances are frozen at
-- entry instead of floating with today's ATR (a volatility spike must not widen a
-- stop mid-drawdown). Nullable: legacy open positions backfill to NULL and fall
-- back to the fixed stop/trail percentages, which is also frozen behavior.
-- No RLS change needed: SimPosition already has RLS enabled (see the
-- 20260615135738_add_paper_trading migration); this only adds a column.
ALTER TABLE "SimPosition" ADD COLUMN     "entryAtrPct" DOUBLE PRECISION;
