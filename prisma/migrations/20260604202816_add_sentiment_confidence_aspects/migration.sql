-- AlterTable
ALTER TABLE "Sentiment" ADD COLUMN     "aspects" JSONB,
ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "keyDriver" TEXT;
