-- CreateIndex
-- Supports the global "latest sentiment" lookup (dashboard layout does a
-- findFirst ordered by date desc with no stockId filter, which the existing
-- [stockId, date] index cannot serve). No RLS change: index only.
CREATE INDEX "Sentiment_date_idx" ON "Sentiment"("date");
