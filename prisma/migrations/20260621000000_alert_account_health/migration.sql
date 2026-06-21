-- Account / trading-health alerts (issue #56) reuse the Alert table but carry no
-- ticker, so stockId becomes nullable. The existing FK (onDelete CASCADE) already
-- tolerates NULLs once the column is nullable — no constraint change needed.
ALTER TABLE "Alert" ALTER COLUMN "stockId" DROP NOT NULL;

-- Query account-health alerts (and any type) by recency without a stock filter.
CREATE INDEX "Alert_type_createdAt_idx" ON "Alert"("type", "createdAt");

-- RLS is unchanged: the Alert table already has RLS enabled with no policies (see
-- 20260606190323_harden_rls_policies). The app reaches Postgres as `postgres`
-- (bypassrls), so this only keeps the Supabase Data API denied by default.
