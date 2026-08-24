import "dotenv/config";
import { PrismaClient, type PrismaClient as PC } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildObservations, signalHealth, DEFAULT_HORIZON } from "../src/lib/signal-health";

// Read-only re-run of the daily review's signal-health check (section 6 of
// review.ts, replicated verbatim) — after the sessionDate repair. The August
// readings recorded in OPEN-FINDINGS.md were computed while most rows since
// 07-31 had NULL sessionDate and silently dropped out of the join; this prints
// what the same 90-day window says now that the rows are back.

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL! });
const prisma = new PrismaClient({ adapter }) as unknown as PC<never, undefined>;

const WINDOW_DAYS = 90;
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const todayUTC = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const since = new Date(todayUTC.getTime() - WINDOW_DAYS * 86_400_000);

  const [estimates, quantRows] = await Promise.all([
    prisma.stockEstimate.findMany({
      where: { date: { gte: since } },
      select: { stockId: true, date: true, sentimentScore: true, quantScore: true, combinedScore: true },
    }),
    prisma.quantAnalysis.findMany({
      where: { date: { gte: since }, sessionDate: { not: null } },
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

  console.log(`estimates in window: ${estimates.length}; joined to a session: ${rows.length}`);
  console.log(`distinct sessions in the joined sample: ${new Set(rows.map((r) => r.session)).size}`);

  const stockIds = [...new Set(rows.map((r) => r.stockId))];
  const bars = await prisma.priceBar.findMany({
    where: { stockId: { in: stockIds }, date: { gte: since } },
    select: { stockId: true, date: true, close: true },
  });
  const obs = buildObservations(
    rows,
    bars.map((b) => ({ stockId: b.stockId, session: dateStr(b.date), close: b.close })),
    DEFAULT_HORIZON
  );
  console.log(`observations with a full ${DEFAULT_HORIZON}-session forward window: ${obs.length}\n`);

  const health = signalHealth(obs);
  for (const h of health) {
    console.log(`== ${h.source} (scored ${h.sessions} sessions) ==`);
    for (const b of h.buckets) {
      console.log(
        `  ${b.label.padEnd(12)} n=${String(b.n).padStart(5)}  excess=${(b.meanExcess * 10000).toFixed(1).padStart(7)} bps  t=${b.tStat != null ? b.tStat.toFixed(2) : "-"}`
      );
    }
    console.log(
      `  ENTRY (BUY+): n=${h.entry.n}  excess=${(h.entry.meanExcess * 10000).toFixed(1)} bps  ` +
        `t=${h.entry.tStat != null ? h.entry.tStat.toFixed(2) : "-"} across ${h.entry.sessions} entry sessions\n`
    );
  }
}

main().finally(() => prisma.$disconnect());
