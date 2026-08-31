import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildFeatures, type Bar } from "../src/lib/signal-research";

// Build the research feature cache over HTTP, with no database credential.
//
// A SCRIPT, not a stage. `scripts/signal-research.ts` builds the same table straight from
// `PriceBar` when it can reach the database; this fetches the bars from
// `GET /api/reports/price-bars` instead, so a scheduled runner needs only the pipeline
// secret it already holds rather than `DIRECT_URL`, which is full-privilege Postgres.
//
// The corpus is append-only history keyed by date, so it walks a year at a time: stable,
// resumable chunks with no cursor state, and each response stays a size a function should
// be asked to return.
//
// Usage (APP_URL + PIPELINE_SECRET from the environment):
//   npx tsx scripts/fetch-corpus.ts
//   npx tsx scripts/fetch-corpus.ts --out=.cache/signal-research-features.json

const CACHE_PATH = ".cache/signal-research-features.json";

type BoundsResponse = { from: string; to: string; maxWindowDays: number };
type BarsResponse = { from: string; to: string; count: number; bars: Bar[] };

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="));
const OUT = outArg ? outArg.slice(6) : CACHE_PATH;

const APP_URL = process.env.APP_URL?.replace(/\/$/, "");
const SECRET = process.env.PIPELINE_SECRET;
if (!APP_URL || !SECRET) {
  console.error("APP_URL and PIPELINE_SECRET are required (this script deliberately has no database access)");
  process.exit(2);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${APP_URL}${path}`, {
    headers: { "x-pipeline-secret": SECRET!, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Calendar years covering [from, to], each safely inside the endpoint's window cap. */
function yearWindows(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    out.push({ from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return out;
}

async function main() {
  const bounds = await get<BoundsResponse>("/api/reports/price-bars?bounds=1");
  console.error(`corpus: ${bounds.from} → ${bounds.to}`);

  const bars: Bar[] = [];
  for (const w of yearWindows(bounds.from, bounds.to)) {
    const chunk = await get<BarsResponse>(`/api/reports/price-bars?from=${w.from}&to=${w.to}`);
    bars.push(...chunk.bars);
    console.error(`  ${w.from.slice(0, 4)}: ${chunk.count.toLocaleString()} bars`);
  }
  if (bars.length === 0) {
    console.error("No bars returned — is PriceBar populated?");
    process.exit(1);
  }

  // The endpoint orders within a window, and the windows are walked in order, so the
  // concatenation is already ascending — but `buildFeatures` depends on that ordering
  // for its warm-up, so it is asserted rather than assumed.
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].session < bars[i - 1].session) {
      console.error(`Bars are out of order at index ${i} (${bars[i - 1].session} → ${bars[i].session})`);
      process.exit(1);
    }
  }

  console.error(`  ${bars.length.toLocaleString()} bars → computing indicators…`);
  const features = buildFeatures(bars);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(features));
  console.error(`  ${features.length.toLocaleString()} feature rows cached at ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
