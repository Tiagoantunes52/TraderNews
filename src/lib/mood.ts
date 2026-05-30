export type Mood = {
  emoji: string;
  label: string;
  gradient: string;
  chartColor: string;
  text: string;
};

export function mood(score: number): Mood {
  if (score > 0.6)
    return {
      emoji: "🚀",
      label: "Very Bullish",
      gradient: "from-emerald-400 to-green-500",
      chartColor: "#22c55e",
      text: "text-emerald-600 dark:text-emerald-400",
    };
  if (score > 0.2)
    return {
      emoji: "📈",
      label: "Bullish",
      gradient: "from-green-300 to-emerald-400",
      chartColor: "#4ade80",
      text: "text-green-600 dark:text-green-400",
    };
  if (score > -0.2)
    return {
      emoji: "😐",
      label: "Neutral",
      gradient: "from-slate-500 to-slate-600",
      chartColor: "#64748b",
      text: "text-slate-500 dark:text-slate-400",
    };
  if (score > -0.6)
    return {
      emoji: "📉",
      label: "Bearish",
      gradient: "from-orange-300 to-red-400",
      chartColor: "#f97316",
      text: "text-orange-600 dark:text-orange-400",
    };
  return {
    emoji: "🔻",
    label: "Very Bearish",
    gradient: "from-red-400 to-rose-500",
    chartColor: "#ef4444",
    text: "text-red-600 dark:text-red-400",
  };
}

export type MoodBucket = "bull" | "bear" | "neutral" | "none";

export function moodBucket(score: number | undefined | null): MoodBucket {
  if (score === undefined || score === null) return "none";
  if (score > 0.2) return "bull";
  if (score < -0.2) return "bear";
  return "neutral";
}
