-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "clerkInvitationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleStock" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,

    CONSTRAINT "ArticleStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sentiment" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "summary" TEXT,
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "avgArticleAgeHours" DOUBLE PRECISION,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sentiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuantAnalysis" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "change1d" DOUBLE PRECISION,
    "change7d" DOUBLE PRECISION,
    "change30d" DOUBLE PRECISION,
    "rsi14" DOUBLE PRECISION,
    "sma20" DOUBLE PRECISION,
    "sma50" DOUBLE PRECISION,
    "volatility30d" DOUBLE PRECISION,
    "volumeRatio10d" DOUBLE PRECISION,
    "macdHistogram" DOUBLE PRECISION,
    "priceVs60dHigh" DOUBLE PRECISION,
    "priceVs60dLow" DOUBLE PRECISION,
    "relativeStr7d" DOUBLE PRECISION,
    "score" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuantAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockEstimate" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "sentimentScore" DOUBLE PRECISION NOT NULL,
    "quantScore" DOUBLE PRECISION,
    "combinedScore" DOUBLE PRECISION NOT NULL,
    "signal" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "dataWarnings" TEXT[],
    "sentimentDelta" DOUBLE PRECISION,
    "articleVelocityRatio" DOUBLE PRECISION,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,

    CONSTRAINT "UserStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMarket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,

    CONSTRAINT "UserMarket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_email_key" ON "Invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_acceptedByUserId_key" ON "Invitation"("acceptedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_clerkInvitationId_key" ON "Invitation"("clerkInvitationId");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Market_name_key" ON "Market"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_ticker_key" ON "Stock"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "Article_url_key" ON "Article"("url");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleStock_articleId_stockId_key" ON "ArticleStock"("articleId", "stockId");

-- CreateIndex
CREATE INDEX "Sentiment_stockId_date_idx" ON "Sentiment"("stockId", "date");

-- CreateIndex
CREATE INDEX "QuantAnalysis_stockId_date_idx" ON "QuantAnalysis"("stockId", "date");

-- CreateIndex
CREATE INDEX "StockEstimate_stockId_date_idx" ON "StockEstimate"("stockId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "UserStock_userId_stockId_key" ON "UserStock"("userId", "stockId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMarket_userId_marketId_key" ON "UserMarket"("userId", "marketId");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleStock" ADD CONSTRAINT "ArticleStock_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleStock" ADD CONSTRAINT "ArticleStock_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sentiment" ADD CONSTRAINT "Sentiment_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuantAnalysis" ADD CONSTRAINT "QuantAnalysis_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockEstimate" ADD CONSTRAINT "StockEstimate_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStock" ADD CONSTRAINT "UserStock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStock" ADD CONSTRAINT "UserStock_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMarket" ADD CONSTRAINT "UserMarket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMarket" ADD CONSTRAINT "UserMarket_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
