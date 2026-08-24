import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildObservations, DEFAULT_HORIZON } from "../src/lib/signal-health";

// Read-only: why does SENTIMENT's STRONG_BUY bucket underperform its own BUY
// bucket? (Post-repair signal-health re-read, 2026-08-24: STRONG_BUY -80.9 bps
// t=-3.56 vs BUY +8.6 bps.) Since 2026-07-31 the _RM entry gate reads the
// sentiment score, so the shape of the top of this distribution is an entry-path
// question. Four slices: the excess-by-score gradient, name/session
// concentration, month-by-month stability, and a per-session paired
// STRONG_BUY-minus-BUY difference (the direct "is conviction inverted" test —
// same-session pairing removes the market-day effect).

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const WINDOW_DAYS = 90;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const bps = (v: number) => `${(v * 10000).toFixed(1)} bps`;

function tAcross(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd === 0 ? null : m / (sd / Math.sqrt(xs.length));
}

async function main() {
  const todayUTC = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const since = new Date(todayUTC.getTime() - WINDOW_DAYS * 86_400_000);

  const [estimates, quantRows, stocks] = await Promise.all([
    prisma.stockEstimate.findMany({
      where: { date: { gte: since } },
      select: { stockId: true, date: true, sentimentScore: true, quantScore: true, combinedScore: true },
    }),
    prisma.quantAnalysis.findMany({
      where: { date: { gte: since }, sessionDate: { not: null } },
      select: { stockId: true, date: true, sessionDate: true },
    }),
    prisma.stock.findMany({ select: { id: true, ticker: true } }),
  ]);
  const tickerOf = new Map(stocks.map((s) => [s.id, s.ticker]));
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
  const bars = await prisma.priceBar.findMany({
    where: { stockId: { in: [...new Set(rows.map((r) => r.stockId))] }, date: { gte: since } },
    select: { stockId: true, date: true, close: true },
  });
  const obs = buildObservations(
    rows,
    bars.map((b) => ({ stockId: b.stockId, session: dateStr(b.date), close: b.close })),
    DEFAULT_HORIZON
  ).filter((o) => o.scores.SENTIMENT != null);

  // Per-session universe mean (all sentiment-scored names that session).
  const bySession = new Map<string, typeof obs>();
  for (const o of obs) {
    const arr = bySession.get(o.session) ?? [];
    arr.push(o);
    bySession.set(o.session, arr);
  }
  const uniMean = new Map<string, number>();
  for (const [s, arr] of bySession) uniMean.set(s, mean(arr.map((o) => o.forwardReturn)));
  const excess = (o: (typeof obs)[number]) => o.forwardReturn - uniMean.get(o.session)!;
  console.log(`observations: ${obs.length} over ${bySession.size} sessions\n`);

  // ── 1. excess by sentiment-score bin ────────────────────────────────────────
  console.log("== excess by sentiment score bin (t across sessions) ==");
  const bins: [string, (s: number) => boolean][] = [
    ["<= 0.2 (non-entry)", (s) => s <= 0.2],
    ["(0.2, 0.4]", (s) => s > 0.2 && s <= 0.4],
    ["(0.4, 0.6]", (s) => s > 0.4 && s <= 0.6],
    ["(0.6, 0.7]", (s) => s > 0.6 && s <= 0.7],
    ["(0.7, 0.8]", (s) => s > 0.7 && s <= 0.8],
    ["(0.8, 1.0]", (s) => s > 0.8],
  ];
  for (const [label, inBin] of bins) {
    const sel = obs.filter((o) => inBin(o.scores.SENTIMENT!));
    if (sel.length === 0) {
      console.log(`  ${label.padEnd(20)} n=0`);
      continue;
    }
    const perSession = new Map<string, number[]>();
    for (const o of sel) {
      const arr = perSession.get(o.session) ?? [];
      arr.push(excess(o));
      perSession.set(o.session, arr);
    }
    const sessMeans = [...perSession.values()].map(mean);
    const t = tAcross(sessMeans);
    console.log(
      `  ${label.padEnd(20)} n=${String(sel.length).padStart(5)}  excess=${bps(mean(sel.map(excess))).padStart(10)}  ` +
        `t=${t != null ? t.toFixed(2) : "-"} (${sessMeans.length} sess)`
    );
  }

  // ── 2. STRONG_BUY concentration ─────────────────────────────────────────────
  const sb = obs.filter((o) => o.scores.SENTIMENT! > 0.6);
  const byTicker = new Map<string, { n: number; ex: number[] }>();
  for (const o of sb) {
    const t = tickerOf.get(o.stockId) ?? o.stockId;
    const e = byTicker.get(t) ?? { n: 0, ex: [] };
    e.n++;
    e.ex.push(excess(o));
    byTicker.set(t, e);
  }
  const top = [...byTicker.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const topShare = top.slice(0, 5).reduce((a, [, e]) => a + e.n, 0) / sb.length;
  console.log(
    `\n== STRONG_BUY concentration: ${sb.length} obs, ${byTicker.size} names, top-5 share ${(topShare * 100).toFixed(0)}% ==`
  );
  for (const [t, e] of top) console.log(`  ${t.padEnd(6)} n=${String(e.n).padStart(4)}  excess=${bps(mean(e.ex))}`);

  // ── 3. month-by-month ───────────────────────────────────────────────────────
  console.log("\n== STRONG_BUY excess by month ==");
  for (const month of ["2026-05", "2026-06", "2026-07", "2026-08"]) {
    const sel = sb.filter((o) => o.session.startsWith(month));
    if (sel.length === 0) continue;
    const sessions = new Map<string, number[]>();
    for (const o of sel) {
      const arr = sessions.get(o.session) ?? [];
      arr.push(excess(o));
      sessions.set(o.session, arr);
    }
    const t = tAcross([...sessions.values()].map(mean));
    console.log(
      `  ${month}  n=${String(sel.length).padStart(4)}  excess=${bps(mean(sel.map(excess))).padStart(10)}  ` +
        `t=${t != null ? t.toFixed(2) : "-"} (${sessions.size} sess)`
    );
  }

  // ── 4. paired per-session STRONG_BUY minus BUY ──────────────────────────────
  const diffs: number[] = [];
  for (const [, arr] of bySession) {
    const strong = arr.filter((o) => o.scores.SENTIMENT! > 0.6);
    const buy = arr.filter((o) => o.scores.SENTIMENT! > 0.2 && o.scores.SENTIMENT! <= 0.6);
    if (strong.length === 0 || buy.length === 0) continue;
    diffs.push(mean(strong.map((o) => o.forwardReturn)) - mean(buy.map((o) => o.forwardReturn)));
  }
  console.log(
    `\n== paired per-session STRONG_BUY minus BUY ==\n` +
      `  mean diff ${bps(mean(diffs))} over ${diffs.length} sessions, t=${tAcross(diffs)?.toFixed(2) ?? "-"} ` +
      `(negative = higher conviction does worse on the same day)`
  );
}

main().finally(() => prisma.$disconnect());
