import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// One-off repair for the four CRWD positions whose holding period crossed the
// 2026-07 4:1 split (OPEN-FINDINGS.md, "CRWD's 4:1 split corrupts four closed
// positions"). Entry was recorded at the raw pre-split price and the exit at the
// post-split price, booking ~-71% "losses" on holds that actually gained ~14%.
//
// The repair puts the whole row on the post-split basis: qty x4, entryPrice /4,
// peakPrice /4 (it was recorded pre-split), realizedPnl recomputed from the
// repaired legs. Deliberately narrow: it targets ONLY rows matching the known
// four (CRWD, CLOSED, pre-split entry > $500, exit in the first post-split week)
// and refuses to run if it matches anything else. PaperEquitySnapshot history is
// NOT rewritten — the daily equity series keeps the artifact and the register
// notes it.
//
// Usage: npx tsx scripts/repair-crwd-split.ts [--dry-run]

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const SPLIT = 4;

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const rows = await prisma.simPosition.findMany({
    where: {
      status: "CLOSED",
      stock: { ticker: "CRWD" },
      entryPrice: { gt: 500 },
      exitDate: { gte: new Date("2026-07-03T00:00:00Z"), lt: new Date("2026-07-11T00:00:00Z") },
    },
    select: { id: true, strategy: true, qty: true, entryPrice: true, exitPrice: true, peakPrice: true, realizedPnl: true },
  });

  if (rows.length !== 4) {
    throw new Error(`expected exactly the 4 known rows, matched ${rows.length} — refusing to touch anything`);
  }

  for (const r of rows) {
    const qty = r.qty * SPLIT;
    const entryPrice = r.entryPrice / SPLIT;
    const peakPrice = r.peakPrice != null ? r.peakPrice / SPLIT : null;
    const realizedPnl = qty * (r.exitPrice! - entryPrice);
    console.log(
      `${r.strategy.padEnd(13)} qty ${r.qty.toFixed(3)}→${qty.toFixed(3)}  entry ${r.entryPrice}→${entryPrice.toFixed(4)}  ` +
        `peak ${r.peakPrice}→${peakPrice?.toFixed(4) ?? "-"}  pnl ${r.realizedPnl?.toFixed(2)}→${realizedPnl.toFixed(2)}`
    );
    if (!dryRun) {
      await prisma.simPosition.update({ where: { id: r.id }, data: { qty, entryPrice, peakPrice, realizedPnl } });
    }
  }
  console.log(dryRun ? "\n--dry-run: nothing written" : "\n4 rows repaired");
}

main().finally(() => prisma.$disconnect());
