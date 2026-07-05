"use client";

// Pure-SVG sparkline (no recharts) so the sentiment/insights routes don't pay
// the chart-library bundle for an 80px decoration (issue #64). Visuals match
// the old recharts version: gradient area, dashed zero line, hover tooltip.
import { useRef, useState } from "react";
import { formatDistanceToNow } from "@/lib/format-date";
import { mood } from "@/lib/mood";

export type SparklinePoint = { date: string; score: number; summary: string | null };

const W = 100;
const H = 80;

// Monotone cubic (Fritsch–Carlson) interpolation — the same shape recharts
// draws for type="monotone": smooth, but never overshooting the data.
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push((pts[i + 1].y - pts[i].y) / (dx[i] || 1e-9));
  }
  const t: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) t.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  t.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const f = 3 / Math.sqrt(s);
      t[i] = f * a * slope[i];
      t[i + 1] = f * b * slope[i];
    }
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i].x + dx[i] / 3;
    const y1 = pts[i].y + (t[i] * dx[i]) / 3;
    const x2 = pts[i + 1].x - dx[i] / 3;
    const y2 = pts[i + 1].y - (t[i + 1] * dx[i]) / 3;
    d += `C${x1},${y1},${x2},${y2},${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
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
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  if (data.length === 0) return <div style={{ height: H }} />;

  // Domain always includes 0 so the reference line is visible.
  const min = Math.min(0, ...data.map((p) => p.score));
  const max = Math.max(0, ...data.map((p) => p.score));
  const pad = (max - min) * 0.05 || 0.1;
  const lo = min - pad;
  const hi = max + pad;
  const pts = data.map((p, i) => ({
    x: data.length === 1 ? W / 2 : (i / (data.length - 1)) * W,
    y: H - ((p.score - lo) / (hi - lo)) * H,
  }));
  const line = monotonePath(pts);
  const area = `${line}L${pts[pts.length - 1].x},${H}L${pts[0].x},${H}Z`;
  const zeroY = H - ((0 - lo) / (hi - lo)) * H;

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(frac * (data.length - 1)))));
  };

  const h = hover != null ? data[hover] : null;

  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height: H }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line
          x1={0}
          x2={W}
          y1={zeroY}
          y2={zeroY}
          stroke="currentColor"
          className="text-muted-foreground"
          opacity={0.4}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill={`url(#${gradientId})`} stroke="none" />
        <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      {h && hover != null && (
        <>
          <span
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${pts[hover].x}%`, top: `${(pts[hover].y / H) * 100}%`, background: color }}
          />
          <div
            className="pointer-events-none absolute top-1 z-10 max-w-[200px] rounded-xl border bg-background p-3 text-sm shadow-lg"
            style={{
              left: `${pts[hover].x}%`,
              transform: pts[hover].x > W / 2 ? "translateX(-100%)" : undefined,
            }}
          >
            <p className="font-semibold">
              {mood(h.score).emoji} {h.score.toFixed(2)}
            </p>
            {h.summary && <p className="text-muted-foreground text-xs mt-1 leading-relaxed">{h.summary}</p>}
            <p className="text-muted-foreground text-xs mt-1">{formatDistanceToNow(new Date(h.date))}</p>
          </div>
        </>
      )}
    </div>
  );
}
