-- Harden Row Level Security on all public tables.
--
-- Context: this app accesses Postgres exclusively through Prisma as the `postgres`
-- role (bypassrls = true, owns every table, force_rls = false), so NONE of these
-- statements affect the application's queries. Their sole purpose is to lock the
-- Supabase Data API (PostgREST) down so the `anon`/`authenticated` roles cannot
-- read or write these tables.
--
-- Previously, 10 tables carried a permissive `allow_all` policy
-- (USING (true) WITH CHECK (true) TO public), which made RLS effectively a no-op
-- and left every row — including User emails/roles — readable and writable via the
-- Data API. We drop those policies and ensure RLS is enabled everywhere. With RLS
-- enabled and no policy granting access, the Data API denies anon/authenticated by
-- default (deny-by-default).
--
-- Idempotent: ENABLE is a no-op where RLS is already on; DROP ... IF EXISTS is a
-- no-op where the policy is absent. Safe to apply to any environment (incl. prod).

-- 1) Drop the wide-open allow_all policies.
DROP POLICY IF EXISTS "allow_all" ON "Alert";
DROP POLICY IF EXISTS "allow_all" ON "Article";
DROP POLICY IF EXISTS "allow_all" ON "ArticleStock";
DROP POLICY IF EXISTS "allow_all" ON "EtfProfile";
DROP POLICY IF EXISTS "allow_all" ON "Market";
DROP POLICY IF EXISTS "allow_all" ON "Sentiment";
DROP POLICY IF EXISTS "allow_all" ON "Stock";
DROP POLICY IF EXISTS "allow_all" ON "User";
DROP POLICY IF EXISTS "allow_all" ON "UserMarket";
DROP POLICY IF EXISTS "allow_all" ON "UserStock";

-- 2) Ensure RLS is enabled on every application table (deny-by-default for the Data API).
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Market" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Stock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Article" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArticleStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sentiment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuantAnalysis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockEstimate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EtfProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsiderTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsiderSummary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserMarket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
