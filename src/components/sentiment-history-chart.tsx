"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { formatDistanceToNow } from "@/lib/format-date";

export type SentimentPoint = { date: string; score: number; summary: string | null };

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: SentimentPoint }[] }) {
  if (!active || !payload?.length) return null;
  const { score, summary, date } = payload[0].payload;
  return (
    <div className="bg-background border rounded-xl p-3 shadow-lg text-sm max-w-[260px]">
      <p className="font-semibold tabular-nums">{score.toFixed(2)}</p>
      {summary && <p className="text-muted-foreground text-xs mt-1 leading-relaxed">{summary}</p>}
      <p className="text-muted-foreground text-xs mt-1">{formatDistanceToNow(new Date(date))}</p>
    </div>
  );
}

export function SentimentHistoryChart({
  data,
  color,
  height = 240,
}: {
  data: SentimentPoint[];
  color: string;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div className="text-center text-sm text-muted-foreground py-12">
        Not enough sentiment readings to plot a trend yet. Run the pipeline a few more times.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="sentiment-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.35} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="currentColor"
          className="text-border"
          opacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "currentColor" }}
          tickFormatter={(d: string) =>
            new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })
          }
          stroke="currentColor"
          className="text-muted-foreground"
        />
        <YAxis
          domain={[-1, 1]}
          tick={{ fontSize: 11, fill: "currentColor" }}
          stroke="currentColor"
          className="text-muted-foreground"
        />
        <ReferenceLine
          y={0}
          stroke="currentColor"
          className="text-muted-foreground"
          strokeDasharray="3 3"
          opacity={0.6}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="score"
          stroke={color}
          strokeWidth={2.5}
          fill="url(#sentiment-grad)"
          dot={{ r: 3, fill: color }}
          activeDot={{ r: 5, fill: color }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
