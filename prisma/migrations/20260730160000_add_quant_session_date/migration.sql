-- QuantAnalysis.sessionDate — the trading session a row actually describes.
--
-- `QuantAnalysis.date` defaults to now(), so it records when the row was WRITTEN, not
-- what it describes. The pipeline runs ~02:15-02:50 UTC, which means the newest
-- completed bar available to it belongs to the PREVIOUS session. A row stamped
-- 2026-07-29 therefore holds the close of 2026-07-28, and across a weekend the gap
-- widens to three days (four over a holiday Monday).
--
-- That offset is not recorded anywhere, so every "the numbers don't line up"
-- investigation has had to rediscover it, and at least one rediscovered it wrong.
-- Storing it removes the inference step: going forward the stage knows exactly which
-- bar it used, because it is holding that bar in memory when it writes the row.
--
-- Nullable on purpose. NULL means "unknown" and must never be read as "same as date" —
-- that substitution is precisely the confident-wrong-answer this column exists to
-- eliminate.

-- AlterTable
ALTER TABLE "QuantAnalysis" ADD COLUMN "sessionDate" TIMESTAMP(3);

-- Backfill historical rows from evidence, in two tiers.
--
-- Tier 1 (`vote`) matches a row's stored close against PriceBar exactly. The window is
-- the seven days BEFORE the write day: seven spans a holiday weekend, and the strict
-- upper bound encodes a fact about physics rather than a guess — a 02:20 UTC run cannot
-- have read a bar for a session that had not happened yet. (Allowing same-day matches
-- produced 12 rows across the corpus where a close simply repeated; excluding it
-- removed all 12 and left every run day unanimous.) Matches must be unique in the
-- window: two bars with the same close are no evidence at all.
--
-- Tier 2 promotes those per-row matches to a per-RUN answer. Which session a run read
-- is a property of the run, not of the ticker, so ~100 names agreeing on one date is far
-- stronger evidence than any single row — and it reaches rows tier 1 cannot, notably the
-- dividend payers whose stored close sits on a different adjustment basis than the bar
-- (PFE, COST, PG, CAT and friends: a constant per-name ratio, never a wrong session).
-- On the corpus at time of writing all 56 run days came back with exactly one distinct
-- session, on 6 to 105 votes, so `distinct_session_dates = 1` is enforced rather than
-- assumed: a run day whose evidence disagrees with itself is left NULL for a human.
--
-- Applied only to stocks that HAVE bars. That set is the US equities the backfill
-- covered, which share one exchange calendar — the assumption the consensus rests on.
-- BTC-USD trades weekends and .L/.LS/.MI keep European holidays, so borrowing a US
-- run's session for them would be fabrication. They stay NULL.
WITH vote AS (
  SELECT q.id,
         date_trunc('day', q."date") AS run_day,
         b."date" AS session_date,
         COUNT(*) OVER (PARTITION BY q.id) AS match_count
  FROM "QuantAnalysis" q
  JOIN "PriceBar" b
    ON b."stockId" = q."stockId"
   AND b."date" >= date_trunc('day', q."date") - INTERVAL '7 days'
   AND b."date" <  date_trunc('day', q."date")
   -- Relative tolerance: these are doubles that took two different code paths here.
   AND abs(b."close" - q."price") <= 1e-6 * greatest(abs(b."close"), 1)
  WHERE q."price" IS NOT NULL
),
run_session AS (
  SELECT run_day, min(session_date) AS session_date
  FROM vote
  WHERE match_count = 1
  GROUP BY run_day
  HAVING count(DISTINCT session_date) = 1
)
UPDATE "QuantAnalysis" q
SET "sessionDate" = r.session_date
FROM run_session r
WHERE date_trunc('day', q."date") = r.run_day
  AND EXISTS (SELECT 1 FROM "PriceBar" pb WHERE pb."stockId" = q."stockId");
