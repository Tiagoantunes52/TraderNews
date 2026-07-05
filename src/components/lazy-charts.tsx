"use client";

// Recharts is the biggest route-specific bundle cost (issue #64). These wrappers
// defer it out of the initial JS — the chart loads client-side behind a
// same-height placeholder, so chart routes paint without shipping recharts up
// front. `ssr: false` must live in a client module, hence this wrapper file.
import dynamic from "next/dynamic";

function placeholder(height: number) {
  return function ChartPlaceholder() {
    return <div style={{ height }} className="w-full animate-pulse rounded-xl bg-muted/40" />;
  };
}

export const PerformanceEquityChart = dynamic(
  () => import("@/components/performance-equity-chart").then((m) => m.PerformanceEquityChart),
  { ssr: false, loading: placeholder(280) }
);

export const PortfolioValueChart = dynamic(
  () => import("@/components/portfolio-value-chart").then((m) => m.PortfolioValueChart),
  { ssr: false, loading: placeholder(280) }
);

export const SentimentHistoryChart = dynamic(
  () => import("@/components/sentiment-history-chart").then((m) => m.SentimentHistoryChart),
  { ssr: false, loading: placeholder(240) }
);
