import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// One-off repair for the sessionDate rows nulled by the Tiingo date defect
// (OPEN-FINDINGS.md, "The Tiingo date defect, 2026-08-24").
//
// From 2026-07-31 (the feature's first live day) until the adapter fix, every
// Tiingo-served name wrote sessionDate = NULL. The prices themselves were fine, so
// the session each row describes is recoverable the same way the original
// migration (20260730160000_add_quant_session_date) recovered history: match the
// stored close against PriceBar in the seven days strictly before the write day
// (unique matches only), then promote per-row matches to a per-run-day consensus
// and require unanimity. A run day whose evidence disagrees stays NULL for a human.
//
// Differences from the migration, both deliberate:
//   - restricted to sessionDate IS NULL and write day >= 2026-07-31 (never touches
//     a populated value);
//   - the US-calendar guard is explicit (no dot, no -USD) instead of riding on
//     "has bars": BTC-USD has bars but trades weekends, and borrowing a US run's
//     session for it would be fabrication.
//
// Run AFTER backfill-price-bars.ts — the vote needs the bars.
//
// Usage: npx tsx scripts/repair-session-dates.ts [--dry-run]

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const FROM = "2026-07-31";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const before = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) n from "QuantAnalysis" where "sessionDate" is null and "date" >= ${FROM}::timestamp`;
  console.log(`null sessionDate rows since ${FROM}: ${before[0].n}`);

  const consensus = await prisma.$queryRaw<{ run_day: Date; session_date: Date; votes: bigint }[]>`
    with vote as (
      select q.id,
             date_trunc('day', q."date") as run_day,
             b."date" as session_date,
             count(*) over (partition by q.id) as match_count
      from "QuantAnalysis" q
      join "Stock" s on s.id = q."stockId"
      join "PriceBar" b
        on b."stockId" = q."stockId"
       and b."date" >= date_trunc('day', q."date") - interval '7 days'
       and b."date" <  date_trunc('day', q."date")
       and abs(b."close" - q."price") <= 1e-6 * greatest(abs(b."close"), 1)
      where q."price" is not null
        and q."sessionDate" is null
        and q."date" >= ${FROM}::timestamp
        and s.ticker not like '%.%'
        and s.ticker not like '%-USD'
    )
    select run_day, min(session_date) as session_date, count(*) as votes
    from vote where match_count = 1
    group by run_day
    having count(distinct session_date) = 1
    order by run_day`;
  console.log(`\nrun-day consensus (${consensus.length} days):`);
  for (const c of consensus)
    console.log(
      `  ${c.run_day.toISOString().slice(0, 10)} → session ${c.session_date.toISOString().slice(0, 10)}  (${c.votes} votes)`
    );

  if (dryRun) {
    console.log("\n--dry-run: no rows updated");
    return;
  }

  const updated = await prisma.$executeRaw`
    with vote as (
      select q.id,
             date_trunc('day', q."date") as run_day,
             b."date" as session_date,
             count(*) over (partition by q.id) as match_count
      from "QuantAnalysis" q
      join "Stock" s on s.id = q."stockId"
      join "PriceBar" b
        on b."stockId" = q."stockId"
       and b."date" >= date_trunc('day', q."date") - interval '7 days'
       and b."date" <  date_trunc('day', q."date")
       and abs(b."close" - q."price") <= 1e-6 * greatest(abs(b."close"), 1)
      where q."price" is not null
        and q."sessionDate" is null
        and q."date" >= ${FROM}::timestamp
        and s.ticker not like '%.%'
        and s.ticker not like '%-USD'
    ),
    run_session as (
      select run_day, min(session_date) as session_date
      from vote where match_count = 1
      group by run_day
      having count(distinct session_date) = 1
    )
    update "QuantAnalysis" q
    set "sessionDate" = r.session_date
    from run_session r, "Stock" s
    where s.id = q."stockId"
      and q."sessionDate" is null
      and q."date" >= ${FROM}::timestamp
      and date_trunc('day', q."date") = r.run_day
      and s.ticker not like '%.%'
      and s.ticker not like '%-USD'
      and exists (select 1 from "PriceBar" pb where pb."stockId" = q."stockId")`;
  console.log(`\nupdated rows: ${updated}`);

  const after = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) n from "QuantAnalysis" where "sessionDate" is null and "date" >= ${FROM}::timestamp`;
  console.log(`null sessionDate rows remaining since ${FROM}: ${after[0].n} (crypto + unresolvable days stay NULL by design)`);
}

main().finally(() => prisma.$disconnect());
