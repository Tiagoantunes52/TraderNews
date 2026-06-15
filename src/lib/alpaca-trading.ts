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

export type AlpacaPosition = { symbol: string; qty: number; unrealizedPl: number | null };

/** Open positions on the paper account. `qty` is signed (long > 0). */
export async function getPositions(): Promise<AlpacaPosition[]> {
  const raw = await apiGet<Array<{ symbol: string; qty?: string; unrealized_pl?: string }>>("/v2/positions");
  return raw.map((p) => ({ symbol: p.symbol, qty: num(p.qty) ?? 0, unrealizedPl: num(p.unrealized_pl) }));
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
