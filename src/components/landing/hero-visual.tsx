import { TrendingUp, TrendingDown, Activity } from "lucide-react";

/**
 * Lightweight mock dashboard for the hero. Pure server component — built only
 * from divs, SVG and CSS (no images, no client JS, fake data). Sells the
 * product visually without any layout shift or runtime cost.
 */

type MockStock = {
  ticker: string;
  name: string;
  score: number;
  label: string;
  emoji: string;
  // Tailwind classes kept literal so they survive JIT extraction.
  bar: string;
  text: string;
};

const MOCK_STOCKS: MockStock[] = [
  { ticker: "NVDA", name: "NVIDIA", score: 0.82, label: "Very Bullish", emoji: "🚀", bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  { ticker: "AAPL", name: "Apple", score: 0.41, label: "Bullish", emoji: "📈", bar: "bg-green-500", text: "text-green-600 dark:text-green-400" },
  { ticker: "TSLA", name: "Tesla", score: -0.12, label: "Neutral", emoji: "😐", bar: "bg-slate-400", text: "text-slate-500 dark:text-slate-400" },
  { ticker: "INTC", name: "Intel", score: -0.54, label: "Bearish", emoji: "📉", bar: "bg-orange-500", text: "text-orange-600 dark:text-orange-400" },
];

// Fixed sparkline path — drawn once, no animation cost.
const SPARK_POINTS = [4, 9, 7, 13, 11, 18, 16, 24, 21, 30, 34, 31, 40];

function sparkPath(points: number[], width: number, height: number) {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  return points
    .map((p, i) => {
      const x = i * step;
      const y = height - ((p - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function HeroVisual() {
  const path = sparkPath(SPARK_POINTS, 100, 32);

  return (
    <div
      aria-hidden
      className="relative w-full max-w-md"
    >
      {/* Ambient glow behind the card */}
      <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-tr from-emerald-500/20 via-primary/10 to-transparent blur-2xl" />

      <div className="rounded-2xl border border-foreground/10 bg-card/80 p-4 shadow-xl ring-1 ring-foreground/5 backdrop-blur-sm sm:p-5">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Activity className="h-4 w-4" />
            </span>
            <p className="text-sm font-semibold">Watchlist Mood</p>
          </div>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Live
          </span>
        </div>

        {/* Mood gauge */}
        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="text-4xl font-bold tabular-nums">+0.39</p>
            <p className="mt-0.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              Bullish across 4 tickers
            </p>
          </div>
          <span className="text-4xl" aria-hidden>
            📈
          </span>
        </div>

        {/* Sparkline */}
        <div className="mt-4 rounded-xl bg-muted/50 p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>News velocity · 24h</span>
            <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
              <TrendingUp className="h-3 w-3" /> +28%
            </span>
          </div>
          <svg
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            className="mt-2 h-9 w-full overflow-visible"
            role="presentation"
          >
            <defs>
              <linearGradient id="heroSparkFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${path} L100,32 L0,32 Z`} fill="url(#heroSparkFill)" />
            <path
              d={path}
              fill="none"
              stroke="rgb(16 185 129)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>

        {/* Watchlist rows */}
        <ul className="mt-4 space-y-2">
          {MOCK_STOCKS.map((s) => {
            const pct = Math.round((Math.abs(s.score) / 1) * 100);
            return (
              <li key={s.ticker} className="flex items-center gap-3">
                <div className="w-12 shrink-0">
                  <p className="text-sm font-semibold leading-none">{s.ticker}</p>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{s.name}</p>
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${s.bar}`}
                    style={{ width: `${Math.max(pct, 8)}%` }}
                  />
                </div>
                <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                  <span className={`text-sm font-medium tabular-nums ${s.text}`}>
                    {s.score > 0 ? "+" : ""}
                    {s.score.toFixed(2)}
                  </span>
                  <span aria-hidden>{s.emoji}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Floating insider-alert chip */}
      <div className="absolute -bottom-4 -right-3 hidden rotate-2 rounded-xl border border-foreground/10 bg-card px-3 py-2 shadow-lg sm:flex sm:items-center sm:gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <TrendingUp className="h-3.5 w-3.5" />
        </span>
        <div>
          <p className="text-xs font-semibold leading-none">Insider buy · CEO</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">$2.1M cluster · NVDA</p>
        </div>
      </div>

      {/* Floating bearish chip */}
      <div className="absolute -left-4 top-10 hidden -rotate-3 rounded-xl border border-foreground/10 bg-card px-3 py-2 shadow-lg md:flex md:items-center md:gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-red-500/15 text-red-600 dark:text-red-400">
          <TrendingDown className="h-3.5 w-3.5" />
        </span>
        <div>
          <p className="text-xs font-semibold leading-none">RSI overbought</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Signal · INTC</p>
        </div>
      </div>
    </div>
  );
}
