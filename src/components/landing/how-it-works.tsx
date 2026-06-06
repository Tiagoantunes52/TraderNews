import { ListPlus, ScanSearch, BellRing } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/landing/reveal";

type Step = {
  icon: LucideIcon;
  title: string;
  description: string;
};

const STEPS: Step[] = [
  {
    icon: ListPlus,
    title: "Build your watchlist",
    description: "Add the tickers you actually hold or track. That's the whole setup.",
  },
  {
    icon: ScanSearch,
    title: "We watch the wires",
    description:
      "News, sentiment, quant signals and SEC filings are pulled and scored around your list — continuously.",
  },
  {
    icon: BellRing,
    title: "Get the alerts that matter",
    description:
      "Sentiment swings, RSI extremes, news spikes and insider buys land in your dashboard and inbox.",
  },
];

export function HowItWorks() {
  return (
    <section
      aria-labelledby="how-heading"
      className="border-y border-foreground/10 bg-muted/30"
    >
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2
            id="how-heading"
            className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            From watchlist to alert in three steps
          </h2>
        </Reveal>

        <ol className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-3">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <Reveal
                as="li"
                key={step.title}
                delay={i * 110}
                className="relative flex flex-col items-center text-center"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-foreground/10 bg-card text-emerald-600 shadow-sm dark:text-emerald-400">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span
                  aria-hidden
                  className="mt-4 text-xs font-semibold tracking-widest text-muted-foreground uppercase"
                >
                  Step {i + 1}
                </span>
                <h3 className="mt-1 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </Reveal>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
