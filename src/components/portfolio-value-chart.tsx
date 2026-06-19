"use client";

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from "recharts";

export type PortfolioPoint = { t: string; equity: number };

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
  baseValue,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
  baseValue: number | null;
}) {
  if (!active || !payload?.length) return null;
  const equity = payload[0].value;
  const delta = baseValue != null ? equity - baseValue : null;
  return (
    <div className="bg-background border rounded-xl p-3 shadow-lg text-sm">
      <p className="font-medium text-xs text-muted-foreground mb-1">
        {label ? new Date(label).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
      </p>
      <p className="font-semibold tabular-nums">${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
      {delta != null && (
        <p className={`text-xs tabular-nums ${delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {delta >= 0 ? "+" : ""}
          {fmtUsd(delta)} since start
        </p>
      )}
    </div>
  );
}

/** Single-series area chart of the live Alpaca account value over time. */
export function PortfolioValueChart({
  data,
  baseValue = null,
  height = 280,
}: {
  data: PortfolioPoint[];
  baseValue?: number | null;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div className="text-center text-sm text-muted-foreground py-12">
        Not enough history to plot a curve yet — the account value series fills in over time.
      </div>
    );
  }

  const start = baseValue ?? data[0].equity;
  const up = data[data.length - 1].equity >= start;
  const color = up ? "#10b981" : "#ef4444";

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="portfolio-value-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" opacity={0.5} vertical={false} />
        <XAxis
          dataKey="t"
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={(d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          stroke="currentColor"
          className="text-muted-foreground"
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={fmtUsd}
          stroke="currentColor"
          className="text-muted-foreground"
          width={56}
          domain={["auto", "auto"]}
        />
        {baseValue != null && (
          <ReferenceLine y={baseValue} stroke="currentColor" className="text-muted-foreground" strokeDasharray="3 3" opacity={0.5} />
        )}
        <Tooltip content={<CustomTooltip baseValue={baseValue} />} />
        <Area type="monotone" dataKey="equity" stroke={color} strokeWidth={2} fill="url(#portfolio-value-fill)" dot={false} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
