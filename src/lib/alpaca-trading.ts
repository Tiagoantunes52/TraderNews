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
function baseUrl(): string {
  return process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets";
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

export type AlpacaFill = { symbol: string; side: "buy" | "sell"; qty: number; price: number; time: string };

/**
 * Recent FILL activities. Alpaca has no "closed position with realized P&L" endpoint,
 * so this is the source for reconstructing realized P&L (FIFO-match sells vs buys —
 * see realizedFromFills). `pageSize` caps at Alpaca's 100/page; newest first.
 */
export async function getAccountActivities(pageSize = 100): Promise<AlpacaFill[]> {
  const raw = await apiGet<Array<{ symbol: string; side: string; qty?: string; price?: string; transaction_time?: string }>>(
    `/v2/account/activities/FILL?direction=desc&page_size=${pageSize}`
  );
  return raw.map((a) => ({
    symbol: a.symbol,
    side: a.side === "sell" ? "sell" : "buy",
    qty: num(a.qty) ?? 0,
    price: num(a.price) ?? 0,
    time: a.transaction_time ?? "",
  }));
}
