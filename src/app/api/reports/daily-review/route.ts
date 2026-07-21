import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isPipelineAuthorized } from "@/lib/cron-auth";
import { withRoute } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Read access to the daily post-close review.
 *
 * Authorized with the pipeline secret rather than a user session so the scheduled
 * analysis agent can fetch a report with a single request and no database or MCP
 * access — the report travels as self-contained JSON, which is what lets the agent
 * run anywhere.
 *
 *   GET /api/reports/daily-review            → the most recent report
 *   GET /api/reports/daily-review?date=…     → that UTC day (YYYY-MM-DD)
 *   GET /api/reports/daily-review?list=30    → index of recent days, no payloads
 */
export const GET = withRoute("reports/daily-review", async (req: Request): Promise<Response> => {
  if (!isPipelineAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;

  const list = params.get("list");
  if (list != null) {
    const take = Math.min(Math.max(Number(list) || 30, 1), 365);
    // `status` is written together with `report`, so it's the reliable "has a
    // report" predicate — filtering a nullable Json column needs Prisma.DbNull
    // and reads far worse for the same result.
    const rows = await db.dailyReview.findMany({
      where: { status: { not: null } },
      orderBy: { date: "desc" },
      take,
      select: { date: true, status: true, findingCount: true, createdAt: true },
    });
    return NextResponse.json({ reviews: rows });
  }

  const dateParam = params.get("date");
  if (dateParam != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return NextResponse.json({ error: "Invalid date — expected YYYY-MM-DD" }, { status: 400 });
    }
    const date = new Date(`${dateParam}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    const row = await db.dailyReview.findUnique({ where: { date } });
    if (!row?.report) {
      return NextResponse.json({ error: `No review for ${dateParam}` }, { status: 404 });
    }
    return NextResponse.json(row.report);
  }

  const latest = await db.dailyReview.findFirst({
    where: { status: { not: null } },
    orderBy: { date: "desc" },
  });
  if (!latest?.report) {
    return NextResponse.json({ error: "No reviews yet" }, { status: 404 });
  }
  return NextResponse.json(latest.report);
});
