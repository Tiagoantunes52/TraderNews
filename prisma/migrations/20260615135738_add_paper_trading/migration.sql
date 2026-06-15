-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "notional" DOUBLE PRECISION,
    "qty" DOUBLE PRECISION,
    "alpacaOrderId" TEXT,
    "status" TEXT NOT NULL,
    "filledQty" DOUBLE PRECISION,
    "filledAvgPrice" DOUBLE PRECISION,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),

    CONSTRAINT "PaperOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimPosition" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "lastMarkDate" TIMESTAMP(3) NOT NULL,
    "lastMarkPrice" DOUBLE PRECISION,
    "exitDate" TIMESTAMP(3),
    "exitPrice" DOUBLE PRECISION,
    "realizedPnl" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperEquitySnapshot" (
    "id" TEXT NOT NULL,
    "book" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "equity" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openPositions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperEquitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaperOrder_alpacaOrderId_key" ON "PaperOrder"("alpacaOrderId");

-- CreateIndex
CREATE INDEX "PaperOrder_stockId_submittedAt_idx" ON "PaperOrder"("stockId", "submittedAt");

-- CreateIndex
CREATE INDEX "SimPosition_strategy_status_idx" ON "SimPosition"("strategy", "status");

-- CreateIndex
CREATE INDEX "SimPosition_stockId_strategy_idx" ON "SimPosition"("stockId", "strategy");

-- CreateIndex
CREATE UNIQUE INDEX "PaperEquitySnapshot_book_date_key" ON "PaperEquitySnapshot"("book", "date");

-- AddForeignKey
ALTER TABLE "PaperOrder" ADD CONSTRAINT "PaperOrder_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimPosition" ADD CONSTRAINT "SimPosition_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its
-- sole purpose is to deny the Supabase Data API (anon/authenticated) by default,
-- matching every other table (see 20260606190323_harden_rls_policies). Done inline
-- here so the tables are never briefly exposed via the Data API.
ALTER TABLE "PaperOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SimPosition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaperEquitySnapshot" ENABLE ROW LEVEL SECURITY;
