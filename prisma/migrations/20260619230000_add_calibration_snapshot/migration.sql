-- CreateTable
CREATE TABLE "CalibrationSnapshot" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "gateStatus" TEXT NOT NULL,
    "gatedBook" TEXT NOT NULL,
    "monthsCoverage" DOUBLE PRECISION NOT NULL,
    "closedTrades" INTEGER NOT NULL,
    "edgeMean" DOUBLE PRECISION,
    "edgeTStat" DOUBLE PRECISION,
    "alphaTStat" DOUBLE PRECISION,
    "combinedIc" DOUBLE PRECISION,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationSnapshot_date_key" ON "CalibrationSnapshot"("date");

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its sole
-- purpose is to deny the Supabase Data API (anon/authenticated) by default, matching
-- every other table (see 20260606190323_harden_rls_policies). Done inline here so
-- the table is never briefly exposed via the Data API.
ALTER TABLE "CalibrationSnapshot" ENABLE ROW LEVEL SECURITY;
