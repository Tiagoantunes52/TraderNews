-- Daily post-close self-audit (see model comments in schema.prisma).
--
-- Two parts:
--   1. SimPosition gains the trade's "why". reconcileRiskManaged already computed an
--      exit reason (STOP/TRAIL/SIGNAL/DECAY/TIME) and the paper stage discarded it —
--      it survived only for the live Alpaca book, stuffed into PaperOrder.signal. The
--      entry-side scores were likewise never snapshotted. Existing rows stay NULL
--      (unbackfillable) and the review reports them as pre-instrumentation.
--   2. DailyReview — one row per UTC trading day holding the paper stage's decision
--      log and the review stage's findings.

-- AlterTable
ALTER TABLE "SimPosition" ADD COLUMN     "entryScore" DOUBLE PRECISION,
ADD COLUMN     "entrySignal" TEXT,
ADD COLUMN     "exitReason" TEXT;

-- CreateTable
CREATE TABLE "DailyReview" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "paperRun" JSONB,
    "report" JSONB,
    "status" TEXT,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyReview_date_key" ON "DailyReview"("date");

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its
-- sole purpose is to deny the Supabase Data API (anon/authenticated) by default,
-- matching every other table (see 20260606190323_harden_rls_policies). Done inline
-- here so the table is never briefly exposed via the Data API.
ALTER TABLE "DailyReview" ENABLE ROW LEVEL SECURITY;
