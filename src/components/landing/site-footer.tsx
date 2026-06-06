import Link from "next/link";
import { LineChart } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="border-t border-foreground/10">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <LineChart className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-semibold">TraderNews</span>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            · News &amp; sentiment for your watchlist
          </span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-5 text-sm">
          <Link
            href="/sign-in"
            className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Get started
          </Link>
        </nav>
      </div>

      <div className="border-t border-foreground/10 py-4">
        <p className="mx-auto w-full max-w-6xl px-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} TraderNews. For informational purposes only — not
          financial advice.
        </p>
      </div>
    </footer>
  );
}
