-- CreateIndex
-- Reconcile indexes that were added manually on the production DB (outside
-- Prisma) into the migration history, so the schema matches the database and
-- fresh environments get them too. IF NOT EXISTS makes both a no-op on prod.
-- No RLS change: indexes only.
CREATE INDEX IF NOT EXISTS "Article_headline_idx" ON "Article"("headline");
CREATE INDEX IF NOT EXISTS "ArticleStock_articleId_idx" ON "ArticleStock"("articleId");
