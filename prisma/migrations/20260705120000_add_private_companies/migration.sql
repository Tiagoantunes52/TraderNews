-- CreateTable
CREATE TABLE "PrivateCompany" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateCompanyArticle" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateCompanyArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrivateCompany_slug_key" ON "PrivateCompany"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateCompanyArticle_companyId_url_key" ON "PrivateCompanyArticle"("companyId", "url");

-- CreateIndex
CREATE INDEX "PrivateCompanyArticle_companyId_publishedAt_idx" ON "PrivateCompanyArticle"("companyId", "publishedAt");

-- AddForeignKey
ALTER TABLE "PrivateCompanyArticle" ADD CONSTRAINT "PrivateCompanyArticle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "PrivateCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its
-- sole purpose is to deny the Supabase Data API (anon/authenticated) by default,
-- matching every other table (see 20260606190323_harden_rls_policies). Done inline
-- here so the tables are never briefly exposed via the Data API.
ALTER TABLE "PrivateCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrivateCompanyArticle" ENABLE ROW LEVEL SECURITY;
