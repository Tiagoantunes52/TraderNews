import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  buildObservations,
  signalHealth,
  DEFAULT_HORIZON,
  MIN_ENTRY_OBSERVATIONS,
  MIN_SESSIONS,
  SIGNAL_SOURCES,
  type Observation,
  type SourceHealth,
} from "../src/lib/signal-health";
import { splitFixed, splitRolling } from "../src/lib/signal-research";

// Does a LIVE entry signal still pay, out of sample?
//
// `signal-health.ts` answers "how are the entry signals doing?" over one trailing
// window, as a monitor. When it prints something alarming, the finding's own advice is
// to "investigate with a train/test split, NOT to flip a weight" — and this is the
// script that does that, on the same rows the monitor reads.
//
// A SCRIPT, not a stage: nothing it prints changes how anything trades. Every statistic
// comes from `lib/signal-health.ts`, so a number here means exactly what the same number
// means in the daily review; this file only loads and splits.
//
// Note what it is NOT. `signal-research.ts` is the heavy instrument — ~120k stock-days
// of `PriceBar` reconstructed back to 2021. This reads the live estimate window only,
// which begins 2026-06-01 (`QuantAnalysis.sessionDate` starts there), so it is bounded
// to a few dozen sessions and cannot support a strong claim on its own. Use it to check
// whether a monitor's alarm survives a split, not to establish an edge.
//
// Reading the output: excess is over the universe on the same session, in bps, over
// `--horizon` sessions. `t` is computed ACROSS SESSIONS with Newey-West errors, never
// by pooling names within a day — see `entryTStat`. A sign that holds across train,
// holdout and every fold while never clearing |t| ~ 2 is a persistent hint, not a
// finding.
//
// Usage:
//   npm run signal-split
//   npm run signal-split -- --split=2026-07-09 --folds=4
//   npm run signal-split -- --horizon=10
//   npm run signal-split -- --json

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const DEFAULT_FOLDS = 4;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

function parseArgs(argv: string[]) {
  let split: string | null = null; // default: the median session, computed once loaded
  let folds = DEFAULT_FOLDS;
  let horizon = DEFAULT_HORIZON;
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--split=")) split = a.slice(8);
    else if (a.startsWith("--folds=")) folds = Math.max(0, Number(a.slice(8)) || 0);
    else if (a.startsWith("--horizon=")) horizon = Math.max(1, Number(a.slice(10)) || DEFAULT_HORIZON);
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (split && !/^\d{4}-\d{2}-\d{2}$/.test(split)) {
    console.error(`--split must be YYYY-MM-DD, got: ${split}`);
    process.exit(2);
  }
  return { split, folds, horizon, json };
}

/** Every scored estimate joined to the session it describes and its forward return. */
async function loadObservations(horizon: number): Promise<Observation[]> {
  const [estimates, quantRows] = await Promise.all([
    prisma.stockEstimate.findMany({
      select: { stockId: true, date: true, sentimentScore: true, quantScore: true, combinedScore: true },
    }),
    // sessionDate is what the scores DESCRIBE; `date` is when the row was written, and
    // the two differ by 1-4 days. Joining on the wrong one silently shifts the horizon.
    prisma.quantAnalysis.findMany({
      where: { sessionDate: { not: null } },
      select: { stockId: true, date: true, sessionDate: true },
    }),
  ]);

  const sessionFor = new Map<string, string>();
  for (const q of quantRows) sessionFor.set(`${q.stockId}|${dateStr(q.date)}`, dateStr(q.sessionDate!));

  const rows = estimates
    .map((e) => {
      const session = sessionFor.get(`${e.stockId}|${dateStr(e.date)}`);
      return session
        ? { stockId: e.stockId, session, sentimentScore: e.sentimentScore, quantScore: e.quantScore, combinedScore: e.combinedScore }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  if (rows.length === 0) return [];
  const bars = await prisma.priceBar.findMany({
    where: { stockId: { in: [...new Set(rows.map((r) => r.stockId))] } },
    select: { stockId: true, date: true, close: true },
  });
  return buildObservations(
    rows,
    bars.map((b) => ({ stockId: b.stockId, session: dateStr(b.date), close: b.close })),
    horizon
  );
}

const bps = (v: number) => `${v >= 0 ? "+" : ""}${(v * 10_000).toFixed(1)}`;

/** Flags a period whose sample is thinner than the monitor's own reporting bar. */
const thin = (h: SourceHealth) => h.entry.n < MIN_ENTRY_OBSERVATIONS || h.entry.sessions < MIN_SESSIONS;

function line(label: string, h: SourceHealth): string {
  return (
    `  ${label.padEnd(9)} ${bps(h.entry.meanExcess).padStart(8)} bps  ` +
    `t=${(h.entry.tStat?.toFixed(2) ?? "—").padStart(6)}  ` +
    `n=${String(h.entry.n).padStart(5)}  entry sessions=${String(h.entry.sessions).padStart(3)}` +
    `${thin(h) ? "  (thin)" : ""}`
  );
}

function healthOf(obs: Observation[], source: string): SourceHealth {
  return signalHealth(obs).find((h) => h.source === source)!;
}

async function main() {
  const { split, folds, horizon, json } = parseArgs(process.argv.slice(2));
  const obs = await loadObservations(horizon);
  if (obs.length === 0) {
    console.log("No observations: no estimate has both a sessionDate and a full forward window yet.");
    return;
  }

  const sessions = [...new Set(obs.map((o) => o.session))].sort();
  // Default cut is the median SESSION, not the median row — halves should span equal
  // calendar, not equal name-count.
  const cut = split ?? sessions[Math.floor(sessions.length / 2)];
  const { train, holdout } = splitFixed(obs, cut);

  if (json) {
    const period = (rows: Observation[]) =>
      Object.fromEntries(
        SIGNAL_SOURCES.map((s) => {
          const h = healthOf(rows, s);
          return [s, { excessBps: Number((h.entry.meanExcess * 10_000).toFixed(1)), t: h.entry.tStat, n: h.entry.n, entrySessions: h.entry.sessions, scoredSessions: h.sessions }];
        })
      );
    console.log(
      JSON.stringify(
        {
          horizon,
          split: cut,
          sessions: sessions.length,
          window: { from: sessions[0], to: sessions[sessions.length - 1] },
          full: period(obs),
          train: period(train),
          holdout: period(holdout),
          folds: splitRolling(obs, folds).map((f) => ({ label: f.label, ...period(f.rows) })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `Live entry signal, ${horizon}-session horizon — ${obs.length} observations over ` +
      `${sessions.length} sessions (${sessions[0]} → ${sessions[sessions.length - 1]})`
  );
  console.log(`Excess is over the universe on the same session; t is across sessions (Newey-West).\n`);

  console.log("FULL WINDOW");
  for (const s of SIGNAL_SOURCES) console.log(line(s, healthOf(obs, s)));

  console.log(`\nSPLIT at ${cut}`);
  for (const s of SIGNAL_SOURCES) {
    console.log(line(`${s} tr`, healthOf(train, s)));
    console.log(line(`${s} ho`, healthOf(holdout, s)));
  }

  const rolling = splitRolling(obs, folds);
  if (rolling.length > 0) {
    console.log(`\n${rolling.length} ROLLING FOLDS`);
    for (const f of rolling) {
      const parts = SIGNAL_SOURCES.map((s) => {
        const h = healthOf(f.rows, s);
        return `${s}=${bps(h.entry.meanExcess)}(t${h.entry.tStat?.toFixed(1) ?? "—"})`;
      });
      console.log(`  ${f.label}  ${parts.join("  ")}`);
    }
  }

  console.log(
    `\n(thin) = below the ${MIN_ENTRY_OBSERVATIONS}-entry / ${MIN_SESSIONS}-session bar the daily review ` +
      `requires before it will judge a signal at all. Splitting a short window puts most periods there — ` +
      `read a consistent SIGN across periods, not any single t.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
