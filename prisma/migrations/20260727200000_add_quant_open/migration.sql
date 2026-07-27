-- Store the session open alongside the close.
--
-- No indicator reads it. It exists so the sim can eventually price an entry at the bar
-- the decision could actually have been acted on: a signal derived from a close can only
-- be executed at the NEXT open, so filling the sim at that same close measures an event
-- that never existed. Correcting that needs open-price history, and history has lead
-- time — hence recording it before the sim change that consumes it.
--
-- Nullable with no backfill: rows predating this have no open, and any consumer must
-- treat null as "not modellable" rather than substituting the close, which would
-- silently reintroduce the very assumption this exists to remove.

-- AlterTable
ALTER TABLE "QuantAnalysis" ADD COLUMN     "open" DOUBLE PRECISION;
