-- CreateTable
CREATE TABLE "CongressTrade" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "politician" TEXT NOT NULL,
    "party" TEXT,
    "state" TEXT,
    "owner" TEXT,
    "txnType" TEXT NOT NULL,
    "amountRange" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "disclosureDate" TIMESTAMP(3) NOT NULL,
    "ptrLink" TEXT,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CongressTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CongressTrade_dedupKey_key" ON "CongressTrade"("dedupKey");

-- CreateIndex
CREATE INDEX "CongressTrade_stockId_transactionDate_idx" ON "CongressTrade"("stockId", "transactionDate");

-- AddForeignKey
ALTER TABLE "CongressTrade" ADD CONSTRAINT "CongressTrade_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security with no policies: this app reaches Postgres only as
-- the `postgres` role (bypassrls), so RLS never affects Prisma's queries. Its
-- sole purpose is to deny the Supabase Data API (anon/authenticated) by default,
-- matching every other table (see 20260606190323_harden_rls_policies). Done inline
-- here so the table is never briefly exposed via the Data API.
ALTER TABLE "CongressTrade" ENABLE ROW LEVEL SECURITY;
