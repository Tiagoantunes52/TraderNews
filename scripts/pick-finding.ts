// CLI glue around src/lib/pick-finding.ts for the improve workflow (.github/workflows/improve.yml).
//
// Reads a daily-review report (from --report <path> or stdin), and the codes already
// covered by an open/recent auto-improve PR (from --handled "CODE1,CODE2"). Prints the
// chosen finding as one line of JSON to stdout, or the literal "none" when there's
// nothing actionable. All I/O lives here; the selection logic is pure and unit-tested.
//
//   npx tsx scripts/pick-finding.ts --report report.json --handled "MISSED_EXIT,NO_QUANT"
//   cat report.json | npx tsx scripts/pick-finding.ts --handled ""

import { readFileSync } from "node:fs";
import { pickFinding } from "../src/lib/pick-finding";
import { type DailyReviewReport } from "../src/lib/daily-review";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readReport(): DailyReviewReport {
  const path = argValue("--report");
  const raw = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed == null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    throw new Error("report JSON has no findings array (is this a daily-review report?)");
  }
  return parsed as DailyReviewReport;
}

function main() {
  const report = readReport();
  const handled = (argValue("--handled") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const chosen = pickFinding(report.findings, handled);
  // stdout carries the machine result; diagnostics go to stderr so callers can
  // capture stdout cleanly.
  if (!chosen) {
    process.stderr.write(`no actionable finding (${report.findings.length} total, ${handled.length} handled)\n`);
    console.log("none");
    return;
  }
  process.stderr.write(`picked ${chosen.severity.toUpperCase()} ${chosen.code}\n`);
  console.log(JSON.stringify(chosen));
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
