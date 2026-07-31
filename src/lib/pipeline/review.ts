import { db } from "@/lib/db";
import {
  replayDecisions,
  auditClosedPositions,
  closedPositionAuditConfig,
  auditOpenPositions,
  auditEntries,
  auditRiskBlocks,
  auditRunProvenance,
  auditTrackingError,
  reconcileBroker,
  auditHealth,
  summarizeStrategies,
  tuningSignals,
  overallStatus,
  rankFindings,
  type AuditPosition,
  type ClosedTradeStat,
  type DailyReviewReport,
  type Finding,
  type PaperRunLog,
} from "@/lib/daily-review";
import { auditFindingsRegister, type RegisterFacts } from "@/lib/findings-register";
import { buildObservations, signalHealth, auditSignalHealth, DEFAULT_HORIZON, MIN_ENTRY_OBSERVATIONS, MIN_SESSIONS } from "@/lib/signal-health";
import { ALL_STRATEGIES, RM_STRATEGIES, STRATEGY_BOOK, utcDaysBetween, type Strategy } from "@/lib/paper-trading";
import { loadTradingConfig } from "@/lib/trading-config";
import { minutesSinceClose, lastClosedSession, withinStaticAfterCloseWindow, type TradingSession } from "@/lib/market-hours";
import {
  isPaperTradingConfigured,
  getCalendarDays,
  getPositions,
  getOpenOrders,
} from "@/lib/alpaca-trading";
import { isEmailConfigured, sendEmail, buildReviewEmail } from "@/lib/email";
import { isReviewSlackConfigured, interpretAndPostReview } from "@/lib/review-interpret";
import { reportError } from "@/lib/observability";
import { dateStr, startOfUtcDay, universeWhere } from "./shared";

export type ReviewStageResult = {
  stage: "review";
  reviewed: boolean; // false when out of window or already done today
  status: "OK" | "WARN" | "FAIL" | null;
  findings: number;
  done: true;
  errors: string[];
};

// The window opens ~1h after the close and stays open an hour, so the dense cron
// tick reliably lands inside it exactly once (the DailyReview row makes repeats
// no-ops). Waiting the full hour lets late fills settle and the broker's position
// list catch up — reconciling at the bell would flag orders that are merely pending.
const WINDOW_FROM_MIN = Number(process.env.REVIEW_WINDOW_FROM_MIN) || 55;
const WINDOW_TO_MIN = Number(process.env.REVIEW_WINDOW_TO_MIN) || 115;

/** Trailing window for the strategy rollups — enough closes to mean something. */
const TUNING_LOOKBACK_DAYS = Number(process.env.REVIEW_TUNING_LOOKBACK_DAYS) || 90;

// Fraction of the sim's trackable names the live book must actually hold before its
// P&L stops being evidence about the strategy. 0.7 tolerates the ordinary one- or
// two-name lag from a pending fill while still failing the state that went unnoticed
// for 17 trading days (3 of 8 names = 0.38).
const LIVE_TRACKING_MIN_COVERAGE = Number(process.env.REVIEW_TRACKING_MIN_COVERAGE) || 0.7;

// Days without a mark before an open position counts as unmanaged, for the register's
// "verified zero occurrences" claim. 4 clears a long weekend, so only a position the
// stage is genuinely not reaching trips it.
const REGISTER_STALE_MARK_DAYS = 4;
// Trailing window for "did the _RM entry freeze drain?". 30 days is long enough that a
// quiet fortnight doesn't re-assert a freeze that has ended.
const REGISTER_ENTRY_WINDOW_DAYS = 30;
// Trailing window for the entry-signal health check. 90 days is the shortest span that
// accumulates enough scored entries to t-test while staying recent enough that a regime
// change shows up rather than being averaged away by three good years.
const SIGNAL_HEALTH_WINDOW_DAYS = 90;

/**
 * True when we're in the post-close window. Prefers the broker calendar, which
 * knows the *actual* close for the day — an early close ends at 13:00 ET, and a
 * static UTC window can't see that. Falls back to the static window only when the
 * broker is unreachable or unconfigured.
 */
export async function afterCloseWindow(now = new Date()): Promise<boolean> {
  if (isPaperTradingConfigured()) {
    try {
      const sessions = await getCalendarDays(new Date(now.getTime() - 4 * 86_400_000), now);
      const mins = minutesSinceClose(sessions, now);
      // A session that closed today and nothing since — a stale "last close" from
      // Friday would otherwise re-open the window all weekend.
      const last = lastClosedSession(sessions, now);
      if (mins == null || last == null) return false;
      if (last.session.date !== dateStr(now)) return false;
      return mins >= WINDOW_FROM_MIN && mins < WINDOW_TO_MIN;
    } catch {
      // calendar unavailable → fall back to the static window
    }
  }
  return withinStaticAfterCloseWindow(now, WINDOW_FROM_MIN, WINDOW_TO_MIN);
}

/** Absolute close instant for today, when the broker calendar can tell us. */
async function todaysCloseAt(now: Date): Promise<Date | null> {
  if (!isPaperTradingConfigured()) return null;
  try {
    const sessions = await getCalendarDays(new Date(now.getTime() - 4 * 86_400_000), now);
    const last = lastClosedSession(sessions, now);
    return last && last.session.date === dateStr(now) ? last.closeAt : null;
  } catch {
    return null;
  }
}

/** Trading days between the previous review and today that never got a paper run. */
async function findMissedTradingDays(todayUTC: Date, now: Date): Promise<string[]> {
  const prev = await db.paperEquitySnapshot.findFirst({
    where: { book: "SIM_COMBINED", date: { lt: todayUTC } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!prev || !isPaperTradingConfigured()) return [];
  let sessions: TradingSession[];
  try {
    sessions = await getCalendarDays(prev.date, now);
  } catch {
    return [];
  }
  const snapshots = await db.paperEquitySnapshot.findMany({
    where: { book: "SIM_COMBINED", date: { gt: prev.date, lte: todayUTC } },
    select: { date: true },
  });
  const seen = new Set(snapshots.map((s) => dateStr(s.date)));
  const prevStr = dateStr(prev.date);
  const todayStr = dateStr(todayUTC);
  return sessions
    .map((s) => s.date)
    .filter((d) => d > prevStr && d < todayStr && !seen.has(d));
}

// ── Daily post-close review ──────────────────────────────────────────────────
//
// Runs an hour after the close and asks the question the performance page can't:
// did the app do what its own rules say it should have done? Four layers, each
// independent so one failing never costs you the rest:
//   • replay      — re-run the paper stage's logged decisions through the same pure
//                   reconcilers and diff. A mismatch is a bug, full stop.
//   • invariants  — check persisted positions against the rung they exited on, and
//                   flag open positions that already meet an exit condition.
//   • broker      — diff the live Alpaca account against the sim book it mirrors
//                   (missing stops, orphaned orders, unfilled entries, drift).
//   • health      — did every stage produce today's inputs, on time, cleanly.
// Plus trailing per-book stats sliced by exit rung, which is what turns "this knob
// feels wrong" into evidence.
//
// Read-only with respect to trading: it never opens, closes or cancels anything.
// Idempotent per UTC day via the DailyReview row, and single-shot (`done: true`).
export async function runReviewStage(): Promise<ReviewStageResult> {
  const errors: string[] = [];
  const now = new Date();
  const todayUTC = startOfUtcDay(now);

  const existing = await db.dailyReview.findUnique({
    where: { date: todayUTC },
    select: { report: true, paperRun: true },
  });
  if (existing?.report) {
    return { stage: "review", reviewed: false, status: null, findings: 0, done: true, errors };
  }

  // Out-of-window ticks return without writing anything, so the day's first
  // in-window tick does the work — the same self-gating the paper stage uses.
  if (!(await afterCloseWindow(now))) {
    return { stage: "review", reviewed: false, status: null, findings: 0, done: true, errors };
  }

  const findings: Finding[] = [];
  const notes: string[] = [];
  const { risk: cfg, limits, issues: configIssues } = await loadTradingConfig();
  if (configIssues.length > 0) errors.push(`Trading config: ${configIssues.join("; ")}`);

  const runLog = (existing?.paperRun ?? null) as PaperRunLog | null;

  // ── 1. Replay ──────────────────────────────────────────────────────────────
  let replayed = 0;
  if (runLog?.decisions) {
    try {
      findings.push(...replayDecisions(runLog));
      // Separate from the replay: the replay asks "did the rules produce the right
      // decision?", this asks "was the decision allowed to happen at all?".
      findings.push(...auditRiskBlocks(runLog.decisions, limits));
      // What the run says about itself. Separate again: the two above ask whether the
      // decisions were right, this asks whether they are even comparable to yesterday's.
      findings.push(...auditRunProvenance(runLog));
      replayed = runLog.decisions.length;
      for (const err of runLog.errors ?? []) notes.push(`paper: ${err}`);
    } catch (e) {
      errors.push(`Decision replay failed: ${String(e)}`);
    }
  } else {
    notes.push(
      "No decision log for today — the paper stage either didn't run or predates run logging, so only the invariant checks ran."
    );
  }

  // ── 2. Position invariants ─────────────────────────────────────────────────
  const positionSelect = {
    id: true,
    strategy: true,
    status: true,
    qty: true,
    entryDate: true,
    entryPrice: true,
    confidence: true,
    entryScore: true,
    entrySignal: true,
    entryAtrPct: true,
    peakPrice: true,
    bearishStreak: true,
    staleStreak: true,
    lastMarkDate: true,
    lastMarkPrice: true,
    exitDate: true,
    exitPrice: true,
    exitReason: true,
    realizedPnl: true,
    stock: { select: { ticker: true } },
  } as const;

  // The row shape the select above produces; `strategy`/`status` are free-text in
  // the schema, so they're narrowed to their domain here rather than trusted.
  type PositionRow = Omit<AuditPosition, "ticker" | "strategy" | "status"> & {
    stock: { ticker: string };
    strategy: string;
    status: string;
  };
  const toAudit = ({ stock, strategy, status, ...rest }: PositionRow): AuditPosition => ({
    ...rest,
    ticker: stock.ticker,
    strategy: strategy as Strategy,
    status: status as "OPEN" | "CLOSED",
  });

  let openPositions: AuditPosition[] = [];
  let closedToday: AuditPosition[] = [];
  let openedToday: AuditPosition[] = [];
  try {
    const [openRows, closedRows] = await Promise.all([
      db.simPosition.findMany({ where: { status: "OPEN" }, select: positionSelect }),
      db.simPosition.findMany({ where: { status: "CLOSED", exitDate: { gte: todayUTC } }, select: positionSelect }),
    ]);
    openPositions = openRows.map(toAudit);
    closedToday = closedRows.map(toAudit);
    openedToday = openPositions.filter((p) => p.entryDate >= todayUTC);

    // Config edits mid-position make an honest exit look wrong; the audit knows to
    // soften those findings rather than cry wolf.
    const cfgRow = await db.appSetting.findUnique({ where: { key: "tradingConfig" }, select: { updatedAt: true } });
    findings.push(...auditClosedPositions(closedToday, closedPositionAuditConfig(runLog, cfg), cfgRow?.updatedAt ?? null));
    findings.push(...auditOpenPositions(openPositions, cfg, todayUTC));
    findings.push(...auditEntries(openedToday, cfg));
  } catch (e) {
    errors.push(`Position audit failed: ${String(e)}`);
  }

  // ── 3. Broker reconciliation ───────────────────────────────────────────────
  let ordersToday = 0;
  if (isPaperTradingConfigured()) {
    try {
      const [brokerPositions, brokerOrders, submitted] = await Promise.all([
        getPositions(),
        getOpenOrders(),
        db.paperOrder.findMany({
          where: { submittedAt: { gte: todayUTC } },
          select: {
            side: true,
            signal: true,
            status: true,
            qty: true,
            filledQty: true,
            filledAvgPrice: true,
            stock: { select: { ticker: true } },
          },
        }),
      ]);
      ordersToday = submitted.length;
      findings.push(
        ...reconcileBroker({
          brokerPositions: brokerPositions.map((p) => ({
            symbol: p.symbol,
            qty: p.qty,
            avgEntryPrice: p.avgEntryPrice,
            currentPrice: p.currentPrice,
          })),
          brokerOrders: brokerOrders.map((o) => ({ id: o.id, symbol: o.symbol, type: o.type, side: o.side, qty: o.qty })),
          simLong: openPositions
            .filter((p) => p.strategy === "COMBINED_RM")
            .map((p) => ({ ticker: p.ticker, qty: p.qty })),
          submittedToday: submitted.map((o) => ({
            ticker: o.stock.ticker,
            side: o.side,
            signal: o.signal,
            status: o.status,
            qty: o.qty,
            filledQty: o.filledQty,
            filledAvgPrice: o.filledAvgPrice,
          })),
          brokerStopsEnabled: runLog?.flags.brokerStops ?? false,
        })
      );
      // reconcileBroker names the divergent tickers per category; this scores the
      // drift as one number, so a live book quietly holding a fraction of the sim
      // reads as a single fail instead of a list a reader has to add up.
      findings.push(
        ...auditTrackingError({
          simLong: openPositions
            .filter((p) => p.strategy === "COMBINED_RM")
            .map((p) => ({ ticker: p.ticker, qty: p.qty })),
          brokerSymbols: brokerPositions.map((p) => p.symbol),
          minCoverage: LIVE_TRACKING_MIN_COVERAGE,
        })
      );
    } catch (e) {
      errors.push(`Broker reconciliation failed: ${String(e)}`);
      notes.push("Broker reconciliation could not run — the Alpaca account was unreachable.");
    }
  } else {
    notes.push("Alpaca is not configured, so only the simulated books were reviewed.");
  }

  // ── 4. Pipeline & data health ──────────────────────────────────────────────
  try {
    const [universeSize, estimates, sentiments, quant, articles, paperSnap, alerts, missedDays, closeAt] =
      await Promise.all([
        db.stock.count({ where: universeWhere() }),
        db.stockEstimate.findMany({
          where: { date: { gte: todayUTC }, stock: universeWhere() },
          select: { dataWarnings: true },
        }),
        db.sentiment.count({ where: { date: { gte: todayUTC } } }),
        db.quantAnalysis.count({ where: { date: { gte: todayUTC } } }),
        db.article.count({ where: { createdAt: { gte: todayUTC } } }),
        db.paperEquitySnapshot.findUnique({
          where: { book_date: { book: "SIM_COMBINED", date: todayUTC } },
          select: { createdAt: true },
        }),
        db.alert.findMany({ where: { createdAt: { gte: todayUTC } }, select: { type: true, title: true } }),
        findMissedTradingDays(todayUTC, now),
        todaysCloseAt(now),
      ]);

    const dataWarningCounts: Record<string, number> = {};
    for (const e of estimates) {
      for (const w of e.dataWarnings) dataWarningCounts[w] = (dataWarningCounts[w] ?? 0) + 1;
    }

    findings.push(
      ...auditHealth({
        universeSize,
        estimatesToday: estimates.length,
        sentimentsToday: sentiments,
        quantToday: quant,
        articlesToday: articles,
        dataWarningCounts,
        // The run log's own timestamp is when the stage acted; the snapshot row is
        // the fallback for days that predate run logging.
        paperRanAt: runLog?.ranAt ? new Date(runLog.ranAt) : (paperSnap?.createdAt ?? null),
        marketClosedAt: closeAt,
        paperErrors: runLog?.errors ?? [],
        missedTradingDays: missedDays,
        alertsToday: alerts,
      })
    );
  } catch (e) {
    errors.push(`Health audit failed: ${String(e)}`);
  }

  // ── 5. Strategy rollups + tuning signals ───────────────────────────────────
  let strategies: DailyReviewReport["strategies"] = [];
  try {
    const since = new Date(todayUTC.getTime() - TUNING_LOOKBACK_DAYS * 86_400_000);
    const closed = await db.simPosition.findMany({
      where: { status: "CLOSED", exitDate: { gte: since } },
      select: {
        strategy: true,
        exitReason: true,
        realizedPnl: true,
        entryPrice: true,
        exitPrice: true,
        entryDate: true,
        exitDate: true,
      },
    });
    const trades: ClosedTradeStat[] = closed
      .filter((t) => t.exitDate != null && t.exitPrice != null)
      .map((t) => ({
        strategy: t.strategy as Strategy,
        exitReason: t.exitReason,
        realizedPnl: t.realizedPnl ?? 0,
        returnPct: t.entryPrice > 0 ? (t.exitPrice! - t.entryPrice) / t.entryPrice : 0,
        holdDays: utcDaysBetween(t.entryDate, t.exitDate!),
        exitDate: t.exitDate!,
      }));
    strategies = summarizeStrategies(trades);
    findings.push(...tuningSignals(strategies));
    if (trades.length === 0) {
      notes.push(`No positions have closed in the last ${TUNING_LOOKBACK_DAYS} days, so there are no tuning signals yet.`);
    }
  } catch (e) {
    errors.push(`Strategy rollup failed: ${String(e)}`);
  }

  // Shared with the register check below, which asserts the sign of this number.
  let quantEntryExcessBps: number | null = null;

  // ── 6. Is the signal still pointing the right way? ─────────────────────────
  //
  // Every other check here asks whether the rules were followed. This one asks whether
  // following them still pays — the question that went unasked while calcQuantScore's
  // entry signal inverted (see OPEN-FINDINGS.md, "the quant entry signal inverted").
  try {
    const since = new Date(todayUTC.getTime() - SIGNAL_HEALTH_WINDOW_DAYS * 86_400_000);
    // Estimates joined to the SESSION their scores describe. That mapping now exists —
    // QuantAnalysis.sessionDate — and must be read, not re-derived: `date` is the run
    // day, which is one to four days after the session it prices.
    const [estimates, quantRows] = await Promise.all([
      db.stockEstimate.findMany({
        where: { date: { gte: since } },
        select: { stockId: true, date: true, sentimentScore: true, quantScore: true, combinedScore: true },
      }),
      db.quantAnalysis.findMany({
        where: { date: { gte: since }, sessionDate: { not: null } },
        select: { stockId: true, date: true, sessionDate: true },
      }),
    ]);

    const sessionFor = new Map<string, string>();
    for (const q of quantRows) {
      sessionFor.set(`${q.stockId}|${dateStr(q.date)}`, dateStr(q.sessionDate!));
    }
    const rows = estimates
      .map((e) => {
        const session = sessionFor.get(`${e.stockId}|${dateStr(e.date)}`);
        return session ? { stockId: e.stockId, session, sentimentScore: e.sentimentScore, quantScore: e.quantScore, combinedScore: e.combinedScore } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r != null);

    if (rows.length > 0) {
      const stockIds = [...new Set(rows.map((r) => r.stockId))];
      const bars = await db.priceBar.findMany({
        where: { stockId: { in: stockIds }, date: { gte: since } },
        select: { stockId: true, date: true, close: true },
      });
      const obs = buildObservations(
        rows,
        bars.map((b) => ({ stockId: b.stockId, session: dateStr(b.date), close: b.close })),
        DEFAULT_HORIZON
      );
      const health = signalHealth(obs);
      findings.push(...auditSignalHealth(health));
      const q = health.find((h) => h.source === "QUANT");
      // Only meaningful once the sample clears the same bars auditSignalHealth uses;
      // below that, null means "unknown" and the register assertion abstains.
      if (q && q.entry.n >= MIN_ENTRY_OBSERVATIONS && q.sessions >= MIN_SESSIONS) {
        quantEntryExcessBps = q.entry.meanExcess * 10_000;
      }
    }
  } catch (e) {
    errors.push(`Signal health check failed: ${String(e)}`);
  }

  // ── 7. The findings register re-checks itself ──────────────────────────────
  //
  // OPEN-FINDINGS.md asserts empirical facts in prose, and prose cannot notice when it
  // stops being true. Re-deriving the facts here means a claim that expired — usually
  // by being FIXED — surfaces as a prompt to edit the document, instead of sitting
  // there being trusted.
  try {
    const [labelledRmExits, cfgRow, staleMarked, rmEntries] = await Promise.all([
      db.simPosition.count({
        where: { strategy: { in: RM_STRATEGIES }, status: "CLOSED", exitReason: { not: null } },
      }),
      db.appSetting.findUnique({ where: { key: "tradingConfig" }, select: { key: true } }),
      db.simPosition.count({
        where: { status: "OPEN", lastMarkDate: { lt: new Date(todayUTC.getTime() - REGISTER_STALE_MARK_DAYS * 86_400_000) } },
      }),
      db.simPosition.count({
        where: {
          strategy: { in: RM_STRATEGIES },
          entryDate: { gte: new Date(todayUTC.getTime() - REGISTER_ENTRY_WINDOW_DAYS * 86_400_000) },
        },
      }),
    ]);

    const facts: RegisterFacts = {
      labelledRmExits,
      tradingConfigRowExists: cfgRow != null,
      staleMarkedPositions: staleMarked,
      staleMarkDays: REGISTER_STALE_MARK_DAYS,
      rmEntriesInWindow: rmEntries,
      entryWindowDays: REGISTER_ENTRY_WINDOW_DAYS,
      insufficientQtyErrors: (runLog?.errors ?? []).filter((e) => /insufficient qty/i.test(e)).length,
      quantEntryExcessBps,
    };
    findings.push(...auditFindingsRegister(facts));
  } catch (e) {
    errors.push(`Findings register check failed: ${String(e)}`);
  }

  // ── 8. Book equity, today vs yesterday ─────────────────────────────────────
  let books: DailyReviewReport["books"] = [];
  try {
    const wanted = ["ALPACA", ...ALL_STRATEGIES.map((s) => STRATEGY_BOOK[s])];
    const [todayRows, prevRows] = await Promise.all([
      db.paperEquitySnapshot.findMany({ where: { date: todayUTC, book: { in: wanted } } }),
      db.paperEquitySnapshot.findMany({
        where: { date: { lt: todayUTC }, book: { in: wanted } },
        orderBy: { date: "desc" },
        distinct: ["book"],
        select: { book: true, equity: true },
      }),
    ]);
    const prevByBook = new Map(prevRows.map((r) => [r.book, r.equity]));
    books = todayRows.map((r) => ({
      book: r.book,
      equity: r.equity,
      realizedPnl: r.realizedPnl,
      unrealizedPnl: r.unrealizedPnl,
      openPositions: r.openPositions,
      dayChange: prevByBook.has(r.book) ? r.equity - prevByBook.get(r.book)! : null,
    }));
  } catch (e) {
    errors.push(`Book summary failed: ${String(e)}`);
  }

  // Surface the review's own failures in the report — a check that didn't run is
  // not a check that passed, and the reader needs to know which is which.
  for (const err of errors) {
    findings.push({
      severity: "warn",
      code: "REVIEW_ERROR",
      title: "A review check could not complete",
      detail: err,
    });
  }

  const ranked = rankFindings(findings);
  const status = overallStatus(ranked);
  const report: DailyReviewReport = {
    version: 1,
    date: dateStr(todayUTC),
    generatedAt: now.toISOString(),
    status,
    summary: {
      findings: ranked.length,
      fails: ranked.filter((f) => f.severity === "fail").length,
      warns: ranked.filter((f) => f.severity === "warn").length,
      openPositions: openPositions.length,
      openedToday: openedToday.length,
      closedToday: closedToday.length,
      realizedToday: closedToday.reduce((s, p) => s + (p.realizedPnl ?? 0), 0),
      ordersSubmittedToday: ordersToday,
      replayed,
    },
    findings: ranked,
    strategies,
    books,
    notes,
  };

  let persisted = false;
  try {
    await db.dailyReview.upsert({
      where: { date: todayUTC },
      create: { date: todayUTC, report, status, findingCount: ranked.length },
      update: { report, status, findingCount: ranked.length },
    });
    persisted = true;
  } catch (e) {
    errors.push(`Review persist failed: ${String(e)}`);
    reportError("daily_review_persist_failed", e, { stage: "review" });
  }

  // Email the operators. Failures here are reported but never fail the stage — the
  // report is already durable and readable on the dashboard and via the API.
  if (isEmailConfigured()) {
    try {
      const admins = await db.user.findMany({
        where: { role: "ADMIN", alertEmails: true, email: { not: null } },
        select: { email: true },
      });
      const { subject, html, text } = buildReviewEmail(report);
      for (const a of admins) {
        if (!a.email) continue;
        const res = await sendEmail({ to: a.email, subject, html, text });
        if (!res.ok) errors.push(`Review email to ${a.email} failed: ${res.error}`);
      }
    } catch (e) {
      errors.push(`Review email failed: ${String(e)}`);
    }
  }

  // Interpret the report with an LLM and post it to Slack. Runs here — inside the
  // reliably-triggered review stage — rather than from a separate GitHub Actions cron,
  // whose drift/skips would make the Slack summary miss days (see review.yml). Gated on
  // `persisted` so a persist failure (which re-runs the whole stage next tick) can't
  // double-post. Best-effort, exactly like the email: never fails the stage.
  if (persisted && isReviewSlackConfigured()) {
    try {
      const recent = await db.dailyReview.findMany({
        where: { status: { not: null } },
        orderBy: { date: "desc" },
        take: 10,
        select: { date: true, status: true, findingCount: true },
      });
      const history = recent.map((r) => ({
        date: dateStr(r.date),
        status: r.status ?? "",
        findingCount: r.findingCount ?? 0,
      }));
      const res = await interpretAndPostReview(report, history);
      if (!res.ok) errors.push(`Review Slack post failed: ${res.error}`);
      else if (res.usedFallback) notes.push("Slack review posted with the deterministic fallback (LLM unavailable).");
    } catch (e) {
      errors.push(`Review Slack interpretation failed: ${String(e)}`);
    }
  }

  return { stage: "review", reviewed: true, status, findings: ranked.length, done: true, errors };
}
