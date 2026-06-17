-- AlterTable
-- Risk-managed (_RM) overlay state for SimPosition. Nullable / defaulted so the
-- existing pure-book rows backfill cleanly and keep their signal-only behavior.
-- No RLS change needed: SimPosition already has RLS enabled (see the
-- 20260615135738_add_paper_trading migration); this only adds columns.
ALTER TABLE "SimPosition" ADD COLUMN     "bearishStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "peakPrice" DOUBLE PRECISION;
