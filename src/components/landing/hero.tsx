import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVisual } from "@/components/landing/hero-visual";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Decorative background: theme-aware gradient wash + grid. Pure CSS, no images. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-emerald-500/5 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -z-10 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl dark:bg-emerald-500/15"
      />

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 px-6 py-20 sm:py-28 lg:grid-cols-2 lg:gap-8">
        {/* Copy — entrance animations run on load via the `hero-rise` utility. */}
        <div className="max-w-xl">
          <span className="hero-rise inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            AI sentiment · quant signals · insider intel
          </span>

          <h1 className="hero-rise hero-rise-1 mt-5 text-4xl font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            News &amp; sentiment for{" "}
            <span className="bg-gradient-to-r from-emerald-500 to-green-600 bg-clip-text text-transparent dark:from-emerald-400 dark:to-green-400">
              your watchlist
            </span>
          </h1>

          <p className="hero-rise hero-rise-2 mt-5 text-lg text-muted-foreground text-pretty">
            Track market news and AI-powered sentiment for the stocks you care about.
            Quant signals and SEC insider buys surface the moves that matter — scoped to
            your portfolio, not the whole market.
          </p>

          <div className="hero-rise hero-rise-3 mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="group/cta h-11 px-5 text-sm">
              <Link href="/sign-up">
                Get started
                <ArrowRight className="transition-transform duration-200 group-hover/cta:translate-x-0.5" aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="h-11 px-5 text-sm">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>

          <dl className="hero-rise hero-rise-4 mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Sources</dt>
              <dd className="font-semibold">Multi-feed aggregation</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Scoring</dt>
              <dd className="font-semibold">Confidence + aspects</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Filings</dt>
              <dd className="font-semibold">SEC Form 4 alerts</dd>
            </div>
          </dl>
        </div>

        {/* Visual */}
        <div className="hero-rise hero-rise-2 flex justify-center lg:justify-end">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}
