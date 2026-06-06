import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/landing/reveal";

export function CallToAction() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
      <Reveal className="relative overflow-hidden rounded-3xl border border-foreground/10 bg-card px-6 py-14 text-center shadow-sm sm:px-12">
        {/* Decorative glow — pure CSS. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-emerald-500/10 via-transparent to-primary/5"
        />
        <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          Start reading your portfolio&apos;s mood today
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground text-pretty">
          Set up your watchlist in seconds. News, sentiment, signals and insider alerts —
          all scoped to the tickers you care about.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
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
      </Reveal>
    </section>
  );
}
