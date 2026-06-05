-- AlterTable
ALTER TABLE "InsiderSummary" ADD COLUMN     "csuiteBuyValue14d" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InsiderTransaction" ADD COLUMN     "isDirector" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isOfficer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isTenPctOwner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "officerTitle" TEXT;
