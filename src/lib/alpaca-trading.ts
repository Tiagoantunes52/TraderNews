import { fetchWithRetry } from "@/lib/http";

// Alpaca paper Trading API client (issue #14). Places the REAL (simulated) orders
// for the combined-signal book on a paper account and reads back fills + equity.
//
// This uses a SEPARATE key pair from the market-data News keys (#13, lib/alpaca.ts):
// trading keys are minted per Alpaca account, and the paper account has its own.
// Both required, or the whole Alpaca book is a clean no-op (the sim books still run).
//
// Docs: https://docs.alpaca.markets/reference/getaccount-1
// Resolved per-call (not captured at import) so an override is honoured and tests
// can point it at a stub host.

/**
 * Refuse to talk to a LIVE Alpaca trading host.
 *
 * `ALPACA_PAPER_BASE_URL` exists so tests can point the client at a stub, but it was
 * also the only thing standing between this app and real money: nothing else here
 * validates the endpoint, and `isPaperTradingConfigured()` checks that the
 * `ALPACA_PAPER_*` variables are *present*, not that they belong to a paper account.
 * A single mistyped or copy-pasted env value would have routed every order — entries,
 * stops, sells — at the live book with no other signal that anything had changed.
 *
 * So the boundary is enforced in code: any `*.alpaca.markets` host that isn't the
 * paper API is rejected. Non-Alpaca hosts (localhost, stub servers) pass through
 * untouched, which is what the tests need. There is deliberately NO env escape hatch —
 * an override would restore exactly the foot-gun this closes. Trading live must be a
 * reviewed code change, not a deploy-time variable.
 */
const PAPER_HOST = "paper-api.alpaca.markets";

function assertNotLiveHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`ALPACA_PAPER_BASE_URL is not a valid URL: ${url}`);
  }
  if (host === PAPER_HOST) return;
  if (host === "alpaca.markets" || host.endsWith(".alpaca.markets")) {
    throw new Error(
      `Refusing to trade against a live Alpaca host (${host}). This app is paper-only; ` +
        `ALPACA_PAPER_BASE_URL must be ${PAPER_HOST} (or unset).`
    );
  }
}

function baseUrl(): string {
  const url = process.env.ALPACA_PAPER_BASE_URL || `https://${PAPER_HOST}`;
  assertNotLiveHost(url);
  return url;
}

/** True when both paper-trading credentials are present. */
export function isPaperTradingConfigured(): boolean {
  return !!(process.env.ALPACA_PAPER_API_KEY_ID && process.env.ALPACA_PAPER_API_SECRET_KEY);
}

function authHeaders(): Record<string, string> {
  const keyId = process.env.ALPACA_PAPER_API_KEY_ID;
  const secretKey = process.env.ALPACA_PAPER_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error("ALPACA_PAPER_API_KEY_ID / ALPACA_PAPER_API_SECRET_KEY not set");
  }
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
}

// Alpaca returns all numerics as strings; coerce defensively (null/"" → null).
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${baseUrl()}${path}`, {
    headers: { ...authHeaders(), Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca trading error: ${res.status} — ${body}`);
  }
  return (await res.json()) as T;
}

export type AlpacaAccount = { equity: number | null; cash: number | null };

/** Account equity + cash (the ground-truth numbers for the ALPACA equity curve). */
export async function getAccount(): Promise<AlpacaAccount> {
  const raw = await apiGet<{ equity?: string; cash?: string }>("/v2/account");
  return { equity: num(raw.equity), cash: num(raw.cash) };
}

// ── Holdings views (Portfolio page) ──────────────────────────────────────────
// Richer reads of the same paper account for the operator-facing Portfolio page:
// the full account summary, per-position detail, and the equity time series Alpaca
// computes from live/historical prices. Kept separate from the trading-path reads
// above so changing display fields can never affect the paper stage's logic.

export type AlpacaAccountSummary = {
  equity: number | null; // current total account value (live when the market is open)
  lastEquity: number | null; // equity at the previous close — for today's change
  cash: number | null;
  buyingPower: number | null;
  longMarketValue: number | null; // value of long positions (equity − cash, roughly)
};

/** Full account summary for the Portfolio header cards. */
export async function getAccountSummary(): Promise<AlpacaAccountSummary> {
  const raw = await apiGet<{
    equity?: string;
    last_equity?: string;
    cash?: string;
    buying_power?: string;
    long_market_value?: string;
  }>("/v2/account");
  return {
    equity: num(raw.equity),
    lastEquity: num(raw.last_equity),
    cash: num(raw.cash),
    buyingPower: num(raw.buying_power),
    longMarketValue: num(raw.long_market_value),
  };
}

export type AlpacaPortfolioPosition = {
  symbol: string;
  qty: number;
  avgEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  costBasis: number | null;
  unrealizedPl: number | null;
  unrealizedPlpc: number | null; // fraction: 0.05 = +5% since entry
  unrealizedIntradayPl: number | null; // today's $ P&L on the position
  changeToday: number | null; // fraction: the asset's price change today
};

/** Open positions with full P&L detail for the holdings table. */
export async function getPortfolioPositions(): Promise<AlpacaPortfolioPosition[]> {
  const raw = await apiGet<
    Array<{
      symbol: string;
      qty?: string;
      avg_entry_price?: string;
      current_price?: string;
      market_value?: string;
      cost_basis?: string;
      unrealized_pl?: string;
      unrealized_plpc?: string;
      unrealized_intraday_pl?: string;
      change_today?: string;
    }>
  >("/v2/positions");
  return raw.map((p) => ({
    symbol: p.symbol,
    qty: num(p.qty) ?? 0,
    avgEntryPrice: num(p.avg_entry_price),
    currentPrice: num(p.current_price),
    marketValue: num(p.market_value),
    costBasis: num(p.cost_basis),
    unrealizedPl: num(p.unrealized_pl),
    unrealizedPlpc: num(p.unrealized_plpc),
    unrealizedIntradayPl: num(p.unrealized_intraday_pl),
    changeToday: num(p.change_today),
  }));
}

export type AlpacaEquityPoint = { t: string; equity: number };

/**
 * Account equity time series from Alpaca's portfolio-history endpoint (it values
 * each point from real market prices). Drops null points Alpaca emits for gaps.
 * Defaults to a month of daily closes; the latest point reflects live equity.
 */
export async function getPortfolioHistory(
  period = "1M",
  timeframe = "1D"
): Promise<{ points: AlpacaEquityPoint[]; baseValue: number | null }> {
  const raw = await apiGet<{ timestamp?: number[]; equity?: (number | null)[]; base_value?: number }>(
    `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}`
  );
  const ts = raw.timestamp ?? [];
  const eq = raw.equity ?? [];
  const points: AlpacaEquityPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const e = eq[i];
    if (e == null) continue;
    points.push({ t: new Date(ts[i] * 1000).toISOString(), equity: e });
  }
  return { points, baseValue: raw.base_value ?? null };
}

export type AlpacaPosition = {
  symbol: string;
  qty: number;
  unrealizedPl: number | null;
  avgEntryPrice: number | null; // for re-anchoring stops + the trailing-arm gain check
  currentPrice: number | null;
};

/** Open positions on the paper account. `qty` is signed (long > 0). */
export async function getPositions(): Promise<AlpacaPosition[]> {
  const raw = await apiGet<
    Array<{ symbol: string; qty?: string; unrealized_pl?: string; avg_entry_price?: string; current_price?: string }>
  >("/v2/positions");
  return raw.map((p) => ({
    symbol: p.symbol,
    qty: num(p.qty) ?? 0,
    unrealizedPl: num(p.unrealized_pl),
    avgEntryPrice: num(p.avg_entry_price),
    currentPrice: num(p.current_price),
  }));
}

export type AlpacaOrder = {
  id: string;
  status: string;
  filledQty: number | null;
  filledAvgPrice: number | null;
  filledAt: string | null;
};

function toOrder(raw: {
  id: string;
  status: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  filled_at?: string | null;
}): AlpacaOrder {
  return {
    id: raw.id,
    status: raw.status,
    filledQty: num(raw.filled_qty),
    filledAvgPrice: num(raw.filled_avg_price),
    filledAt: raw.filled_at ?? null,
  };
}

export type MarketOrderInput = {
  symbol: string;
  side: "buy" | "sell";
  /** Dollar amount (fractional buys). Mutually exclusive with `qty`. */
  notional?: number;
  /** Share count (used to sell a whole position to close). */
  qty?: number;
};

/**
 * Submit a market order, time-in-force "day". Exactly one of `notional` / `qty`
 * must be set (notional for confidence-weighted buys, qty to sell-to-close).
 */
export async function submitMarketOrder(input: MarketOrderInput): Promise<AlpacaOrder> {
  const { symbol, side, notional, qty } = input;
  if ((notional == null) === (qty == null)) {
    throw new Error("submitMarketOrder requires exactly one of notional or qty");
  }
  const body: Record<string, string> = {
    symbol,
    side,
    type: "market",
    time_in_force: "day",
  };
  if (notional != null) body.notional = notional.toFixed(2);
  if (qty != null) body.qty = String(qty);

  const res = await fetchWithRetry(`${baseUrl()}/v2/orders`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca order error: ${res.status} — ${text}`);
  }
  return toOrder(await res.json());
}

/** Fetch a single order by id — used to reconcile pending orders' fills next run. */
export async function getOrder(id: string): Promise<AlpacaOrder> {
  return toOrder(await apiGet(`/v2/orders/${encodeURIComponent(id)}`));
}

// ── Broker-enforced protective orders (PAPER_BROKER_STOPS) ────────────────────
// The risk overlay (stop-loss / trailing) is pushed to Alpaca so it's enforced
// continuously, intraday, for free — instead of being checked once/day when the
// stage runs. All of these require WHOLE-SHARE qty: Alpaca rejects advanced order
// classes (oto/bracket) and stop/trailing orders on fractional/notional orders.

type RawOrder = Parameters<typeof toOrder>[0] & { legs?: Array<{ id: string; type?: string }> };

async function postOrder(body: Record<string, unknown>): Promise<RawOrder> {
  const res = await fetchWithRetry(`${baseUrl()}/v2/orders`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca order error: ${res.status} — ${text}`);
  }
  return (await res.json()) as RawOrder;
}

export type EntryWithStopInput = { symbol: string; qty: number; limitPrice: number; stopPrice: number };

/**
 * Marketable-limit BUY with an attached GTC stop-loss (One-Triggers-Other).
 *
 * Why a *limit* entry, not market: a market entry forces `time_in_force: "day"`, so
 * the attached stop would expire at the close and leave the position naked overnight.
 * A limit priced *through* the spread fills like a market order but lets the whole
 * order be `gtc`, so the stop_loss leg persists and the broker enforces it
 * continuously. Returns the parent order + the stop leg's id (to reconcile/cancel).
 */
export async function submitEntryWithStop(
  input: EntryWithStopInput
): Promise<{ order: AlpacaOrder; stopOrderId: string | null }> {
  const { symbol, qty, limitPrice, stopPrice } = input;
  const raw = await postOrder({
    symbol,
    qty: String(qty),
    side: "buy",
    type: "limit",
    limit_price: limitPrice.toFixed(2),
    time_in_force: "gtc",
    order_class: "oto",
    stop_loss: { stop_price: stopPrice.toFixed(2) },
  });
  const stopLeg = raw.legs?.find((l) => l.type === "stop") ?? raw.legs?.[0] ?? null;
  return { order: toOrder(raw), stopOrderId: stopLeg?.id ?? null };
}

/** Replace a fixed stop with a native GTC trailing stop once a position is up enough. */
export async function submitTrailingStop(input: { symbol: string; qty: number; trailPercent: number }): Promise<AlpacaOrder> {
  return toOrder(
    await postOrder({
      symbol: input.symbol,
      qty: String(input.qty),
      side: "sell",
      type: "trailing_stop",
      trail_percent: input.trailPercent.toFixed(2),
      time_in_force: "gtc",
    })
  );
}

/** Standalone GTC stop-sell — used to repair a missing protective order. */
export async function submitStopSell(input: { symbol: string; qty: number; stopPrice: number }): Promise<AlpacaOrder> {
  return toOrder(
    await postOrder({
      symbol: input.symbol,
      qty: String(input.qty),
      side: "sell",
      type: "stop",
      stop_price: input.stopPrice.toFixed(2),
      time_in_force: "gtc",
    })
  );
}

/** Cancel an order by id. Tolerates 404/422 (already filled/canceled) — idempotent. */
export async function cancelOrder(id: string): Promise<void> {
  const res = await fetchWithRetry(`${baseUrl()}/v2/orders/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...authHeaders(), Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alpaca cancel error: ${res.status} — ${text}`);
  }
}

export type AlpacaOpenOrder = {
  id: string;
  symbol: string;
  type: string; // "stop" | "trailing_stop" | "limit" | ...
  side: string;
  qty: number | null;
  stopPrice: number | null;
  trailPercent: number | null;
};

/** Open (resting) orders — broker-truth for finding/cancelling the protective leg. */
export async function getOpenOrders(symbol?: string): Promise<AlpacaOpenOrder[]> {
  const q = symbol ? `?status=open&symbols=${encodeURIComponent(symbol)}` : "?status=open";
  const raw = await apiGet<
    Array<{ id: string; symbol: string; type: string; side: string; qty?: string; stop_price?: string | null; trail_percent?: string | null }>
  >(`/v2/orders${q}`);
  return raw.map((o) => ({
    id: o.id,
    symbol: o.symbol,
    type: o.type,
    side: o.side,
    qty: num(o.qty),
    stopPrice: num(o.stop_price),
    trailPercent: num(o.trail_percent),
  }));
}

export type AlpacaClock = { isOpen: boolean; nextClose: string | null };

/** Market clock — drives the near-close trade window (DST/holiday-proof). */
export async function getClock(): Promise<AlpacaClock> {
  const raw = await apiGet<{ is_open?: boolean; next_close?: string }>("/v2/clock");
  return { isOpen: Boolean(raw.is_open), nextClose: raw.next_close ?? null };
}

/**
 * One trading session. `open`/`close` are ET wall-clock "HH:MM" exactly as Alpaca
 * returns them — an early close reads "13:00". Turning those into an absolute
 * instant needs the ET offset for that date; see sessionCloseUtc in market-hours.
 */
export type AlpacaCalendarDay = { date: string; open: string; close: string };

/**
 * Trading sessions in [start, end] from the market calendar — includes early-close
 * days, excludes weekends AND holidays. The close times are what let the post-close
 * review fire an hour after the *actual* close on a half-day.
 */
export async function getCalendarDays(start: Date, end: Date): Promise<AlpacaCalendarDay[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const raw = await apiGet<Array<{ date: string; open?: string; close?: string }>>(
    `/v2/calendar?start=${day(start)}&end=${day(end)}`
  );
  return raw.map((c) => ({ date: c.date, open: c.open ?? "09:30", close: c.close ?? "16:00" }));
}

/**
 * Trading days (YYYY-MM-DD) in [start, end]. Feeds the missed-paper-day dead-man's
 * check, which only cares whether a session existed, not when it ended.
 */
export async function getCalendar(start: Date, end: Date): Promise<string[]> {
  return (await getCalendarDays(start, end)).map((c) => c.date);
}

export type AlpacaFill = { symbol: string; side: "buy" | "sell"; qty: number; price: number; time: string };

/**
 * FULL FILL activity history, paginated. Alpaca has no "closed position with
 * realized P&L" endpoint, so this is the source for reconstructing realized P&L
 * (FIFO-match sells vs buys — see realizedFromFills). The FIFO needs the COMPLETE
 * history: once the oldest buy fills fall outside the window, later sells match
 * the wrong lots (or none) and realized P&L drifts arbitrarily — so we page via
 * `page_token` (Alpaca caps page_size at 100) until exhausted. `maxPages` bounds a
 * runaway loop; at 50 pages / 5000 fills the FIFO is years from truncating.
 */
export async function getAccountActivities(pageSize = 100, maxPages = 50): Promise<AlpacaFill[]> {
  type RawActivity = { id?: string; symbol: string; side: string; qty?: string; price?: string; transaction_time?: string };
  const fills: AlpacaFill[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const qs: string =
      `direction=desc&page_size=${pageSize}` + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const raw = await apiGet<RawActivity[]>(`/v2/account/activities/FILL?${qs}`);
    for (const a of raw) {
      fills.push({
        symbol: a.symbol,
        side: a.side === "sell" ? "sell" : "buy",
        qty: num(a.qty) ?? 0,
        price: num(a.price) ?? 0,
        time: a.transaction_time ?? "",
      });
    }
    const lastId = raw.length > 0 ? raw[raw.length - 1].id : undefined;
    if (raw.length < pageSize || !lastId) break;
    pageToken = lastId;
  }
  return fills;
}
