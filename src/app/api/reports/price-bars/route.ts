import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isPipelineAuthorized } from "@/lib/cron-auth";
import { withRoute } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Read access to the daily bar corpus the research harness is built on.
 *
 * Exists so the research agent can rebuild the feature table with **no database
 * credential on the runner** — the same reasoning as the daily-review report, one step
 * further. The alternative was handing a scheduled workflow `DIRECT_URL`, which is a
 * full-privilege Postgres secret; this endpoint is strictly read-only over one table and
 * the workflow can hold nothing but the pipeline secret it already needs.
 *
 * Windowed rather than paginated by cursor: the corpus is append-only history keyed by
 * date, so a caller walks it a year at a time and gets stable, cacheable, resumable
 * chunks with no cursor state. `MAX_WINDOW_DAYS` bounds any single response — the whole
 * table is ~127k rows / ~27 MB, which is more than one function response should carry.
 *
 *   GET /api/reports/price-bars?from=2021-01-01&to=2021-12-31
 *   GET /api/reports/price-bars?bounds=1   → earliest and latest session, no payload
 */

/** A year and change: comfortably one calendar year of sessions plus slack at the edges. */
const MAX_WINDOW_DAYS = 400;

const isDate = (s: string | null): s is string => s != null && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const GET = withRoute("reports/price-bars", async (req: Request): Promise<Response> => {
  if (!isPipelineAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;

  // Bounds first, so a caller can discover the range to walk without guessing at it.
  if (params.get("bounds") != null) {
    const [first, last] = await Promise.all([
      db.priceBar.findFirst({ orderBy: { date: "asc" }, select: { date: true } }),
      db.priceBar.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    ]);
    if (!first || !last) return NextResponse.json({ error: "PriceBar is empty" }, { status: 404 });
    return NextResponse.json({
      from: first.date.toISOString().slice(0, 10),
      to: last.date.toISOString().slice(0, 10),
      maxWindowDays: MAX_WINDOW_DAYS,
    });
  }

  const from = params.get("from");
  const to = params.get("to");
  if (!isDate(from) || !isDate(to)) {
    return NextResponse.json({ error: "from and to are required, as YYYY-MM-DD" }, { status: 400 });
  }
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }
  if (toDate < fromDate) {
    return NextResponse.json({ error: "to is before from" }, { status: 400 });
  }
  const days = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      { error: `Window too wide: ${days} days, max ${MAX_WINDOW_DAYS}. Walk the corpus a year at a time.` },
      { status: 400 }
    );
  }

  const rows = await db.priceBar.findMany({
    where: { date: { gte: fromDate, lte: toDate } },
    select: {
      stockId: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      stock: { select: { ticker: true } },
    },
    orderBy: { date: "asc" },
  });

  // Shaped as `Bar` (see lib/signal-research) so the caller can feed `buildFeatures`
  // with no translation — a second mapping is a second place for the session-date
  // handling to drift, which is exactly how the Tiingo defect stayed hidden.
  return NextResponse.json({
    from,
    to,
    count: rows.length,
    bars: rows.map((r) => ({
      stockId: r.stockId,
      ticker: r.stock.ticker,
      session: r.date.toISOString().slice(0, 10),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })),
  });
});
