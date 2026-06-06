-- CreateIndex
CREATE INDEX "ArticleStock_stockId_idx" ON "ArticleStock"("stockId");

-- CreateIndex
CREATE INDEX "Invitation_invitedById_idx" ON "Invitation"("invitedById");

-- CreateIndex
CREATE INDEX "Stock_marketId_idx" ON "Stock"("marketId");

-- CreateIndex
CREATE INDEX "UserMarket_marketId_idx" ON "UserMarket"("marketId");

-- CreateIndex
CREATE INDEX "UserStock_stockId_idx" ON "UserStock"("stockId");
