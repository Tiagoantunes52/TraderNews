"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts";

// Books overlaid on the equity curve. SIM_COMBINED leads (the headline book); the
// Alpaca live line only appears when paper trading is configured and has snapshots.
export const BOOK_META = [
  { key: "SIM_COMBINED", label: "Combined", color: "#6366f1" },
  { key: "SIM_SENTIMENT", label: "Sentiment", color: "#10b981" },
  { key: "SIM_QUANT", label: "Quant", color: "#f59e0b" },
  { key: "ALPACA", label: "Alpaca (live)", color: "#ec4899" },
] as const;

export type BookKey = (typeof BOOK_META)[number]["key"];
export type EquityPoint = { date: string } & Partial<Record<BookKey, number>>;

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border rounded-xl p-3 shadow-lg text-sm">
      <p className="font-medium text-xs text-muted-foreground mb-1">
        {label ? new Date(label).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
      </p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center justify-between gap-4 tabular-nums">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold">{fmtUsd(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function PerformanceEquityChart({
  data,
  books,
  height = 280,
}: {
  data: EquityPoint[];
  books: BookKey[];
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div className="text-center text-sm text-muted-foreground py-12">
        Not enough equity history to plot a curve yet. The performance stage records one point per day — give
        it a few runs.
      </div>
    );
  }

  const shown = BOOK_META.filter((b) => books.includes(b.key));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" opacity={0.5} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          stroke="currentColor"
          className="text-muted-foreground"
        />
        <YAxis
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={fmtUsd}
          stroke="currentColor"
          className="text-muted-foreground"
          width={56}
          domain={["auto", "auto"]}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {shown.map((b) => (
          <Line
            key={b.key}
            type="monotone"
            dataKey={b.key}
            name={b.label}
            stroke={b.color}
            strokeWidth={b.key === "SIM_COMBINED" ? 2.5 : 1.8}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
