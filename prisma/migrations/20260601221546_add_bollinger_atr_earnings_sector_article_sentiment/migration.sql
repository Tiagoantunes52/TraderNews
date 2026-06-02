-- AlterTable
ALTER TABLE "ArticleStock" ADD COLUMN     "sentimentScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QuantAnalysis" ADD COLUMN     "atr14" DOUBLE PRECISION,
ADD COLUMN     "atrPct" DOUBLE PRECISION,
ADD COLUMN     "bollingerPctB" DOUBLE PRECISION,
ADD COLUMN     "bollingerWidth" DOUBLE PRECISION,
ADD COLUMN     "daysToEarnings" INTEGER,
ADD COLUMN     "nextEarningsDate" TIMESTAMP(3),
ADD COLUMN     "relativeStrSector7d" DOUBLE PRECISION;
