-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertEmails" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_stockId_createdAt_idx" ON "Alert"("stockId", "createdAt");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
