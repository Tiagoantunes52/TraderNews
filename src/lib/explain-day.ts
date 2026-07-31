// One surface for "what actually happened on day D".
//
// The motivating problem was not a missing number — it was that the numbers live in
// five places that are only joinable by hand, and every join needs a fact that isn't
// written down. A price sits in `PriceBar`; the quant stage copies it into
// `QuantAnalysis.price` under a `date` that is a day LATER than the session it
// describes; the paper stage may overwrite it with a live quote for some names and not
// others; the reconciler's decision lands in `DailyReview.paperRun`; and the outcome
// lands in `SimPosition` and `PaperOrder`. Any two of those can be made to disagree by
// reading them a day apart, and several investigations did exactly that.
//
// So this module walks the chain in one direction — bar -> quant row -> decision ->
// persisted position/order — and reports where consecutive links contradict each other.
// It reads `QuantAnalysis.sessionDate` and `DecisionInputs.priceSource` rather than
// re-deriving either, which is the whole point: the offsets are recorded now, and a
// tool that re-derives them can be wrong in a new way.
//
// Pure. `scripts/explain-day.ts` does the I/O.

import type { PaperRunLog, DecisionRecord } from "@/lib/daily-review";
import { TERMINAL_ORDER_STATUS } from "@/lib/paper-trading";

export type QuantRow = {
  stockId: string;
  ticker: string;
  price: number | null;
  /** `YYYY-MM-DD`, or null for rows written before the column existed / unresolvable. */
  sessionDate: string | null;
};

export type BarRow = { stockId: string; date: string; close: number };

export type PositionRow = {
  stockId: string;
  ticker: string;
  strategy: string;
  status: string;
  entryDate: string;
  exitDate: string | null;
  exitReason: string | null;
  qty: number;
  entryPrice: number;
  exitPrice: number | null;
};

export type OrderRow = {
  stockId: string;
  ticker: string;
  side: string;
  status: string;
  filledQty: number | null;
  submittedAt: string;
};

export type DayInput = {
  /** UTC day the pipeline RAN, `YYYY-MM-DD`. Not the session — see `session` below. */
  day: string;
  run: PaperRunLog | null;
  reviewStatus: string | null;
  /** `QuantAnalysis` rows written on `day`. */
  quant: QuantRow[];
  /** `PriceBar` rows for the sessions in the days leading up to `day`. */
  bars: BarRow[];
  /** `SimPosition` rows whose entryDate falls on `day`. */
  opened: PositionRow[];
  /** `SimPosition` rows whose exitDate falls on `day`. */
  closed: PositionRow[];
  /** `PaperOrder` rows submitted on `day` (the live ALPACA book). */
  orders: OrderRow[];
};

export type DisagreementKind =
  /** No run log on a day that WAS a trading session — the paper stage did not complete. */
  | "NO_RUN_LOG"
  /** No bar is dated this day, so no paper run was expected. Not a fault. */
  | "NOT_A_SESSION"
  /** The run log predates pricing provenance, so how it was priced is unknowable. */
  | "PRICING_UNDECLARED"
  /** Quant rows on this day with no `sessionDate` — which session they describe is unknown. */
  | "SESSION_UNDECLARED"
  /** Quant rows on this day disagree about which session they describe. */
  | "SESSION_SPLIT"
  /** A quant row's stored close is not the close of the session it declares. */
  | "QUANT_OFF_BAR"
  /** A quant row's close matches a DIFFERENT session's bar than the one it declares. */
  | "QUANT_WRONG_SESSION"
  /** A close-priced decision priced off something other than that stock's quant row. */
  | "DECISION_OFF_QUANT"
  /** The reconciler said OPEN, the gate allowed it, and no position exists. */
  | "OPEN_NOT_PERSISTED"
  /** A position opened today that no logged decision asked for. */
  | "OPEN_UNEXPLAINED"
  /** The reconciler said CLOSE and the position is still open. */
  | "CLOSE_NOT_PERSISTED"
  /** A position closed today with no `exitReason` — the audit trail stops here. */
  | "EXIT_REASON_MISSING"
  /** An order was submitted today and neither filled nor reached a terminal state. */
  | "ORDER_UNRESOLVED";

export type Severity = "fail" | "warn" | "info";

export type Disagreement = {
  kind: DisagreementKind;
  severity: Severity;
  /** What it is about — a ticker, a strategy, or the day itself. */
  subject: string;
  detail: string;
};

export type DayExplanation = {
  day: string;
  ranAt: string | null;
  reviewStatus: string | null;
  session: {
    /** Distinct sessions the day's quant rows declare. One entry is the healthy case. */
    declared: { date: string; rows: number }[];
    undeclared: number;
    rows: number;
  };
  pricing:
    | {
        enabled: boolean;
        marketOpen: boolean;
        livePriced: number;
        totalPriced: number;
        sweepLivePriced?: number;
        sweepTotalPriced?: number;
      }
    | null;
  decisions: {
    total: number;
    byAction: Record<string, number>;
    riskBlocked: number;
    byBlockReason: Record<string, number>;
    priced: { live: number; close: number; unknown: number };
  };
  persisted: {
    opened: number;
    closed: number;
    ordersSubmitted: number;
    ordersFilled: number;
  };
  errors: string[];
  disagreements: Disagreement[];
};

/**
 * How far a stored price may sit from the bar before it counts as a different number.
 *
 * 0.2% is chosen to be wider than float round-tripping and narrower than a dividend
 * adjustment. The dividend payers in this universe show a per-name CONSTANT ratio of
 * 1.007-1.017 against pre-adjustment history, which lands outside this band on purpose:
 * a persistent constant offset on one name is a corporate action and worth seeing, while
 * a scattered offset is a wrong series. Same convention as the backfill's `--verify`.
 */
const PRICE_TOLERANCE = 0.002;

const near = (a: number, b: number, tol = PRICE_TOLERANCE) =>
  b !== 0 ? Math.abs(a - b) / Math.abs(b) <= tol : a === b;

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function explainDay(input: DayInput): DayExplanation {
  const d: Disagreement[] = [];
  const { day, run, quant, bars, opened, closed, orders } = input;

  const barsByStock = new Map<string, BarRow[]>();
  for (const b of bars) {
    const list = barsByStock.get(b.stockId);
    if (list) list.push(b);
    else barsByStock.set(b.stockId, [b]);
  }
  // A bar dated `day` is the evidence that `day` was a trading session. It is absent for
  // weekends and holidays, and also for the session in progress — bars are written a day
  // in arrears by design (see PriceBar's IN_PROGRESS rule).
  const dayIsSession = bars.some((b) => b.date === day);

  // ── Session alignment ──────────────────────────────────────────────────────
  const declaredCounts = new Map<string, number>();
  let undeclared = 0;
  for (const q of quant) {
    if (q.sessionDate) declaredCounts.set(q.sessionDate, (declaredCounts.get(q.sessionDate) ?? 0) + 1);
    else undeclared++;
  }
  const declared = [...declaredCounts.entries()]
    .map(([date, rows]) => ({ date, rows }))
    .sort((a, b) => b.rows - a.rows || a.date.localeCompare(b.date));
  /** The session the run as a whole read — ~100 names agreeing, so far stronger than any row. */
  const consensusSession: string | null = declared[0]?.date ?? null;

  // Only rows that COULD have declared a session are worth a finding. Crypto and
  // European listings have no bars to resolve against, so their nulls are permanent and
  // expected — reporting them would put a warning on every single day forever, and an
  // alarm that always fires is one nobody reads.
  const coveredUndeclared = quant.filter(
    (q) => !q.sessionDate && barsByStock.has(q.stockId)
  ).length;
  if (coveredUndeclared > 0) {
    d.push({
      kind: "SESSION_UNDECLARED",
      severity: "warn",
      subject: day,
      detail: `${coveredUndeclared} quant row(s) have bar coverage but declare no session, so their price cannot be aligned. Treat as unknown, never as same-day. (${
        undeclared - coveredUndeclared
      } further row(s) have no bars at all — crypto and non-US listings, permanently unresolvable and not counted here.)`,
    });
  }
  if (declared.length > 1) {
    d.push({
      kind: "SESSION_SPLIT",
      severity: "warn",
      subject: day,
      detail: `quant rows declare ${declared.length} different sessions (${declared
        .map((s) => `${s.date}×${s.rows}`)
        .join(", ")}). Expected one per run — a split means the stage spanned a session boundary or ran twice.`,
    });
  }

  // ── Link 1: quant row vs the bar it claims ─────────────────────────────────
  const quantByStock = new Map<string, QuantRow>();
  for (const q of quant) {
    quantByStock.set(q.stockId, q);
    if (q.price == null || !q.sessionDate) continue;
    const stockBars = barsByStock.get(q.stockId);
    if (!stockBars || stockBars.length === 0) continue; // no coverage — nothing to check

    const claimed = stockBars.find((b) => b.date === q.sessionDate);
    if (claimed && near(q.price, claimed.close)) continue; // healthy

    // Does some OTHER session in the window explain the price? That is the specific
    // failure this whole exercise exists to catch, so name it rather than reporting a
    // generic mismatch the reader then has to diagnose.
    //
    // But only for a row that dissents from the run's consensus. A row carrying the
    // consensus session got that label from the RUN, not from its own price, so "some
    // other day's bar matches better" cannot mean the label is wrong. It happens
    // constantly on dividend payers: a ~1% adjustment-basis offset on a name that moves
    // ~1% a day lands on a neighbouring session's close by coincidence, and PFE and PG
    // were reported as wrong-session on four separate days before this rule existed.
    // Their real story is the basis, which is what QUANT_OFF_BAR below says.
    const dissents = consensusSession != null && q.sessionDate !== consensusSession;
    const elsewhere = dissents
      ? stockBars.find((b) => b.date !== q.sessionDate && near(q.price!, b.close))
      : undefined;
    if (elsewhere) {
      d.push({
        kind: "QUANT_WRONG_SESSION",
        severity: "fail",
        subject: q.ticker,
        detail: `stored close ${q.price} declares session ${q.sessionDate} but matches ${elsewhere.date} (${elsewhere.close}). The row is labelled with the wrong session.`,
      });
    } else if (claimed) {
      const ratio = claimed.close !== 0 ? q.price / claimed.close : NaN;
      d.push({
        kind: "QUANT_OFF_BAR",
        severity: "warn",
        subject: q.ticker,
        detail: `stored close ${q.price} vs ${q.sessionDate} bar ${claimed.close} (ratio ${ratio.toFixed(4)}). A ratio constant across this name's history is a corporate action; a scattered one is a wrong series.`,
      });
    }
  }

  // ── Link 2: decision vs the quant row it should have read ──────────────────
  const byAction: Record<string, number> = {};
  const byBlockReason: Record<string, number> = {};
  let riskBlocked = 0;
  const priced = { live: 0, close: 0, unknown: 0 };
  const decisions: DecisionRecord[] = run?.decisions ?? [];

  if (!run && !dayIsSession) {
    d.push({
      kind: "NOT_A_SESSION",
      severity: "info",
      subject: day,
      detail: `no bar is dated ${day}, so it was a weekend or holiday and no paper run was due. (Also reported for the session in progress — its bar is not written until the next run.)`,
    });
  } else if (!run) {
    d.push({
      kind: "NO_RUN_LOG",
      severity: "fail",
      subject: day,
      detail: `${day} was a trading session — a bar is stored for it — and no paperRun was recorded. The paper stage did not complete.`,
    });
  } else if (!run.pricing) {
    d.push({
      kind: "PRICING_UNDECLARED",
      severity: "warn",
      subject: day,
      detail:
        "run log has no `pricing` block, so how this run was priced is unknowable. Absent does NOT mean live quotes were off — every number below that depends on the mark is provisional.",
    });
  }

  for (const dec of decisions) {
    bump(byAction, dec.action.type);
    if (dec.riskBlocked) {
      riskBlocked++;
      bump(byBlockReason, dec.riskBlockReason ?? "UNRECORDED");
    }
    const src = dec.inputs.priceSource;
    if (src === "LIVE_TRADE") priced.live++;
    else if (src === "CLOSE") priced.close++;
    else priced.unknown++;

    // A CLOSE-priced decision must have read this stock's stored close verbatim. If it
    // did not, something between the two stages substituted a price without saying so —
    // exactly the class of drift that reads as "the metrics don't match".
    if (src === "CLOSE") {
      const q = quantByStock.get(dec.stockId);
      if (q?.price != null && !near(dec.inputs.price, q.price)) {
        d.push({
          kind: "DECISION_OFF_QUANT",
          severity: "fail",
          subject: `${dec.ticker}/${dec.strategy}`,
          detail: `decision priced at ${dec.inputs.price} but declares CLOSE, and this stock's stored close is ${q.price}.`,
        });
      }
    }
  }

  // ── Link 3: decision vs what was persisted ─────────────────────────────────
  const openedKeys = new Set(opened.map((p) => `${p.stockId}|${p.strategy}`));
  const closedKeys = new Set(closed.map((p) => `${p.stockId}|${p.strategy}`));
  const decisionKeys = new Map<string, DecisionRecord>();

  for (const dec of decisions) {
    const key = `${dec.stockId}|${dec.strategy}`;
    decisionKeys.set(key, dec);

    if (dec.action.type === "OPEN" && !dec.riskBlocked && !openedKeys.has(key)) {
      d.push({
        kind: "OPEN_NOT_PERSISTED",
        severity: "fail",
        subject: `${dec.ticker}/${dec.strategy}`,
        detail: `reconciler said OPEN, the gate did not block it, and no SimPosition has entryDate ${day}.`,
      });
    }
    if (dec.action.type === "CLOSE" && !closedKeys.has(key)) {
      d.push({
        kind: "CLOSE_NOT_PERSISTED",
        severity: "fail",
        subject: `${dec.ticker}/${dec.strategy}`,
        detail: `reconciler said CLOSE (${dec.action.reason ?? "no reason"}) and no SimPosition has exitDate ${day}.`,
      });
    }
  }

  // Only books that logged decisions this run can have an unexplained position. The
  // INSIDER book enters on discrete events through `reconcileEventPosition` and never
  // reaches the decision log at all, so measuring it against that log would report a
  // contradiction on every insider entry — a false alarm in a tool whose only value is
  // that its alarms mean something.
  const loggedStrategies = new Set(decisions.map((dec) => dec.strategy as string));

  for (const p of opened) {
    if (!loggedStrategies.has(p.strategy)) continue;
    const dec = decisionKeys.get(`${p.stockId}|${p.strategy}`);
    if (!dec || dec.action.type !== "OPEN") {
      d.push({
        kind: "OPEN_UNEXPLAINED",
        severity: "fail",
        subject: `${p.ticker}/${p.strategy}`,
        detail: `position opened at ${p.entryPrice} on ${day} with ${
          dec ? `a logged decision of ${dec.action.type}` : "no logged decision"
        }.`,
      });
    }
  }

  for (const p of closed) {
    if (!p.exitReason) {
      d.push({
        kind: "EXIT_REASON_MISSING",
        severity: "warn",
        subject: `${p.ticker}/${p.strategy}`,
        detail: `closed on ${day} with no exitReason, so this trade cannot be attributed to a ladder rung.`,
      });
    }
  }

  // ── Link 4: the live book's orders ─────────────────────────────────────────
  let ordersFilled = 0;
  for (const o of orders) {
    const filled = (o.filledQty ?? 0) > 0;
    if (filled) ordersFilled++;
    if (!filled && !TERMINAL_ORDER_STATUS.has(o.status)) {
      d.push({
        kind: "ORDER_UNRESOLVED",
        // Info, not warn: a resting limit order on the day it was placed is the normal
        // case, and the entry-expiry sweep handles one that stays that way. It appears
        // here so that "the sim opened but the broker didn't" is visible immediately
        // rather than being diagnosed from scratch each time.
        severity: "info",
        subject: o.ticker,
        detail: `${o.side} order submitted ${o.submittedAt} is ${o.status} with no fill — the live book does not hold what the sim books do.`,
      });
    }
  }

  const order: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };
  d.sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));

  return {
    day,
    ranAt: run?.ranAt ?? null,
    reviewStatus: input.reviewStatus,
    session: { declared, undeclared, rows: quant.length },
    pricing: run?.pricing ?? null,
    decisions: { total: decisions.length, byAction, riskBlocked, byBlockReason, priced },
    persisted: {
      opened: opened.length,
      closed: closed.length,
      ordersSubmitted: orders.length,
      ordersFilled,
    },
    errors: run?.errors ?? [],
    disagreements: d,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const pairs = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "none";

/** Human-readable report. Kept here (not in the script) so it is testable. */
export function formatDayExplanation(x: DayExplanation): string {
  const L: string[] = [];
  L.push(`═══ ${x.day} ═══`);
  L.push(`run        ${x.ranAt ?? "— no paper run —"}   review=${x.reviewStatus ?? "—"}`);

  const sessions = x.session.declared.length
    ? x.session.declared.map((s) => `${s.date} (${s.rows} rows)`).join(", ")
    : "none declared";
  L.push(`session    ${sessions}${x.session.undeclared ? `, ${x.session.undeclared} undeclared` : ""}`);
  // Spelled out because the gap is the thing people keep re-deriving.
  if (x.session.declared.length === 1) {
    L.push(`           ↳ prices on this run describe ${x.session.declared[0].date}, not ${x.day}`);
  }

  L.push(
    x.pricing
      ? `pricing    liveQuotes=${x.pricing.enabled} marketOpen=${x.pricing.marketOpen} → ${x.pricing.livePriced}/${x.pricing.totalPriced} names on the live tape` +
        (x.pricing.sweepTotalPriced
          ? ` (convergence sweep ${x.pricing.sweepLivePriced ?? 0}/${x.pricing.sweepTotalPriced})`
          : "")
      : x.ranAt
        ? `pricing    UNDECLARED — this run predates pricing provenance`
        : `pricing    — no run to price —`
  );

  L.push(
    `decisions  ${x.decisions.total} total | ${pairs(x.decisions.byAction)} | riskBlocked=${x.decisions.riskBlocked}${
      x.decisions.riskBlocked ? ` (${pairs(x.decisions.byBlockReason)})` : ""
    }`
  );
  L.push(
    `           priced live=${x.decisions.priced.live} close=${x.decisions.priced.close} unknown=${x.decisions.priced.unknown}`
  );
  L.push(
    `persisted  opened=${x.persisted.opened} closed=${x.persisted.closed} orders=${x.persisted.ordersSubmitted} (filled ${x.persisted.ordersFilled})`
  );

  if (x.errors.length) {
    L.push("", `errors (${x.errors.length}):`);
    for (const e of x.errors.slice(0, 10)) L.push(`  · ${e}`);
    if (x.errors.length > 10) L.push(`  … ${x.errors.length - 10} more`);
  }

  L.push("", x.disagreements.length ? `disagreements (${x.disagreements.length}):` : "disagreements: none — every link in the chain agrees");
  for (const g of x.disagreements) {
    L.push(`  [${g.severity.toUpperCase()}] ${g.kind} ${g.subject}`);
    L.push(`      ${g.detail}`);
  }
  return L.join("\n");
}
