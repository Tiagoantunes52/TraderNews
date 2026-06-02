-- CreateTable
CREATE TABLE "EtfProfile" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "netAssets" DOUBLE PRECISION,
    "expenseRatio" DOUBLE PRECISION,
    "dividendYield" DOUBLE PRECISION,
    "inceptionDate" TIMESTAMP(3),
    "sectors" JSONB,
    "holdings" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EtfProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EtfProfile_stockId_key" ON "EtfProfile"("stockId");

-- AddForeignKey
ALTER TABLE "EtfProfile" ADD CONSTRAINT "EtfProfile_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
