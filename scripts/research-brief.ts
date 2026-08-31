import "dotenv/config";
import { writeFileSync } from "node:fs";
import { buildResearchBrief } from "../src/lib/research-brief";
import { readLedger } from "../src/lib/research-ledger-io";
import { ALL_CANDIDATES } from "../src/lib/signal-research-variants";

// What has already been tried, and what one more attempt costs.
//
// A SCRIPT, not a stage. Prints the brief a proposing agent reads before it writes a
// hypothesis (see .github/workflows/research.yml); safe and useful to run by hand before
// writing one yourself. Reads the ledger and the variants file, nothing else.
//
// Usage:
//   npx tsx scripts/research-brief.ts
//   npx tsx scripts/research-brief.ts --out=brief.md

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="));
const brief = buildResearchBrief({
  ledger: readLedger(),
  registered: ALL_CANDIDATES.map((c) => ({ id: c.id, hypothesis: c.hypothesis, control: c.control })),
  today: new Date().toISOString().slice(0, 10),
});

if (outArg) writeFileSync(outArg.slice(6), `${brief}\n`);
else console.log(brief);
