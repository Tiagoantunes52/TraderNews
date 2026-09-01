-- Capital actually at work, per book per day.
--
-- The performance cards measured a book's return against SIM_STARTING_EQUITY, a constant
-- from an env var that nothing in the sim reads: position sizing goes through
-- riskSizedNotional, which never asks what the book holds. So a book deploying a tenth of
-- that notional reported a tenth of the return its positions actually earned, and the
-- figure could be changed by editing PAPER_SIM_STARTING_EQUITY without changing a trade.
--
-- Recording deployed capital per snapshot makes the honest denominator available and
-- time-weighted: capital employed varied enormously (COMBINED_RM ran 36-82 concurrent
-- names at ~$40k before the 12-position cap landed on 2026-07-20, then ~$10k after), so
-- today's figure cannot stand in for the life of the book.
ALTER TABLE "PaperEquitySnapshot" ADD COLUMN "deployed" DOUBLE PRECISION;

-- Backfill from SimPosition. Compared at DATE granularity on purpose: a snapshot is
-- stamped at UTC midnight but written ~19:30 the same day, after that session's entries
-- and exits, so a position opened on the snapshot date is held at snapshot time and one
-- closed on it is not.
UPDATE "PaperEquitySnapshot" s
SET "deployed" = agg.dep
FROM (
  SELECT snap.id, COALESCE(SUM(p.qty * p."entryPrice"), 0) AS dep
  FROM "PaperEquitySnapshot" snap
  LEFT JOIN "SimPosition" p
    ON 'SIM_' || p.strategy = snap.book
   AND p."entryDate"::date <= snap.date::date
   AND (p."exitDate" IS NULL OR p."exitDate"::date > snap.date::date)
  WHERE snap.book <> 'ALPACA'
  GROUP BY snap.id
) agg
WHERE s.id = agg.id;
