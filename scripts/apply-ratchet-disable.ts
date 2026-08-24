import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseTradingOverrides, resolveTradingConfig, TRADING_CONFIG_KEY } from "../src/lib/trading-config";

// One-off: apply the 2026-08-24 ratchet disable as the first tradingConfig DB
// override (OPEN-FINDINGS.md, "ACTED ON 2026-08-24: the ratchet is disabled").
// Refuses to run if a tradingConfig row already exists with different content —
// this script documents ONE deliberate change, not a config editor (that is the
// admin page's job).

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const OVERRIDES = { trailRatchetFrac: 1 };

async function main() {
  const value = JSON.stringify(OVERRIDES);

  // Validate through the app's own parser before writing anything.
  const { overrides, issues } = parseTradingOverrides(value);
  if (issues.length > 0 || overrides.trailRatchetFrac !== 1) {
    throw new Error(`refusing to write an override the app would drop: ${issues.join("; ") || "unexpected parse result"}`);
  }

  const existing = await prisma.appSetting.findUnique({ where: { key: TRADING_CONFIG_KEY } });
  if (existing && existing.value !== value) {
    throw new Error(`tradingConfig already exists with different content: ${existing.value} — not overwriting`);
  }

  await prisma.appSetting.upsert({
    where: { key: TRADING_CONFIG_KEY },
    create: { key: TRADING_CONFIG_KEY, value },
    update: { value },
  });

  const row = await prisma.appSetting.findUnique({ where: { key: TRADING_CONFIG_KEY } });
  console.log(`tradingConfig row: ${row?.value} (updatedAt ${row?.updatedAt.toISOString()})`);

  const resolved = resolveTradingConfig(parseTradingOverrides(row?.value).overrides);
  console.log(
    `resolved: trailRatchetFrac=${resolved.risk.trailRatchetFrac} ` +
      `trailRatchetActivatePct=${resolved.risk.trailRatchetActivatePct} trailPct=${resolved.risk.trailPct} ` +
      `(issues: ${resolved.issues.length === 0 ? "none" : resolved.issues.join("; ")})`
  );
}

main().finally(() => prisma.$disconnect());
