// Filesystem layer for the research ledger, the same way `signal-research-data.ts` sits
// under the pure `signal-research.ts`. All the judgement lives in `research-ledger.ts`;
// this file only reads and writes.
//
// The ledger is a COMMITTED file, deliberately. Its accountability is that a pull request
// adding a candidate also shows the ledger row it created — a search that widened in a
// diff a human reads, rather than a counter in a database nobody looks at.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { EMPTY_LEDGER, parseLedger, serializeLedger, type Ledger } from "@/lib/research-ledger";

/** Repo root, next to OPEN-FINDINGS.md — both are records that outlive the session. */
export const LEDGER_PATH = "research-ledger.json";

export function readLedger(path = LEDGER_PATH): Ledger {
  if (!existsSync(path)) return EMPTY_LEDGER;
  return parseLedger(readFileSync(path, "utf8"));
}

export function writeLedger(ledger: Ledger, path = LEDGER_PATH): void {
  writeFileSync(path, serializeLedger(ledger));
}
