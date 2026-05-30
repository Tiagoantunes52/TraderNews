"use client";

import { ResponsiveContainer, AreaChart, Area, Tooltip, ReferenceLine } from "recharts";
import { formatDistanceToNow } from "@/lib/format-date";
import { mood } from "@/lib/mood";

export type SparklinePoint = { date: string; score: number; summary: string | null };

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: SparklinePoint }[] }) {
  if (!active || !payload?.length) return null;
  const { score, summary, date } = payload[0].payload;
  const m = mood(score);
  return (
    <div className="bg-background border rounded-xl p-3 shadow-lg text-sm max-w-[200px]">
      <p className="font-semibold">{m.emoji} {score.toFixed(2)}</p>
      {summary && <p className="text-muted-foreground text-xs mt-1 leading-relaxed">{summary}</p>}
      <p className="text-muted-foreground text-xs mt-1">{formatDistanceToNow(new Date(date))}</p>
    </div>
  );
}

export function SentimentSparkline({
  data,
  color,
  gradientId,
}: {
  data: SparklinePoint[];
  color: string;
  gradientId: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={80}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -30, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <ReferenceLine
          y={0}
          stroke="currentColor"
          className="text-muted-foreground"
          opacity={0.4}
          strokeDasharray="3 3"
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="score"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 4, fill: color }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
