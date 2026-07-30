import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildFeatures,
  evaluate,
  formatReport,
  controlsOk,
  HORIZONS,
  type Bar,
  type FeatureRow,
  type Horizon,
  type CandidateReport,
} from "../src/lib/signal-research";
import { ALL_CANDIDATES } from "../src/lib/signal-research-variants";

// Does a candidate score rank names correctly, out of sample?
//
// A SCRIPT, not a stage: it reads years of history and answers a research question, and
// nothing it prints changes how anything trades. See `signal-research.ts` for what this
// can and cannot support — in particular, it models no fills, so it cannot say a change
// makes money.
//
// Usage:
//   npx tsx scripts/signal-research.ts
//   npx tsx scripts/signal-research.ts --split=2025-01-01 --folds=4 --horizon=5
//   npx tsx scripts/signal-research.ts --candidates=baseline,h1-momentum-horizon
//   npx tsx scripts/signal-research.ts --rebuild-cache
//   npx tsx scripts/signal-research.ts --json

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

// Building features over ~120k stock-days takes minutes; scoring a candidate against a
// built table takes seconds. Cache the table so iterating on hypotheses is instant —
// iteration speed is the whole point of having this as a tool rather than a script.
const CACHE_PATH = ".cache/signal-research-features.json";
const DEFAULT_SPLIT = "2025-01-01";
const DEFAULT_FOLDS = 4;

function parseArgs(argv: string[]) {
  let split = DEFAULT_SPLIT;
  let folds = DEFAULT_FOLDS;
  let horizon: Horizon = 5;
  let only: string[] | null = null;
  let rebuild = false;
  let json = false;
  for (const a of argv) {
    if (a === "--rebuild-cache") rebuild = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--split=")) split = a.slice(8);
    else if (a.startsWith("--folds=")) folds = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith("--horizon=")) {
      const h = Number(a.slice(10));
      if (!HORIZONS.includes(h as Horizon)) {
        console.error(`--horizon must be one of ${HORIZONS.join(", ")}`);
        process.exit(2);
      }
      horizon = h as Horizon;
    } else if (a.startsWith("--candidates=")) only = a.slice(13).split(",").filter(Boolean);
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(split)) {
    console.error(`--split must be YYYY-MM-DD, got: ${split}`);
    process.exit(2);
  }
  return { split, folds, horizon, only, rebuild, json };
}

async function loadFeatures(rebuild: boolean): Promise<FeatureRow[]> {
  if (!rebuild && existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as FeatureRow[];
    console.error(`features: ${cached.length.toLocaleString()} rows from cache (--rebuild-cache to refresh)`);
    return cached;
  }
  console.error("features: building from PriceBar…");
  const rows = await prisma.priceBar.findMany({
    select: {
      stockId: true, date: true, open: true, high: true, low: true, close: true, volume: true,
      stock: { select: { ticker: true } },
    },
    orderBy: { date: "asc" },
  });
  const bars: Bar[] = rows.map((r) => ({
    stockId: r.stockId,
    ticker: r.stock.ticker,
    session: r.date.toISOString().slice(0, 10),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  console.error(`  ${bars.length.toLocaleString()} bars → computing indicators…`);
  const features = buildFeatures(bars);
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(features));
  console.error(`  ${features.length.toLocaleString()} feature rows cached at ${CACHE_PATH}`);
  return features;
}

async function main() {
  const { split, folds, horizon, only, rebuild, json } = parseArgs(process.argv.slice(2));
  const features = await loadFeatures(rebuild);
  if (features.length === 0) {
    console.error("No feature rows — is PriceBar populated? (npm run backfill-price-bars)");
    process.exit(1);
  }

  // The controls always run, even when --candidates narrows the sweep: a hypothesis
  // read off an unverified harness is worth nothing, which is the entire lesson this
  // tool exists to institutionalise.
  const selected = ALL_CANDIDATES.filter((c) => !only || only.includes(c.id) || c.control);
  const unknown = (only ?? []).filter((id) => !ALL_CANDIDATES.some((c) => c.id === id));
  if (unknown.length) {
    console.error(`Unknown candidate(s): ${unknown.join(", ")}`);
    console.error(`Known: ${ALL_CANDIDATES.map((c) => c.id).join(", ")}`);
    process.exit(2);
  }

  const reports: CandidateReport[] = selected.map((c) => evaluate(features, c, { splitDate: split, folds, horizon }));

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(formatReport(reports, reports.filter((r) => r.verdict !== "CONTROL").length));
  }

  // Non-zero when the harness itself failed its controls — so this is usable in a
  // pipeline and a broken instrument cannot be mistaken for a null result.
  process.exit(controlsOk(reports).ok ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
