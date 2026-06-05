-- CreateTable
CREATE TABLE "InsiderTransaction" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "insiderName" TEXT NOT NULL,
    "transactionCode" TEXT NOT NULL,
    "txnType" TEXT NOT NULL,
    "isPlanned" BOOLEAN NOT NULL DEFAULT false,
    "isDerivative" BOOLEAN NOT NULL DEFAULT false,
    "shares" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION,
    "value" DOUBLE PRECISION,
    "sharesAfter" DOUBLE PRECISION,
    "pctHoldingsChg" DOUBLE PRECISION,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "filingDate" TIMESTAMP(3) NOT NULL,
    "accessionId" TEXT,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsiderTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsiderSummary" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "buyCount90d" INTEGER NOT NULL DEFAULT 0,
    "sellCount90d" INTEGER NOT NULL DEFAULT 0,
    "distinctBuyers90d" INTEGER NOT NULL DEFAULT 0,
    "distinctSellers90d" INTEGER NOT NULL DEFAULT 0,
    "netShares90d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netValue90d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "buyValue90d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sellValue90d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "distinctBuyers14d" INTEGER NOT NULL DEFAULT 0,
    "mspr" DOUBLE PRECISION,
    "convictionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "signals" JSONB,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsiderSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsiderTransaction_dedupKey_key" ON "InsiderTransaction"("dedupKey");

-- CreateIndex
CREATE INDEX "InsiderTransaction_stockId_transactionDate_idx" ON "InsiderTransaction"("stockId", "transactionDate");

-- CreateIndex
CREATE INDEX "InsiderTransaction_stockId_filingDate_idx" ON "InsiderTransaction"("stockId", "filingDate");

-- CreateIndex
CREATE INDEX "InsiderSummary_stockId_date_idx" ON "InsiderSummary"("stockId", "date");

-- AddForeignKey
ALTER TABLE "InsiderTransaction" ADD CONSTRAINT "InsiderTransaction_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsiderSummary" ADD CONSTRAINT "InsiderSummary_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
