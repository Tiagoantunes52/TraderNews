// The factual brief a proposing agent is handed before it writes a hypothesis.
//
// Deterministic and pure, for the same reason `pick-finding.ts` is: the agent's judgement
// should be spent on the hypothesis, not on re-deriving what has already been tried, and
// a number in a prompt must come from the same code that prints it in the report rather
// than from a model's recollection of a file it read.
//
// The brief's job is mostly to make ABSTAINING easy. A proposer that produces a candidate
// every week is not doing research, it is widening the search — and because `k` rises with
// every specification, the bar its own next proposal has to clear rises with it. The
// arithmetic is in the brief so the agent can see what a marginal candidate costs.

import { effectiveK, noiseFloorFor, type Ledger } from "@/lib/research-ledger";

export type RegisteredCandidate = { id: string; hypothesis: string; control?: boolean };

/** What one more specification would do to the bar every future result must clear. */
export function marginalCost(k: number): { current: number; next: number } {
  return { current: noiseFloorFor(k), next: noiseFloorFor(k + 1) };
}

export function buildResearchBrief(args: { ledger: Ledger; registered: RegisteredCandidate[]; today: string }): string {
  const { ledger, registered, today } = args;
  const k = effectiveK(ledger, "candidate");
  const cost = marginalCost(k);
  const L: string[] = [];

  L.push(`# Research brief — ${today}`);
  L.push("");
  L.push("## The bar");
  L.push("");
  L.push(
    `${k} candidate specifications have been judged against this corpus. A best-of-${k} result needs ` +
      `|t| > ${cost.current.toFixed(2)} to mean anything. One more specification moves that to ` +
      `${cost.next.toFixed(2)}.`
  );
  L.push("");
  L.push(
    "Read that as a price, not a formality. Every candidate you add raises the bar for every " +
      "candidate that comes after it, including the one that might have worked. Nothing in this " +
      "corpus has ever cleared |t| 3 out of sample."
  );
  L.push("");

  L.push("## Already tried");
  L.push("");
  const bySpecId = new Map<string, { specs: number; runs: number; verdicts: Set<string> }>();
  for (const e of ledger.entries) {
    if (e.kind !== "candidate") continue;
    const acc = bySpecId.get(e.id) ?? { specs: 0, runs: 0, verdicts: new Set<string>() };
    acc.specs++;
    acc.runs += e.runs;
    acc.verdicts.add(e.lastVerdict);
    bySpecId.set(e.id, acc);
  }
  if (bySpecId.size === 0) {
    L.push("Nothing yet — this is the first specification against this corpus.");
  } else {
    L.push("| id | specs | runs | last verdicts | hypothesis |");
    L.push("|---|---|---|---|---|");
    for (const [id, acc] of [...bySpecId.entries()].sort()) {
      const reg = registered.find((r) => r.id === id);
      const label = reg?.control ? "(control) " : "";
      L.push(
        `| \`${id}\` | ${acc.specs} | ${acc.runs} | ${[...acc.verdicts].sort().join(", ")} | ` +
          `${label}${reg?.hypothesis ?? "— not in the current variants file —"} |`
      );
    }
  }
  L.push("");

  L.push("## What you may do");
  L.push("");
  L.push("Exactly one of:");
  L.push("");
  L.push(
    "1. **Abstain.** Write `ABSTAIN: <one sentence>` and change no files. This is the correct " +
      "answer whenever no new evidence has arrived since the last proposal, and whenever the best " +
      "idea available is a re-skin of something in the table above. Abstaining costs nothing; a " +
      "weak candidate costs everyone who comes after you."
  );
  L.push(
    "2. **Propose one candidate.** Append a single entry to `src/lib/signal-research-variants.ts` " +
      "with a one-sentence `hypothesis` and a pure `score(f: ScoreInput) => number | null`."
  );
  L.push("");
  L.push("## Hard constraints");
  L.push("");
  L.push("- `score` is a pure function of `ScoreInput`. It reads no database, no clock, no globals.");
  L.push(
    "- `ScoreInput` omits `forward`, `forwardExec` and `fillPrice` because those are the answers. " +
      "Never set the `oracle` flag — it exists for the plumbing control alone."
  );
  L.push("- Never set `control: true` on a hypothesis.");
  L.push("- One candidate. Not two, not a family, not a parameter sweep — a sweep is one `k` per setting.");
  L.push("- Do not edit any file under `src/lib/pipeline/`, `paper-trading.ts`, or anything the app trades on.");
  L.push("- Do not edit `research-ledger.json` by hand. The harness writes it.");
  L.push("");
  L.push(
    "Your hypothesis must say what mechanism you expect and why it would survive out of sample. " +
      "\"It scored well in the training period\" is what the holdout exists to reject."
  );
  return L.join("\n");
}
