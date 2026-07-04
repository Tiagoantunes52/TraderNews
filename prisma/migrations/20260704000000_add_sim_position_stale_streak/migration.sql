-- AlterTable
-- Stale-signal streak for the _RM books' signal-decay exit (consecutive runs with
-- the score below the entry deadband). Defaulted to 0 so existing rows backfill
-- cleanly. No RLS change needed: SimPosition already has RLS enabled (see the
-- 20260615135738_add_paper_trading migration); this only adds a column.
ALTER TABLE "SimPosition" ADD COLUMN     "staleStreak" INTEGER NOT NULL DEFAULT 0;
