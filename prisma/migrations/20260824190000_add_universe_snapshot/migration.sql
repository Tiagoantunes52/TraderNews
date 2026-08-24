-- UniverseSnapshot — point-in-time universe membership, one row per (UTC day, stock).
--
-- Every research study to date carries a survivorship caveat: the PriceBar backfill
-- projected TODAY'S watchlist onto five years of history, and nothing recorded who
-- was actually in the universe when a historical session traded. This table records
-- membership going forward — INTENT (the quant stage's worklist before any per-stock
-- work), not success, so a name whose price fetch fails on the day is still counted
-- as a member. It cannot repair the past; it stops the caveat growing.
--
-- Composite PK, date-leading: "who was in the universe on day D" is the only query.
-- No surrogate id, same reasoning as PriceBar; skipDuplicates makes the daily write
-- idempotent across the stage's multiple invocations per day.

-- CreateTable
CREATE TABLE "UniverseSnapshot" (
    "date" TIMESTAMP(3) NOT NULL,
    "stockId" TEXT NOT NULL,

    CONSTRAINT "UniverseSnapshot_pkey" PRIMARY KEY ("date", "stockId")
);

-- AddForeignKey
ALTER TABLE "UniverseSnapshot" ADD CONSTRAINT "UniverseSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS on with no policies: the app connects as postgres and bypasses RLS, so this
-- only closes the Supabase Data API off — the house rule for every new table.
ALTER TABLE "UniverseSnapshot" ENABLE ROW LEVEL SECURITY;
