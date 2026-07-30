-- Daily OHLCV bars (see the model comment in schema.prisma).
--
-- The quant stage fetches a 60-day price window every run and discards it once the
-- indicators are computed, so the only price history this app owns is
-- QuantAnalysis.price: one close per stock per day, starting the day the app first
-- ran (2026-05-18). Two things that history structurally cannot do:
--
--   1. Answer "would this order have filled?". A marketable limit order's fate is
--      decided by the NEXT bar's open and low; a stop's fill is decided by whether the
--      bar gapped through the level or traded down to it. None of open/high/low was
--      ever kept, so every evaluation the app can currently perform silently assumes
--      each intended trade filled at the close — the same assumption that made the sim
--      books' apparent edge unexecutable (see OPEN-FINDINGS.md).
--   2. Reach back before the app existed. The regime filter needs 200 SPY closes and
--      has ~52, so it has never once fired in production.
--
-- ~119 US names x 252 sessions x 5 years is ~150k rows (~25-30 MB including the PK
-- btree), growing ~30k rows/year. Cheap enough that keeping raw bars is strictly
-- better than continuing to throw them away.

-- CreateTable
CREATE TABLE "PriceBar" (
    "stockId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- (stockId, date) is the natural identity; no surrogate key. Also what makes
    -- backfill re-runs idempotent via INSERT ... ON CONFLICT DO NOTHING.
    CONSTRAINT "PriceBar_pkey" PRIMARY KEY ("stockId","date")
);

-- CreateIndex
-- IF NOT EXISTS: this database carries hand-made indexes created outside Prisma
-- (see 20260705110000_reconcile_manual_indexes), so index creation is written to be
-- safe against one already being present.
CREATE INDEX IF NOT EXISTS "PriceBar_date_idx" ON "PriceBar"("date");

-- AddForeignKey
ALTER TABLE "PriceBar" ADD CONSTRAINT "PriceBar_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security with no policies: this app reaches Postgres only as the
-- `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its sole purpose
-- is to deny the Supabase Data API (anon/authenticated) by default, matching every
-- other table (see 20260606190323_harden_rls_policies). Done inline here so the table
-- is never briefly exposed via the Data API.
ALTER TABLE "PriceBar" ENABLE ROW LEVEL SECURITY;
