import {
  Newspaper,
  Brain,
  Gauge,
  ShieldCheck,
  Star,
  Mail,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/landing/reveal";

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
  // Literal Tailwind classes so JIT keeps them.
  accent: string;
};

const FEATURES: Feature[] = [
  {
    icon: Newspaper,
    title: "Real-time market news",
    description:
      "Headlines aggregated from multiple sources and matched to the tickers on your watchlist — no more tab-hopping across a dozen feeds.",
    accent: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  {
    icon: Brain,
    title: "AI-powered sentiment",
    description:
      "Every headline is scored with structured sentiment — score, confidence and aspects — so you read the mood of your portfolio at a glance.",
    accent: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  {
    icon: Gauge,
    title: "Quant signals",
    description:
      "Technical triggers like RSI extremes and news-velocity spikes surface automatically as alerts — the moves that matter, before the crowd.",
    accent: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  {
    icon: ShieldCheck,
    title: "Insider intelligence",
    description:
      "SEC Form 4 tracking with C-suite conviction-buy and cluster-buy alerts. See when the people who know the company are putting money in.",
    accent: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  {
    icon: Star,
    title: "Your watchlist",
    description:
      "Track only the tickers you care about. Everything — news, sentiment and signals — is scoped to your portfolio, not the whole market.",
    accent: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  },
  {
    icon: Mail,
    title: "Email alert digests",
    description:
      "Get a clean digest when something moves — sentiment swings, fresh signals or insider activity — so you never miss the headline that matters.",
    accent: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  },
];

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28"
    >
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
          Everything in one place
        </p>
        <h2
          id="features-heading"
          className="mt-3 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
        >
          The signal, without the noise
        </h2>
        <p className="mt-4 text-base text-muted-foreground text-pretty">
          TraderNews pulls the market apart into the pieces that actually move your
          positions — and puts them back together around your watchlist.
        </p>
      </Reveal>

      <ul className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, i) => {
          const Icon = feature.icon;
          return (
            <Reveal
              as="li"
              key={feature.title}
              delay={(i % 3) * 90}
              className="group/feature relative flex flex-col rounded-2xl border border-foreground/10 bg-card p-6 shadow-xs ring-1 ring-foreground/5 transition-transform duration-300 motion-safe:hover:-translate-y-1"
            >
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-xl ${feature.accent}`}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </Reveal>
          );
        })}
      </ul>
    </section>
  );
}
