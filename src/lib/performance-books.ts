// Shared book metadata for the signal-performance views. This lives in a plain
// (non-"use client") module so BOTH the server page and the client chart import the
// real array. A value imported from a "use client" module becomes a client-reference
// proxy when used in a Server Component — `BOOK_META.map(...)` then throws
// "BOOK_META.map is not a function" during the server render.
export const BOOK_META = [
  { key: "SIM_COMBINED", label: "Combined", color: "#6366f1" },
  { key: "SIM_SENTIMENT", label: "Sentiment", color: "#10b981" },
  { key: "SIM_QUANT", label: "Quant", color: "#f59e0b" },
  { key: "ALPACA", label: "Alpaca (live)", color: "#ec4899" },
] as const;

export type BookKey = (typeof BOOK_META)[number]["key"];
export type EquityPoint = { date: string } & Partial<Record<BookKey, number>>;
