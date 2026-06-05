// Pure insider-signal computation + detection. Side-effect free so it can be
// unit tested independently of the pipeline and DB.
//
// Methodology (buy-biased): insiders sell for many reasons but buy for one, so
// only OPEN_MARKET_BUY / OPEN_MARKET_SELL transactions feed the signals — grants,
// option exercises, tax-withholding and gifts are filtered out upstream by
// normalizeTxnType. Alerts are TRANSITION detectors (fire on the crossing, like
// detectRsiCross), so a standing condition doesn't re-email every run, and the
// first-ever summary (prev == null) never fires.

import type { AlertDraft } from "@/lib/alerts";
import { isCsuiteTitle, type InsiderTxn } from "@/lib/insider-sources";

// Tunable thresholds — starting points calibrated for liquid US large-caps.
// Revisit after a few weeks of live alerts; smaller-caps warrant lower floors.
export const SUMMARY_WINDOW_DAYS = 90;
export const CLUSTER_WINDOW_DAYS = 14;
export const CLUSTER_BUYERS_THRESHOLD = 3; // distinct open-market buyers in the cluster window
export const LARGE_HOLDINGS_PCT = 0.25; // a buy that lifts an insider's position ≥25%
export const FLOW_SHIFT_MIN_VALUE = 50_000; // ignore tiny net-flow sign flips (USD)
export const CSUITE_BUY_MIN_VALUE = 100_000; // CEO/CFO/COO open-market buys past this fire (USD)

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type InsiderSignal = { type: string; detail: string; value: number | null };

export type InsiderSummaryData = {
  buyCount90d: number;
  sellCount90d: number;
  distinctBuyers90d: number;
  distinctSellers90d: number;
  netShares90d: number;
  netValue90d: number;
  buyValue90d: number;
  sellValue90d: number;
  distinctBuyers14d: number;
  csuiteBuyValue14d: number; // open-market CEO/CFO/COO/Chair buy notional in the cluster window
  mspr: number | null;
  convictionScore: number;
  signals: InsiderSignal[];
};

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * Roll up normalized transactions into a per-stock summary. Windows by
 * transactionDate (when the trade happened); only open-market buys/sells count.
 * `mspr` is Finnhub's monthly share-purchase ratio (-100..100), folded into the
 * conviction score as a corroborating aggregate.
 */
export function summarizeInsider(txns: InsiderTxn[], mspr: number | null, now: Date = new Date()): InsiderSummaryData {
  const since90 = new Date(now.getTime() - SUMMARY_WINDOW_DAYS * DAY_MS);
  const since14 = new Date(now.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS);

  const open = txns.filter((t) => t.txnType === "OPEN_MARKET_BUY" || t.txnType === "OPEN_MARKET_SELL");
  const in90 = open.filter((t) => t.transactionDate >= since90);
  const buys90 = in90.filter((t) => t.txnType === "OPEN_MARKET_BUY");
  const sells90 = in90.filter((t) => t.txnType === "OPEN_MARKET_SELL");

  const buyValue90d = buys90.reduce((s, t) => s + (t.value ?? 0), 0);
  const sellValue90d = sells90.reduce((s, t) => s + (t.value ?? 0), 0);
  const netValue90d = buyValue90d - sellValue90d;
  const netShares90d = in90.reduce((s, t) => s + t.shares, 0);

  const buys14 = open.filter((t) => t.txnType === "OPEN_MARKET_BUY" && t.transactionDate >= since14);
  const distinctBuyers14d = new Set(buys14.map((t) => t.insiderName)).size;

  // C-suite conviction: open-market buys (excluding 10b5-1 planned trades) by a
  // CEO/CFO/COO/Chair. Only the EDGAR source carries roles, so this stays 0 when
  // running on Finnhub alone — a clean degradation, never a false signal.
  const csuiteBuyValue14d = buys14
    .filter((t) => !t.isPlanned && t.isOfficer && isCsuiteTitle(t.officerTitle))
    .reduce((s, t) => s + (t.value ?? 0), 0);

  const total = buyValue90d + sellValue90d;
  let convictionScore = total > 0 ? (buyValue90d - sellValue90d) / total : 0;
  if (mspr != null && Number.isFinite(mspr)) convictionScore = 0.7 * convictionScore + 0.3 * (mspr / 100);
  convictionScore = clamp(convictionScore, -1, 1);

  const signals: InsiderSignal[] = [];
  if (distinctBuyers14d >= CLUSTER_BUYERS_THRESHOLD) {
    signals.push({ type: "CLUSTER_BUY", detail: `${distinctBuyers14d} insiders bought in ${CLUSTER_WINDOW_DAYS}d`, value: distinctBuyers14d });
  }
  const bigBuy = buys90.find((t) => t.pctHoldingsChg != null && t.pctHoldingsChg >= LARGE_HOLDINGS_PCT);
  if (bigBuy) {
    signals.push({ type: "LARGE_BUY", detail: `${bigBuy.insiderName} grew holdings ${Math.round((bigBuy.pctHoldingsChg ?? 0) * 100)}%`, value: bigBuy.pctHoldingsChg ?? null });
  }
  if (netValue90d !== 0) {
    signals.push({ type: netValue90d > 0 ? "NET_BUYING" : "NET_SELLING", detail: `net ${fmtUsd(netValue90d)} over 90d`, value: netValue90d });
  }
  if (csuiteBuyValue14d > 0) {
    signals.push({ type: "CSUITE_BUY", detail: `C-suite bought ${fmtUsd(csuiteBuyValue14d)} in ${CLUSTER_WINDOW_DAYS}d`, value: csuiteBuyValue14d });
  }

  return {
    buyCount90d: buys90.length,
    sellCount90d: sells90.length,
    distinctBuyers90d: new Set(buys90.map((t) => t.insiderName)).size,
    distinctSellers90d: new Set(sells90.map((t) => t.insiderName)).size,
    netShares90d,
    netValue90d,
    buyValue90d,
    sellValue90d,
    distinctBuyers14d,
    csuiteBuyValue14d,
    mspr: mspr ?? null,
    convictionScore,
    signals,
  };
}

/** Fields a detector needs from the previous day's stored summary. */
export type PrevInsiderSummary = { distinctBuyers14d: number; netValue90d: number; csuiteBuyValue14d: number };

/**
 * Fires when the count of distinct open-market buyers in the cluster window
 * crosses up through the threshold — multiple insiders independently buying is
 * the highest-precision insider signal. Transition-only; needs a prior summary.
 */
export function detectInsiderClusterBuy(
  ticker: string,
  prev: PrevInsiderSummary | null,
  curr: Pick<InsiderSummaryData, "distinctBuyers14d">,
  threshold: number = CLUSTER_BUYERS_THRESHOLD
): AlertDraft | null {
  if (prev == null) return null;
  if (curr.distinctBuyers14d >= threshold && prev.distinctBuyers14d < threshold) {
    return {
      type: "INSIDER_CLUSTER_BUY",
      title: `${ticker} insider cluster buy`,
      message: `🟢 ${curr.distinctBuyers14d} insiders bought ${ticker} on the open market in the last ${CLUSTER_WINDOW_DAYS} days.`,
      value: curr.distinctBuyers14d,
    };
  }
  return null;
}

/**
 * Fires when 90-day net insider flow flips sign (with a magnitude floor to skip
 * noise) — an aggregate regime change in insider conviction. Transition-only.
 */
export function detectInsiderFlowShift(
  ticker: string,
  prev: PrevInsiderSummary | null,
  curr: Pick<InsiderSummaryData, "netValue90d">,
  minValue: number = FLOW_SHIFT_MIN_VALUE
): AlertDraft | null {
  if (prev == null) return null;
  const toBuying = prev.netValue90d <= 0 && curr.netValue90d > 0 && curr.netValue90d >= minValue;
  const toSelling = prev.netValue90d >= 0 && curr.netValue90d < 0 && -curr.netValue90d >= minValue;
  if (!toBuying && !toSelling) return null;

  const arrow = toBuying ? "📈" : "📉";
  const dir = toBuying ? "net buying" : "net selling";
  return {
    type: "INSIDER_FLOW_SHIFT",
    title: `${ticker} insiders turned ${toBuying ? "buyers" : "sellers"}`,
    message: `${arrow} Insider 90-day flow for ${ticker} flipped to ${dir} (net ${fmtUsd(curr.netValue90d)}).`,
    value: curr.netValue90d,
  };
}

/**
 * Fires when C-suite open-market buying in the cluster window crosses up through
 * the value floor — a CEO/CFO/COO putting real personal money in is the single
 * highest-conviction insider signal. Needs EDGAR role data (csuiteBuyValue14d is
 * 0 on Finnhub), and is transition-only so a standing position doesn't re-email.
 */
export function detectCsuiteBuy(
  ticker: string,
  prev: PrevInsiderSummary | null,
  curr: Pick<InsiderSummaryData, "csuiteBuyValue14d">,
  minValue: number = CSUITE_BUY_MIN_VALUE
): AlertDraft | null {
  if (prev == null) return null;
  if (curr.csuiteBuyValue14d >= minValue && prev.csuiteBuyValue14d < minValue) {
    return {
      type: "INSIDER_CSUITE_BUY",
      title: `${ticker} C-suite buying`,
      message: `🟢 C-suite insiders bought ${fmtUsd(curr.csuiteBuyValue14d)} of ${ticker} on the open market in the last ${CLUSTER_WINDOW_DAYS} days.`,
      value: curr.csuiteBuyValue14d,
    };
  }
  return null;
}
