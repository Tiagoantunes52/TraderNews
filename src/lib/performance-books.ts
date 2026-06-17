// Shared book metadata for the signal-performance views. This lives in a plain
// (non-"use client") module so BOTH the server page and the client chart import the
// real array. A value imported from a "use client" module becomes a client-reference
// proxy when used in a Server Component — `BOOK_META.map(...)` then throws
// "BOOK_META.map is not a function" during the server render.
// Pure (signal-only) books first, then their risk-managed (_RM) variants, then the
// live Alpaca book. Books only render once they have snapshots, so the _RM rows stay
// hidden until PAPER_RISK_BOOKS=1 has run the pipeline at least once.
export const BOOK_META = [
  { key: "SIM_COMBINED", label: "Combined", color: "#6366f1" },
  { key: "SIM_SENTIMENT", label: "Sentiment", color: "#10b981" },
  { key: "SIM_QUANT", label: "Quant", color: "#f59e0b" },
  { key: "SIM_COMBINED_RM", label: "Combined (risk-managed)", color: "#8b5cf6" },
  { key: "SIM_SENTIMENT_RM", label: "Sentiment (risk-managed)", color: "#14b8a6" },
  { key: "SIM_QUANT_RM", label: "Quant (risk-managed)", color: "#f97316" },
  { key: "ALPACA", label: "Alpaca (live)", color: "#ec4899" },
] as const;

export type BookKey = (typeof BOOK_META)[number]["key"];
export type EquityPoint = { date: string } & Partial<Record<BookKey, number>>;
