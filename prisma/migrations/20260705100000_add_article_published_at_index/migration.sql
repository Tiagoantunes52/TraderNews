-- CreateIndex
-- Supports the news feed's publishedAt-desc ordering/time-window filtering and
-- the estimate stage's 24h article-count window. No RLS change: index only.
-- IF NOT EXISTS: this index was already created manually on the production DB
-- (outside Prisma), so the migration must be a no-op there.
CREATE INDEX IF NOT EXISTS "Article_publishedAt_idx" ON "Article"("publishedAt");
