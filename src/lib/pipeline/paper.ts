import { db } from "@/lib/db";
import { scoreToSignal } from "@/lib/indicators";
import {
  detectDrawdownBreach,
  detectOrderFailures,
  detectBrokerUnreachable,
  detectStalePipeline,
  detectMissedPaperDays,
  type AlertDraft,
} from "@/lib/alerts";
import {
  STRATEGIES,
  RM_STRATEGIES,
  STRATEGY_BOOK,
  STRATEGY_SOURCE,
  STRATEGY_IS_RM,
  reconcilePosition,
  reconcileRiskManaged,
  reconcileEventPosition,
  planBrokerAction,
  isRiskBooksEnabled,
  isInsiderBookEnabled,
  isBrokerStopsEnabled,
  utcDaysBetween,
  unrealizedPnl,
  confidenceNotional,
  riskSizedNotional,
  riskDistancePct,
  cents,
  realizedFromFills,
  isPaperTradeEligible,
  isEntrySignal,
  SIM_STARTING_EQUITY,
  type Strategy,
  type PositionAction,
} from "@/lib/paper-trading";
import {
  isRiskLimitsEnabled,
  evaluateBuy,
  regimeMultiplier,
  correlationClusters,
  clusterKeyFor,
  type BookExposure,
} from "@/lib/portfolio-risk";
import { loadTradingConfig } from "@/lib/trading-config";
import type { DecisionRecord, PaperRunLog } from "@/lib/daily-review";
import { buildConfidenceCalibrator, isConfCalibrationEnabled } from "@/lib/confidence-calibration";
import { PRIMARY_HORIZON, type CalibrationReport } from "@/lib/calibration-data";
import {
  isPaperTradingConfigured,
  getAccount,
  getPositions,
  submitMarketOrder,
  getOrder,
  getClock,
  getCalendar,
  getOpenOrders,
  cancelOrder,
  submitEntryWithStop,
  submitTrailingStop,
  submitStopSell,
  getAccountActivities,
  type AlpacaOpenOrder,
} from "@/lib/alpaca-trading";
import { reportError } from "@/lib/observability";
import { dateStr, processAccountAlerts, startOfUtcDay, universeWhere } from "./shared";

export type PaperStageResult = {
  stage: "paper";
  rebalanced: boolean; // false on the same-day no-op; true once it acts
  ordersSubmitted: number; // real Alpaca paper orders placed this run
  simOpened: number; // internal sim positions opened
  simClosed: number; // internal sim positions closed
  done: true;
  errors: string[];
};

// Terminal Alpaca order states — once an order reaches one, there's nothing left
// to reconcile, so it drops out of the pending-fill recheck.
const TERMINAL_ORDER_STATUS = new Set(["filled", "canceled", "cancelled", "expired", "rejected", "done_for_day", "replaced"]);

// ── Near-close trade window (PAPER_TRADE_NEAR_CLOSE) ──────────────────────────
// Act only in the final minutes before the US close: deepest liquidity of the day
// and aligns the live book with the sim books' close marks. When enabled, the whole
// paper stage no-ops out of the window WITHOUT writing the idempotency snapshot, so
// the day's first in-window run does the sim marks + live trades together.
function isTradeNearCloseEnabled(): boolean {
  return process.env.PAPER_TRADE_NEAR_CLOSE === "1";
}

// Static UTC fallback when the Alpaca clock isn't available (sim-only). Allows the
// window before BOTH possible UTC close times (20:00 EDT / 21:00 EST) on weekdays.
function withinStaticCloseWindow(now: Date, windowMin: number): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow = (close: number) => mins > close - windowMin && mins <= close;
  return inWindow(20 * 60) || inWindow(21 * 60);
}

// True when we're within `PAPER_TRADE_WINDOW_MIN` (default 30) minutes of the close.
// Prefers the broker clock (DST/holiday-proof); falls back to the static window.
async function inCloseWindow(): Promise<boolean> {
  const windowMin = Number(process.env.PAPER_TRADE_WINDOW_MIN) || 30;
  if (isPaperTradingConfigured()) {
    try {
      const clock = await getClock();
      if (!clock.isOpen || !clock.nextClose) return false;
      const minsToClose = (new Date(clock.nextClose).getTime() - Date.now()) / 60_000;
      return minsToClose > 0 && minsToClose <= windowMin;
    } catch {
      // clock fetch failed — fall back to the static window
    }
  }
  return withinStaticCloseWindow(new Date(), windowMin);
}

// ── Paper trading / signal performance ───────────────────────────────────────
//
// Acts on today's estimates with simulated long-only trades and tracks hypothetical
// P&L per signal source — sentiment, quant, and the combined estimate — to measure
// which predicts best (issue #14). Layers:
//   • SIM books (DB-only, always run): one mark-to-market book per pure signal.
//     Sizing is held constant (the estimate's confidence) so only the *signal* differs.
//   • SIM *_RM books (when PAPER_RISK_BOOKS=1): the same signals with a price-aware
//     exit overlay (stop-loss, trailing stop, confirmed-signal exit, min-hold,
//     time-stop) + a stricter entry. They measure the marginal value of risk
//     management without contaminating the pure attribution baseline.
//   • ALPACA book (only when paper keys are set): the combined signal mirrored with
//     REAL orders — the risk-managed combined decision when the flag is on, else the
//     pure combined signal — a fills-included reality check. With PAPER_BROKER_STOPS
//     it switches to whole-share entries with broker-enforced GTC stop / trailing
//     orders, so protective exits run continuously at the broker instead of once/day.
//
// When PAPER_TRADE_NEAR_CLOSE is set the whole stage only acts in the final minutes
// before the US close (deep liquidity; close-aligned marks) — see inCloseWindow.
//
// Idempotent per UTC day via the SIM_COMBINED equity snapshot: the 3-hourly
// pipeline.yml calls this after `estimate`, but it only acts on the first call each
// day. Single-shot (`done: true`); the watchlist is small enough for one pass and
// the wall-clock budget isn't needed, but errors are isolated so one bad ticker or
// an Alpaca hiccup never sinks the run. US-equities only (foreign/crypto filtered).
export async function runPaperStage(): Promise<PaperStageResult> {
  const errors: string[] = [];
  let ordersSubmitted = 0;
  let simOpened = 0;
  let simClosed = 0;
  // Account / trading-health alerts (issue #56) accumulated across the run, then
  // persisted + emailed to admins once at the end (the daily guard fires them once).
  const accountAlerts: AlertDraft[] = [];
  // Decision log for the post-close review: the exact inputs behind every call the
  // stage makes, so an hour later the pure reconcilers can be replayed against them
  // and diffed. Without it the review only sees state this stage already mutated.
  const decisions: DecisionRecord[] = [];

  const to = new Date();
  const todayUTC = startOfUtcDay(to);

  // Per-day idempotency guard: the SIM_COMBINED snapshot for today doubles as the
  // "already ran" marker, so repeat calls in the same day are cheap no-ops.
  const alreadyRan = await db.paperEquitySnapshot.findUnique({
    where: { book_date: { book: "SIM_COMBINED", date: todayUTC } },
    select: { id: true },
  });
  if (alreadyRan) {
    return { stage: "paper", rebalanced: false, ordersSubmitted, simOpened, simClosed, done: true, errors };
  }

  // Near-close gate: when enabled, out-of-window runs no-op WITHOUT writing the
  // idempotency snapshot, so the day's first in-window run does all the work.
  if (isTradeNearCloseEnabled() && !(await inCloseWindow())) {
    return { stage: "paper", rebalanced: false, ordersSubmitted, simOpened, simClosed, done: true, errors };
  }

  // Dead-man's check: any trading day between the previous snapshot and today with
  // no snapshot means the scheduler missed that day's whole trade window (the
  // July 2–3 2026 failure mode). Broker calendar filters out holidays when set.
  try {
    const prevSnap = await db.paperEquitySnapshot.findFirst({
      where: { book: "SIM_COMBINED", date: { lt: todayUTC } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (prevSnap) {
      let tradingDays: string[] | null = null;
      if (isPaperTradingConfigured()) {
        try {
          tradingDays = await getCalendar(prevSnap.date, todayUTC);
        } catch {
          // calendar unavailable → fall back to the weekday approximation
        }
      }
      const missedAlert = detectMissedPaperDays(prevSnap.date, todayUTC, tradingDays);
      if (missedAlert) accountAlerts.push(missedAlert);
    }
  } catch (e) {
    errors.push(`Missed-day check failed: ${String(e)}`);
  }

  // Today's estimates for watched stocks, newest first; dedupe to one per stock.
  const estimateRows = await db.stockEstimate.findMany({
    where: { date: { gte: todayUTC }, stock: universeWhere() },
    orderBy: { date: "desc" },
    select: {
      stockId: true,
      sentimentScore: true,
      quantScore: true,
      combinedScore: true,
      confidence: true,
      stock: { select: { ticker: true } },
    },
  });
  const estimates = [...new Map(estimateRows.map((e) => [e.stockId, e])).values()].filter((e) =>
    isPaperTradeEligible(e.stock.ticker)
  );

  // Mark price = latest QuantAnalysis close per stock (already computed by the quant
  // stage). No price → the stock can't be marked/sized, so it's skipped this run.
  const stockIds = estimates.map((e) => e.stockId);
  const quantRows =
    stockIds.length > 0
      ? await db.quantAnalysis.findMany({
          where: { stockId: { in: stockIds }, price: { not: null } },
          orderBy: { date: "desc" },
          distinct: ["stockId"],
          select: { stockId: true, price: true, atrPct: true },
        })
      : [];
  const priceByStock = new Map(quantRows.map((q) => [q.stockId, q.price!]));
  // ATR% (volatility) per stock — lets the _RM books scale stops to each name's
  // regime. Absent for new/illiquid names; the overlay falls back to fixed pcts.
  const atrPctByStock = new Map(quantRows.map((q) => [q.stockId, q.atrPct]));

  // ── Sim books ──────────────────────────────────────────────────────────────
  // Pure books (signal-only) always run. The risk-managed (_RM) variants run only
  // when PAPER_RISK_BOOKS=1; the same flag points the live Alpaca book at the
  // risk-managed combined signal below (else it mirrors the pure combined signal).
  const riskEnabled = isRiskBooksEnabled();
  // Strategy knobs: DB-backed overrides (admin page) merged over env vars and code
  // defaults. Bad stored values degrade per-field to env/default and are surfaced.
  const { risk: cfg, limits, issues: configIssues } = await loadTradingConfig();
  if (configIssues.length > 0) errors.push(`Trading config: ${configIssues.join("; ")}`);
  const activeStrategies: Strategy[] = riskEnabled ? [...STRATEGIES, ...RM_STRATEGIES] : STRATEGIES;

  // Reliability-based confidence recalibration (PAPER_CONF_CALIBRATION=1): adjust
  // the sizing/entry confidence of the _RM + live books by how each stated-
  // confidence bucket has actually performed (gate-horizon reliability diagram from
  // the latest calibrate snapshot). Identity map unless the data passes the trust
  // gates. The pure books ALWAYS keep the raw confidence — attribution baseline.
  let confCalibrator = buildConfidenceCalibrator(null);
  if (riskEnabled && isConfCalibrationEnabled()) {
    try {
      const snap = await db.calibrationSnapshot.findFirst({ orderBy: { date: "desc" }, select: { report: true } });
      const report = snap?.report as CalibrationReport | undefined;
      const rel = report?.horizons?.find((h) => h.horizon === PRIMARY_HORIZON)?.reliability ?? null;
      confCalibrator = buildConfidenceCalibrator(rel);
    } catch (e) {
      errors.push(`Confidence calibration load failed (raw confidence used): ${String(e)}`);
    }
  }

  // The live Alpaca book mirrors the COMBINED_RM book's open/flat decision (when the
  // flag is on), so the real fills track the same risk-managed signal the sim does.
  const combinedRmLong = new Set<string>(); // stockIds long after this run
  const combinedRmOpened = new Set<string>(); // fresh OPEN this run (drives broker entries + re-entry guard)
  const combinedRmExit = new Map<string, string>(); // stockId → exit reason on close

  // Index open positions by (stock, strategy) for O(1) reconciliation.
  const openPositions = await db.simPosition.findMany({
    where: { status: "OPEN", stockId: { in: stockIds.length > 0 ? stockIds : ["__none__"] } },
    select: {
      id: true,
      stockId: true,
      strategy: true,
      qty: true,
      entryPrice: true,
      entryDate: true,
      lastMarkDate: true,
      peakPrice: true,
      bearishStreak: true,
      staleStreak: true,
      entryAtrPct: true,
    },
  });
  const openByKey = new Map(openPositions.map((p) => [`${p.stockId}|${p.strategy}`, p]));

  // ── Portfolio-level risk controls (issue #56; ship-dark: PAPER_RISK_LIMITS=1) ──
  // Per-position stops protect each name; these caps + the drawdown kill-switch
  // protect the *book* from a correlated blow-up that gaps through every stop at
  // once. They gate fresh opens in the risk-managed (_RM) sim books and the live
  // Alpaca buys below; the pure books stay the unconstrained attribution baseline.
  const riskLimitsOn = isRiskLimitsEnabled();
  // Rolling window for the kill-switch peak (all-time when 0): an all-time peak
  // never resets, so a book that once drew down 20% could be halted forever.
  const peakSince =
    limits.peakWindowDays > 0 ? new Date(todayUTC.getTime() - limits.peakWindowDays * 86_400_000) : undefined;
  const peakDateFilter = peakSince ? { date: { gte: peakSince } } : {};
  const tickerByStock = new Map(estimates.map((e) => [e.stockId, e.stock.ticker]));

  // Stale-pipeline health check: the freshest estimate anywhere vs now.
  if (riskLimitsOn) {
    try {
      const fresh = await db.stockEstimate.findFirst({ orderBy: { date: "desc" }, select: { date: true } });
      const staleHours = Number(process.env.PAPER_STALE_DATA_HOURS) || 48;
      const a = detectStalePipeline(fresh?.date ?? null, to, staleHours);
      if (a) accountAlerts.push(a);
    } catch (e) {
      errors.push(`Stale-pipeline check failed: ${String(e)}`);
    }
  }

  // Regime filter (issue #58): while SPY sits below its moving average, the gross
  // cap is scaled by regimeRiskOffGrossFrac — long-only books make most of their
  // drawdown in bear markets. Neutral (1) until enough SPY history exists for the
  // MA, and on any error: the filter only ever tightens on an OBSERVED downtrend.
  let regimeMult = 1;
  if (riskLimitsOn && limits.regimeMaWindow > 0) {
    try {
      const spy = await db.stock.findUnique({ where: { ticker: "SPY" }, select: { id: true } });
      const closes = spy
        ? await db.quantAnalysis.findMany({
            where: { stockId: spy.id, price: { not: null } },
            orderBy: { date: "desc" },
            take: limits.regimeMaWindow,
            select: { price: true },
          })
        : [];
      if (closes.length >= limits.regimeMaWindow) {
        const ma = closes.reduce((s, r) => s + r.price!, 0) / closes.length;
        regimeMult = regimeMultiplier(closes[0].price, ma, limits.regimeRiskOffGrossFrac);
      }
    } catch (e) {
      errors.push(`Regime filter failed (treated as risk-on): ${String(e)}`);
    }
  }

  // Correlation clusters across the watchlist (crypto = one bucket) so the cluster
  // cap limits *correlated* exposure, not just per-ticker. Built from recent closes.
  let clusterByTicker = new Map<string, string>();
  if (riskLimitsOn && stockIds.length > 0) {
    try {
      const since = new Date(todayUTC.getTime() - 45 * 86_400_000);
      const hist = await db.quantAnalysis.findMany({
        where: { stockId: { in: stockIds }, price: { not: null }, date: { gte: since } },
        orderBy: { date: "asc" },
        select: { stockId: true, date: true, price: true },
      });
      const pricesByStock = new Map<string, { date: string; price: number }[]>();
      for (const r of hist) {
        const arr = pricesByStock.get(r.stockId) ?? [];
        arr.push({ date: dateStr(r.date), price: r.price! });
        pricesByStock.set(r.stockId, arr);
      }
      const returnsByTicker = new Map<string, Map<string, number>>();
      for (const [sid, rows] of pricesByStock) {
        const ticker = tickerByStock.get(sid);
        if (!ticker) continue;
        const rets = new Map<string, number>();
        for (let i = 1; i < rows.length; i++) {
          const prev = rows[i - 1].price;
          if (prev > 0) rets.set(rows[i].date, rows[i].price / prev - 1);
        }
        if (rets.size > 0) returnsByTicker.set(ticker, rets);
      }
      clusterByTicker = correlationClusters(returnsByTicker);
    } catch (e) {
      errors.push(`Risk cluster build failed: ${String(e)}`);
    }
  }

  // Seed per-_RM-book exposure (open positions + equity + peak) so evaluateBuy can
  // gate fresh opens, and flag a simulated drawdown breach on the gated book.
  const bookRisk = new Map<Strategy, BookExposure>();
  if (riskLimitsOn && riskEnabled) {
    try {
      const [rmOpen, rmClosedSum, snapMax] = await Promise.all([
        db.simPosition.findMany({
          where: { status: "OPEN", strategy: { in: RM_STRATEGIES } },
          select: { strategy: true, qty: true, entryPrice: true, lastMarkPrice: true, stock: { select: { ticker: true } } },
        }),
        db.simPosition.groupBy({
          by: ["strategy"],
          where: { status: "CLOSED", strategy: { in: RM_STRATEGIES } },
          _sum: { realizedPnl: true },
        }),
        db.paperEquitySnapshot.groupBy({
          by: ["book"],
          where: { book: { in: RM_STRATEGIES.map((s) => STRATEGY_BOOK[s]) }, ...peakDateFilter },
          _max: { equity: true },
        }),
      ]);
      const realizedByStrategy = new Map(rmClosedSum.map((r) => [r.strategy as Strategy, r._sum.realizedPnl ?? 0]));
      const peakByBook = new Map(snapMax.map((r) => [r.book, r._max.equity ?? 0]));
      for (const strategy of RM_STRATEGIES) {
        const positions = rmOpen
          .filter((p) => p.strategy === strategy)
          .map((p) => {
            const mark = p.lastMarkPrice ?? p.entryPrice;
            return { cluster: clusterKeyFor(p.stock.ticker, clusterByTicker), notional: p.qty * mark, unrealized: p.qty * (mark - p.entryPrice) };
          });
        const unrealized = positions.reduce((s, p) => s + p.unrealized, 0);
        const equity = SIM_STARTING_EQUITY + (realizedByStrategy.get(strategy) ?? 0) + unrealized;
        const peakEquity = Math.max(peakByBook.get(STRATEGY_BOOK[strategy]) ?? 0, equity);
        bookRisk.set(strategy, { equity, peakEquity, positions: positions.map((p) => ({ cluster: p.cluster, notional: p.notional })) });
      }
      const gated = bookRisk.get("COMBINED_RM");
      if (gated && gated.peakEquity > 0) {
        const dd = Math.max(0, (gated.peakEquity - gated.equity) / gated.peakEquity);
        const a = detectDrawdownBreach("SIM_COMBINED_RM", dd, limits.killSwitchDrawdownPct);
        if (a) accountAlerts.push(a);
      }
    } catch (e) {
      errors.push(`Risk book seeding failed: ${String(e)}`);
    }
  }

  for (const est of estimates) {
    const price = priceByStock.get(est.stockId);
    if (price == null) continue;
    const atrPct = atrPctByStock.get(est.stockId) ?? null;
    // Empirically adjusted confidence for the _RM books (identity when the
    // calibrator is off/untrusted). Pure books keep est.confidence untouched.
    const rmConfidence = confCalibrator.calibrate(est.confidence);
    const sourceScores = {
      SENTIMENT: est.sentimentScore,
      QUANT: est.quantScore,
      COMBINED: est.combinedScore,
    } as const;

    for (const strategy of activeStrategies) {
      const score = sourceScores[STRATEGY_SOURCE[strategy]];
      if (score == null) continue; // e.g. QUANT/QUANT_RM with no quant score
      const signal = scoreToSignal(score);
      const open = openByKey.get(`${est.stockId}|${strategy}`) ?? null;

      // The open state as the reconciler sees it — captured here so the decision log
      // records the inputs rather than the post-run state they get overwritten with.
      const openState = open
        ? {
            qty: open.qty,
            entryPrice: open.entryPrice,
            peakPrice: open.peakPrice ?? open.entryPrice,
            bearishStreak: open.bearishStreak,
            staleStreak: open.staleStreak,
            entryAtrPct: open.entryAtrPct,
          }
        : null;
      const runsSinceEntry = open ? utcDaysBetween(open.entryDate, todayUTC) : 0;
      // First action today? The streak only advances on a new UTC day, so a
      // same-day retry (after a partial failure) can't double-count it.
      const isNewRun = open ? startOfUtcDay(open.lastMarkDate) < todayUTC : true;
      const decisionConfidence = STRATEGY_IS_RM[strategy] ? rmConfidence : est.confidence;

      let action: PositionAction;
      if (STRATEGY_IS_RM[strategy]) {
        action = reconcileRiskManaged({
          score,
          signal,
          price,
          confidence: rmConfidence,
          atrPct,
          runsSinceEntry,
          isNewRun,
          open: openState,
          cfg,
        });
      } else {
        action = reconcilePosition(signal, price, est.confidence, open);
      }

      // Log the rules' verdict before the portfolio gate can override it, so the
      // replay compares like with like; `riskBlocked` records the override itself.
      const decision: DecisionRecord = {
        stockId: est.stockId,
        ticker: est.stock.ticker,
        strategy,
        inputs: {
          score,
          signal,
          price,
          confidence: decisionConfidence,
          atrPct,
          runsSinceEntry,
          isNewRun,
          open: openState,
        },
        action:
          action.type === "OPEN"
            ? { type: "OPEN", qty: action.qty, price: action.price }
            : action.type === "CLOSE"
              ? { type: "CLOSE", price: action.price, reason: action.reason ?? null }
              : { type: action.type },
      };
      decisions.push(decision);

      // Portfolio-level gate: block a fresh _RM open that would breach a cap or the
      // drawdown kill-switch. Must run before the COMBINED_RM capture so a blocked
      // open isn't mirrored to the live Alpaca book either. Pure books are unaffected.
      if (riskLimitsOn && action.type === "OPEN" && STRATEGY_IS_RM[strategy]) {
        const br = bookRisk.get(strategy);
        if (br) {
          const candidate = { cluster: clusterKeyFor(est.stock.ticker, clusterByTicker), notional: action.qty * action.price };
          if (evaluateBuy(br, candidate, limits, regimeMult).allowed) {
            br.positions.push(candidate); // reserve so later opens this run see it
          } else {
            action = { type: "NONE" };
            decision.riskBlocked = true;
          }
        }
      }

      // Capture the COMBINED_RM decision so the Alpaca book can mirror it.
      if (strategy === "COMBINED_RM") {
        if (action.type === "OPEN") combinedRmOpened.add(est.stockId);
        if (action.type === "OPEN" || action.type === "MARK") combinedRmLong.add(est.stockId);
        else if (action.type === "CLOSE" && action.reason) combinedRmExit.set(est.stockId, action.reason);
      }

      try {
        if (action.type === "OPEN") {
          await db.simPosition.create({
            data: {
              stockId: est.stockId,
              strategy,
              status: "OPEN",
              qty: action.qty,
              entryDate: to,
              entryPrice: action.price,
              // Persist the confidence that actually sized the position.
              confidence: decisionConfidence,
              // The justification for the entry, frozen here: today's estimate row
              // gets overwritten, so a later join can't recover what we acted on.
              entrySignal: signal,
              entryScore: score,
              lastMarkDate: to,
              lastMarkPrice: action.price,
              peakPrice: action.price,
              // Freeze the entry-day ATR so exit distances never widen with a
              // later volatility spike (only meaningful on the _RM books).
              ...(STRATEGY_IS_RM[strategy] ? { entryAtrPct: atrPct } : {}),
            },
          });
          simOpened++;
        } else if (action.type === "CLOSE" && open) {
          await db.simPosition.update({
            where: { id: open.id },
            data: {
              status: "CLOSED",
              exitDate: to,
              exitPrice: action.price,
              realizedPnl: action.realizedPnl,
              lastMarkDate: to,
              lastMarkPrice: action.price,
              // The pure books have only one way out — the signal flipped off a buy —
              // so they carry SIGNAL; the _RM ladder names the rung that fired.
              exitReason: action.reason ?? "SIGNAL",
            },
          });
          simClosed++;
        } else if (action.type === "MARK" && open) {
          await db.simPosition.update({
            where: { id: open.id },
            data: {
              lastMarkDate: to,
              lastMarkPrice: action.price,
              // _RM marks carry updated trailing-peak + bearish/stale-streak state.
              ...(action.peakPrice != null ? { peakPrice: action.peakPrice } : {}),
              ...(action.bearishStreak != null ? { bearishStreak: action.bearishStreak } : {}),
              ...(action.staleStreak != null ? { staleStreak: action.staleStreak } : {}),
            },
          });
        }
      } catch (e) {
        errors.push(`Sim ${strategy} failed for ${est.stock.ticker}: ${String(e)}`);
      }
    }
  }

  // Per-book equity snapshot from the full position history (cumulative realized +
  // current unrealized). The SIM_COMBINED row doubles as the idempotency marker, so
  // it must land only once the day's reconciliation has succeeded.
  const snapshotStrategy = async (strategy: Strategy) => {
    try {
      // Closed history only matters as Σrealized here — aggregate it in the DB
      // instead of loading every closed row (this runs per book, every day).
      const [closedAgg, open] = await Promise.all([
        db.simPosition.aggregate({ where: { strategy, status: "CLOSED" }, _sum: { realizedPnl: true } }),
        db.simPosition.findMany({
          where: { strategy, status: "OPEN" },
          select: { qty: true, entryPrice: true, lastMarkPrice: true },
        }),
      ]);
      const realized = closedAgg._sum.realizedPnl ?? 0;
      const unrealized = open.reduce(
        (s, p) => s + unrealizedPnl(p.qty, p.entryPrice, p.lastMarkPrice ?? p.entryPrice),
        0
      );
      const book = STRATEGY_BOOK[strategy];
      const data = {
        equity: SIM_STARTING_EQUITY + realized + unrealized,
        realizedPnl: realized,
        unrealizedPnl: unrealized,
        openPositions: open.length,
      };
      await db.paperEquitySnapshot.upsert({
        where: { book_date: { book, date: todayUTC } },
        create: { book, date: todayUTC, ...data },
        update: data,
      });
    } catch (e) {
      errors.push(`Equity snapshot failed for ${strategy}: ${String(e)}`);
    }
  };
  // ── Insider event book (issue #57; ship-dark: PAPER_INSIDER_BOOK=1) ─────────
  // Event-driven, NOT estimate-driven: open on an insider cluster-buy / C-suite-buy
  // alert (fired by the insider stage), hold a fixed multi-week period, close on
  // expiry — time is the only exit, so the book measures the event's raw drift.
  // Runs before the snapshots so SIM_INSIDER gets today's equity point too.
  if (isInsiderBookEnabled()) {
    try {
      const eventSince = new Date(todayUTC.getTime() - 3 * 86_400_000); // covers weekends/missed days
      const [events, insiderOpen] = await Promise.all([
        db.alert.findMany({
          where: {
            type: { in: ["INSIDER_CLUSTER_BUY", "INSIDER_CSUITE_BUY"] },
            createdAt: { gte: eventSince },
            stockId: { not: null },
          },
          select: { stockId: true, stock: { select: { ticker: true } } },
        }),
        db.simPosition.findMany({
          where: { strategy: "INSIDER", status: "OPEN" },
          select: { id: true, stockId: true, qty: true, entryPrice: true, entryDate: true },
        }),
      ]);
      // Mark prices for every stock the book touches (open positions may be on
      // names outside today's estimate set, so priceByStock can't be reused).
      const insiderStockIds = [...new Set([...events.map((e) => e.stockId!), ...insiderOpen.map((p) => p.stockId)])];
      const insiderQuant =
        insiderStockIds.length > 0
          ? await db.quantAnalysis.findMany({
              where: { stockId: { in: insiderStockIds }, price: { not: null } },
              orderBy: { date: "desc" },
              distinct: ["stockId"],
              select: { stockId: true, price: true },
            })
          : [];
      const insiderPrice = new Map(insiderQuant.map((q) => [q.stockId, q.price!]));

      // Manage open positions: close on hold expiry, else mark to the latest close.
      for (const p of insiderOpen) {
        const price = insiderPrice.get(p.stockId);
        if (price == null) continue; // no price → carry as-is; next run retries
        const action = reconcileEventPosition(price, utcDaysBetween(p.entryDate, todayUTC), cfg.insiderHoldDays, p);
        try {
          if (action.type === "CLOSE") {
            await db.simPosition.update({
              where: { id: p.id },
              // Time is the event book's only exit, so the rung is never ambiguous.
              data: { status: "CLOSED", exitDate: to, exitPrice: action.price, realizedPnl: action.realizedPnl, lastMarkDate: to, lastMarkPrice: action.price, exitReason: "HOLD_EXPIRY" },
            });
            simClosed++;
          } else if (action.type === "MARK") {
            await db.simPosition.update({ where: { id: p.id }, data: { lastMarkDate: to, lastMarkPrice: action.price } });
          }
        } catch (e) {
          errors.push(`Insider book update failed for ${p.stockId}: ${String(e)}`);
        }
      }

      // Fresh events → open flat-sized positions (one per stock; re-triggering
      // alerts on an already-open name are ignored).
      const alreadyOpen = new Set(insiderOpen.map((p) => p.stockId));
      const tickerById = new Map(events.map((e) => [e.stockId!, e.stock!.ticker]));
      for (const stockId of new Set(events.map((e) => e.stockId!))) {
        if (alreadyOpen.has(stockId)) continue;
        const ticker = tickerById.get(stockId);
        const price = insiderPrice.get(stockId);
        if (!ticker || !isPaperTradeEligible(ticker) || price == null || price <= 0) continue;
        try {
          await db.simPosition.create({
            data: {
              stockId,
              strategy: "INSIDER",
              status: "OPEN",
              qty: cfg.insiderNotional / price,
              entryDate: to,
              entryPrice: price,
              confidence: 1, // flat sizing — the event itself is the conviction
              lastMarkDate: to,
              lastMarkPrice: price,
            },
          });
          simOpened++;
          alreadyOpen.add(stockId);
        } catch (e) {
          errors.push(`Insider book open failed for ${ticker}: ${String(e)}`);
        }
      }
    } catch (e) {
      errors.push(`Insider event book failed: ${String(e)}`);
    }
  }

  // _RM books first (when enabled), then the event + pure books — so SIM_COMBINED,
  // the idempotency marker, is still written last.
  if (riskEnabled) for (const strategy of RM_STRATEGIES) await snapshotStrategy(strategy);
  if (isInsiderBookEnabled()) await snapshotStrategy("INSIDER");
  for (const strategy of STRATEGIES) await snapshotStrategy(strategy);

  // ── Alpaca book (only when paper keys are configured) ──────────────────────
  if (isPaperTradingConfigured()) {
    try {
      // Reconcile fills for orders still pending from a previous run.
      const pending = await db.paperOrder.findMany({
        where: { alpacaOrderId: { not: null } },
        orderBy: { submittedAt: "desc" },
        take: 100,
        select: { id: true, alpacaOrderId: true, status: true },
      });
      for (const o of pending) {
        if (TERMINAL_ORDER_STATUS.has(o.status)) continue;
        try {
          const remote = await getOrder(o.alpacaOrderId!);
          await db.paperOrder.update({
            where: { id: o.id },
            data: {
              status: remote.status,
              filledQty: remote.filledQty,
              filledAvgPrice: remote.filledAvgPrice,
              filledAt: remote.filledAt ? new Date(remote.filledAt) : null,
            },
          });
        } catch (e) {
          errors.push(`Order reconcile failed (${o.alpacaOrderId}): ${String(e)}`);
        }
      }

      // Desired state per stock. Two modes:
      //  • Broker stops ON: entries go in as whole-share marketable-limit buys with a
      //    broker-enforced GTC stop; the broker handles the stop/trailing exits
      //    intraday, so the stage only places signal/time exits and arms/repairs the
      //    protective order. Driven by COMBINED_RM transitions (see planBrokerAction).
      //  • OFF: the live account mirrors the COMBINED_RM (or pure combined) signal with
      //    plain notional market orders — the original behavior, unchanged.
      const brokerStops = isBrokerStopsEnabled() && riskEnabled;
      const positions = await getPositions();
      const posBySymbol = new Map(positions.map((p) => [p.symbol, p]));

      // Live-account risk context for the buy gate + drawdown alert (ship-dark).
      let alpacaRisk: BookExposure | null = null;
      let alpacaOrderFailures = 0;
      if (riskLimitsOn) {
        try {
          const [acct, snap] = await Promise.all([
            getAccount(),
            db.paperEquitySnapshot.aggregate({ where: { book: "ALPACA", ...peakDateFilter }, _max: { equity: true } }),
          ]);
          const equity = acct.equity ?? 0;
          const peakEquity = Math.max(snap._max.equity ?? 0, equity);
          alpacaRisk = {
            equity,
            peakEquity,
            positions: positions.map((p) => ({
              cluster: clusterKeyFor(p.symbol, clusterByTicker),
              notional: Math.abs(p.qty) * (p.currentPrice ?? p.avgEntryPrice ?? 0),
            })),
          };
          if (peakEquity > 0) {
            const a = detectDrawdownBreach("ALPACA", Math.max(0, (peakEquity - equity) / peakEquity), limits.killSwitchDrawdownPct);
            if (a) accountAlerts.push(a);
          }
        } catch (e) {
          errors.push(`Alpaca risk context failed: ${String(e)}`);
        }
      }
      // Gate a live buy through the portfolio caps + kill-switch, reserving exposure
      // when allowed. A no-op (always allows) when the risk limits are off.
      const gateAlpacaBuy = (symbol: string, notional: number): boolean => {
        if (!riskLimitsOn || !alpacaRisk) return true;
        const candidate = { cluster: clusterKeyFor(symbol, clusterByTicker), notional };
        if (!evaluateBuy(alpacaRisk, candidate, limits, regimeMult).allowed) return false;
        alpacaRisk.positions.push(candidate);
        return true;
      };

      if (brokerStops) {
        // One pass over the broker's resting orders → the protective order per symbol.
        let openOrders: AlpacaOpenOrder[] = [];
        try {
          openOrders = await getOpenOrders();
        } catch (e) {
          errors.push(`Alpaca open-orders fetch failed: ${String(e)}`);
        }
        const protectiveBySymbol = new Map<string, AlpacaOpenOrder>();
        for (const o of openOrders) {
          if (o.side === "sell" && (o.type === "stop" || o.type === "trailing_stop")) protectiveBySymbol.set(o.symbol, o);
        }
        // Symbols the estimates loop below touches (entered, exited, armed, or
        // repaired) — the final safety-net sweep skips these so it never double-places
        // a protective order on a name we just handled.
        const managedSymbols = new Set<string>();

        // Has the broker already placed an entry for each COMBINED_RM episode? A BUY
        // order dated at/after the sim's entry means yes — so if the broker is now flat
        // in it, it was exited/stopped out and the re-entry guard must leave it alone.
        // No such order means the entry never took hold (risk-gated, or a sub-share
        // that has since grown), which planBrokerAction may then *catch up*.
        const rmOpens = openPositions.filter((p) => p.strategy === "COMBINED_RM");
        const everAttemptedByStock = new Map<string, boolean>();
        if (rmOpens.length > 0) {
          const rmEntryByStock = new Map(rmOpens.map((p) => [p.stockId, p.entryDate]));
          const buys = await db.paperOrder.findMany({
            where: { side: "BUY", stockId: { in: rmOpens.map((p) => p.stockId) } },
            select: { stockId: true, submittedAt: true },
            orderBy: { submittedAt: "desc" },
          });
          const lastBuyByStock = new Map<string, Date>();
          for (const b of buys) if (!lastBuyByStock.has(b.stockId)) lastBuyByStock.set(b.stockId, b.submittedAt);
          for (const [stockId, entryDate] of rmEntryByStock) {
            const last = lastBuyByStock.get(stockId);
            everAttemptedByStock.set(stockId, last != null && last >= entryDate);
          }
        }

        for (const est of estimates) {
          const ticker = est.stock.ticker;
          const price = priceByStock.get(est.stockId);
          if (price == null) continue;
          const held = posBySymbol.get(ticker);
          const protective = protectiveBySymbol.get(ticker) ?? null;
          // Frozen distances for a held name (its sim twin's entry-day ATR);
          // today's ATR only when sizing a fresh entry (no sim row yet).
          const rmOpen = openByKey.get(`${est.stockId}|COMBINED_RM`);
          const action = planBrokerAction({
            opened: combinedRmOpened.has(est.stockId),
            stillLong: combinedRmLong.has(est.stockId),
            exitReason: combinedRmExit.get(est.stockId) ?? null,
            held: !!held,
            everAttempted: everAttemptedByStock.get(est.stockId) ?? true,
            avgEntryPrice: held?.avgEntryPrice ?? null,
            currentPrice: held?.currentPrice ?? null,
            restingProtectiveType: protective?.type === "trailing_stop" ? "trailing_stop" : protective ? "stop" : null,
            restingTrailPercent: protective?.trailPercent ?? null,
            price,
            atrPct: rmOpen ? rmOpen.entryAtrPct : atrPctByStock.get(est.stockId) ?? null,
            confidence: confCalibrator.calibrate(est.confidence),
            cfg,
          });
          try {
            if (action.type === "ENTER" && gateAlpacaBuy(ticker, action.qty * price)) {
              const { order, stopOrderId } = await submitEntryWithStop({
                symbol: ticker,
                qty: action.qty,
                limitPrice: action.limitPrice,
                stopPrice: action.stopPrice,
              });
              await db.paperOrder.create({
                data: { stockId: est.stockId, side: "BUY", signal: scoreToSignal(est.combinedScore), qty: action.qty, alpacaOrderId: order.id, status: order.status },
              });
              if (stopOrderId) {
                // Record the protective leg so the pending-fill reconcile loop catches
                // a broker stop-out (and a cancel/replace) with no extra code.
                await db.paperOrder.create({
                  data: { stockId: est.stockId, side: "SELL", signal: "STOP", qty: action.qty, alpacaOrderId: stopOrderId, status: "held" },
                });
              }
              managedSymbols.add(ticker);
              ordersSubmitted++;
            } else if (action.type === "EXIT" && held) {
              if (protective) await cancelOrder(protective.id);
              const qty = Math.abs(held.qty);
              const order = await submitMarketOrder({ symbol: ticker, side: "sell", qty });
              await db.paperOrder.create({
                data: { stockId: est.stockId, side: "SELL", signal: action.reason, qty, alpacaOrderId: order.id, status: order.status },
              });
              managedSymbols.add(ticker);
              ordersSubmitted++;
            } else if (action.type === "ARM_TRAILING" && held && protective) {
              // Protective (stop/trailing) orders must be whole-share — Alpaca rejects
              // them on fractional qty. Floor; skip if under one share (a legacy
              // fractional position keeps its market-sell exit, just no broker stop).
              const qty = Math.floor(Math.abs(held.qty));
              if (qty >= 1) {
                await cancelOrder(protective.id);
                const order = await submitTrailingStop({ symbol: ticker, qty, trailPercent: action.trailPercent });
                await db.paperOrder.create({
                  data: { stockId: est.stockId, side: "SELL", signal: "TRAIL", qty, alpacaOrderId: order.id, status: order.status },
                });
                managedSymbols.add(ticker);
                ordersSubmitted++;
              }
            } else if (action.type === "REPAIR_STOP" && held) {
              const qty = Math.floor(Math.abs(held.qty));
              if (qty >= 1) {
                const order = await submitStopSell({ symbol: ticker, qty, stopPrice: action.stopPrice });
                await db.paperOrder.create({
                  data: { stockId: est.stockId, side: "SELL", signal: "STOP", qty, alpacaOrderId: order.id, status: order.status },
                });
                managedSymbols.add(ticker);
                ordersSubmitted++;
              }
            }
          } catch (e) {
            alpacaOrderFailures++;
            errors.push(`Alpaca broker action failed for ${ticker}: ${String(e)}`);
          }
        }

        // Reconcile sweep: the loop above only visits names with a fresh estimate
        // today, so any held position that produced no estimate this run (no fresh
        // news/quant, or dropped from the watched universe) is invisible to it — its
        // exit never reaches the broker and its missing stop is never repaired. Sweep
        // every held position the loop didn't manage against the ACTUAL COMBINED_RM sim
        // state (not just today's estimates):
        //   • sim flat  → orphan: the strategy has exited but the broker still holds it,
        //                 so flatten it (cancel any resting stop, then market-sell).
        //   • sim long, no protective order → repair a missing stop.
        // A price exit (STOP/TRAIL) closes the sim position, so this is also the belt
        // that flattens a name whose broker stop failed to fire.
        const unmanaged = [...posBySymbol.keys()].filter((symbol) => !managedSymbols.has(symbol));
        if (unmanaged.length > 0) {
          const fallbackStopPct = riskDistancePct(cfg, null, cfg.stopLossPct);
          // Resolve stockIds for every held ticker (PaperOrder.stockId is required),
          // including off-universe names absent from today's estimates.
          const sweepStocks = await db.stock.findMany({
            where: { ticker: { in: unmanaged } },
            select: { id: true, ticker: true },
          });
          const stockIdByTicker = new Map(sweepStocks.map((s) => [s.ticker, s.id]));
          // Which of these does the strategy still want? An OPEN COMBINED_RM sim row.
          const stockIds = [...stockIdByTicker.values()];
          const simOpenRows =
            stockIds.length > 0
              ? await db.simPosition.findMany({
                  where: { strategy: "COMBINED_RM", status: "OPEN", stockId: { in: stockIds } },
                  select: { stockId: true },
                })
              : [];
          const simOpenStockIds = new Set(simOpenRows.map((r) => r.stockId));

          for (const symbol of unmanaged) {
            const pos = posBySymbol.get(symbol)!;
            const stockId = stockIdByTicker.get(symbol);
            const simLong = stockId != null && simOpenStockIds.has(stockId);
            const protective = protectiveBySymbol.get(symbol) ?? null;
            try {
              if (!simLong) {
                // Orphan → flatten. Market-sell takes the whole position (fractional is
                // fine, unlike a stop), after cancelling any resting protective order.
                if (protective) await cancelOrder(protective.id);
                const qty = Math.abs(pos.qty);
                const order = await submitMarketOrder({ symbol, side: "sell", qty });
                if (stockId) {
                  await db.paperOrder.create({
                    data: { stockId, side: "SELL", signal: "ORPHAN_EXIT", qty, alpacaOrderId: order.id, status: order.status },
                  });
                } else {
                  errors.push(`Orphan-exit sold ${symbol} but found no Stock row to record it`);
                }
                ordersSubmitted++;
              } else if (!protective) {
                // Sim still wants it, but nothing is protecting it → repair the stop.
                const qty = Math.floor(Math.abs(pos.qty));
                if (qty < 1) continue; // whole-share only (Alpaca rejects fractional stops)
                const anchor = pos.avgEntryPrice ?? pos.currentPrice;
                if (anchor == null || anchor <= 0) continue;
                const order = await submitStopSell({ symbol, qty, stopPrice: cents(anchor * (1 - fallbackStopPct)) });
                if (stockId) {
                  await db.paperOrder.create({
                    data: { stockId, side: "SELL", signal: "STOP", qty, alpacaOrderId: order.id, status: order.status },
                  });
                } else {
                  errors.push(`Protective-stop sweep placed a stop for ${symbol} but found no Stock row to record it`);
                }
                ordersSubmitted++;
              }
            } catch (e) {
              alpacaOrderFailures++;
              errors.push(`Alpaca reconcile sweep failed for ${symbol}: ${String(e)}`);
            }
          }
        }
      } else {
        for (const est of estimates) {
          const ticker = est.stock.ticker;
          const combinedSignal = scoreToSignal(est.combinedScore);
          const held = posBySymbol.get(ticker);
          const wantLong = riskEnabled ? combinedRmLong.has(est.stockId) : isEntrySignal(combinedSignal);
          // Label a sell with the risk-managed exit reason (STOP/TRAIL/…) when present.
          const sellSignal = riskEnabled ? combinedRmExit.get(est.stockId) ?? combinedSignal : combinedSignal;
          try {
            if (wantLong && !held) {
              // Mirror the _RM books' risk-based sizing when they drive the live
              // book; legacy confidence-weighted notional when the flag is off.
              const notional = riskEnabled
                ? riskSizedNotional(
                    confCalibrator.calibrate(est.confidence),
                    riskDistancePct(cfg, atrPctByStock.get(est.stockId) ?? null, cfg.stopLossPct),
                    cfg.riskPerTrade
                  )
                : confidenceNotional(est.confidence);
              if (gateAlpacaBuy(ticker, notional)) {
                const order = await submitMarketOrder({ symbol: ticker, side: "buy", notional });
                await db.paperOrder.create({
                  data: { stockId: est.stockId, side: "BUY", signal: combinedSignal, notional, alpacaOrderId: order.id, status: order.status },
                });
                ordersSubmitted++;
              }
            } else if (!wantLong && held && held.qty > 0) {
              const qty = Math.abs(held.qty);
              const order = await submitMarketOrder({ symbol: ticker, side: "sell", qty });
              await db.paperOrder.create({
                data: { stockId: est.stockId, side: "SELL", signal: sellSignal, qty, alpacaOrderId: order.id, status: order.status },
              });
              ordersSubmitted++;
            }
          } catch (e) {
            alpacaOrderFailures++;
            errors.push(`Alpaca order failed for ${ticker}: ${String(e)}`);
          }
        }
      }

      // Order rejections / fill failures this run → an account-health alert.
      const ordersAlert = detectOrderFailures(alpacaOrderFailures);
      if (ordersAlert) accountAlerts.push(ordersAlert);

      // Equity straight from the paper account; unrealized rolled up from positions;
      // realized reconstructed from the full fill history (FIFO — same source the
      // performance page uses). Best-effort: on failure the field is omitted so the
      // previous snapshot's value survives instead of writing a false 0.
      const account = await getAccount();
      const unrealized = positions.reduce((s, p) => s + (p.unrealizedPl ?? 0), 0);
      let alpacaRealized: number | null = null;
      try {
        alpacaRealized = realizedFromFills(await getAccountActivities()).totalRealized;
      } catch (e) {
        errors.push(`Alpaca fill history fetch failed (realized omitted): ${String(e)}`);
      }
      const data = {
        equity: account.equity ?? 0,
        cash: account.cash,
        unrealizedPnl: unrealized,
        openPositions: positions.length,
        ...(alpacaRealized != null ? { realizedPnl: alpacaRealized } : {}),
      };
      await db.paperEquitySnapshot.upsert({
        where: { book_date: { book: "ALPACA", date: todayUTC } },
        create: { book: "ALPACA", date: todayUTC, realizedPnl: alpacaRealized ?? 0, ...data },
        update: data,
      });
    } catch (e) {
      errors.push(`Alpaca book failed: ${String(e)}`);
      reportError("paper_alpaca_book_failed", e, { stage: "paper" });
      if (riskLimitsOn) accountAlerts.push(detectBrokerUnreachable());
    }
  }

  // Hand the decision log to the post-close review (see DailyReview in the schema).
  // Best-effort and last: the review degrades to invariant checks without it, so a
  // failure here must never cost the day's trading its result.
  try {
    const runLog: PaperRunLog = {
      version: 1,
      ranAt: to.toISOString(),
      flags: {
        riskBooks: riskEnabled,
        riskLimits: riskLimitsOn,
        brokerStops: isBrokerStopsEnabled() && riskEnabled,
        insiderBook: isInsiderBookEnabled(),
        nearClose: isTradeNearCloseEnabled(),
      },
      cfg,
      decisions,
      errors,
      counts: { simOpened, simClosed, ordersSubmitted },
    };
    await db.dailyReview.upsert({
      where: { date: todayUTC },
      create: { date: todayUTC, paperRun: runLog },
      update: { paperRun: runLog },
    });
  } catch (e) {
    errors.push(`Paper run log persist failed: ${String(e)}`);
  }

  // Persist + notify on any account/trading-health alerts raised this run.
  if (accountAlerts.length > 0) {
    try {
      const r = await processAccountAlerts(accountAlerts);
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`Account alert processing failed: ${String(e)}`);
      reportError("account_alert_processing_failed", e, { stage: "paper" });
    }
  }

  return { stage: "paper", rebalanced: true, ordersSubmitted, simOpened, simClosed, done: true, errors };
}
