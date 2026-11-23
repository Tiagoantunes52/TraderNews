-- A failed LLM call is the absence of a reading, not a NEUTRAL one.
--
-- Until this migration, lib/llm.ts turned an empty / unparseable / scoreless model reply
-- into score 0, confidence 0.1, and the sentiment stage stored it as a real Sentiment
-- row. Everything downstream read it as NEUTRAL: it fired DECAY and SIGNAL exits on held
-- names, kept names out of the entry band, and contaminated the signal research. See
-- OPEN-FINDINGS.md, "Failed LLM calls were stored as NEUTRAL reads" (2026-10-21).
--
-- New failures are written with "failed" = true and every reader skips them.

ALTER TABLE "Sentiment" ADD COLUMN "failed" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the old fallback is recognisable only by the fixed summary strings it wrote
-- (LEGACY_FALLBACK_SUMMARIES in lib/llm.ts). Measured 2026-10-21: 1,749 rows, from
-- 2026-06-23 to 2026-10-19 — 1,713 "Empty model response.", 29 "Could not parse model
-- response.", 7 "Model response missing a numeric score.". The prompt asks for a JSON
-- summary sentence, so a genuine read cannot produce one of these exact strings.
--
-- 17 of the 1,713 carry a non-zero score: the failed LLM leg was blended with Alpha
-- Vantage. They are marked failed too — the LLM read the row exists to record is the
-- part that is missing, and an AV-only score is not what any consumer thinks it reads.
--
-- This changes only which row the estimate stage treats as "latest". It does NOT rewrite
-- StockEstimate history: estimates already built from these rows keep the score they
-- traded on, which is the record of what actually happened.
UPDATE "Sentiment"
SET "failed" = true
WHERE "summary" IN (
  'Empty model response.',
  'Could not parse model response.',
  'Model response missing a numeric score.'
);
