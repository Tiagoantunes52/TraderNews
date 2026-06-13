import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDistanceToNow } from "@/lib/format-date";

/** PURCHASE → emerald "Bought", SALE → rose "Sold" (mirrors the insider page's
 *  TXN_LABELS). AInvest only distinguishes buy/sell; EXCHANGE/OTHER are reserved. */
export const CONGRESS_TXN_LABELS: Record<string, string> = {
  PURCHASE: "Bought",
  SALE: "Sold",
  EXCHANGE: "Exchanged",
  OTHER: "Traded",
};

export type CongressTradeView = {
  id: string;
  /** Set on cross-watchlist lists (insider page) so each row links to its stock. */
  ticker?: string;
  politician: string;
  party: string | null;
  state: string | null;
  txnType: string;
  amountRange: string;
  transactionDate: string; // ISO
  disclosureDate: string; // ISO
  ptrLink: string | null;
};

function partyTone(party: string | null): string {
  const p = (party ?? "").toLowerCase();
  if (p.startsWith("d")) return "text-blue-600 dark:text-blue-400";
  if (p.startsWith("r")) return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

/**
 * Presentational list of congressional trades, shared by the stock detail page
 * (single ticker) and the insider page (cross-watchlist — pass `ticker` per row to
 * render a linked Badge). Buys read emerald, sells rose; a Tooltip on the relative
 * date surfaces the STOCK Act disclosure lag. The optional Filing anchor is safe to
 * open externally — only http(s) links are ever persisted (see congress-trades).
 */
export function CongressTradeList({ trades }: { trades: CongressTradeView[] }) {
  return (
    <div className="space-y-1.5">
      {trades.map((t) => {
        const tone =
          t.txnType === "PURCHASE"
            ? "text-emerald-600"
            : t.txnType === "SALE"
              ? "text-rose-600"
              : "text-muted-foreground";
        const lagDays = Math.max(
          0,
          Math.round((Date.parse(t.disclosureDate) - Date.parse(t.transactionDate)) / 86_400_000)
        );
        const relative = formatDistanceToNow(new Date(t.transactionDate));
        const titleMeta = [t.party, t.state].filter(Boolean).join(" · ");
        return (
          <div key={t.id} className="flex items-center justify-between text-xs gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              {t.ticker && (
                <Badge asChild variant="outline" className="shrink-0">
                  <Link href={`/dashboard/stocks/${t.ticker}`}>{t.ticker}</Link>
                </Badge>
              )}
              <span className="truncate" title={titleMeta ? `${t.politician} — ${titleMeta}` : t.politician}>
                <span className="text-muted-foreground">{t.politician}</span>
                {t.party && <span className={partyTone(t.party)}> · {t.party}</span>}
                {t.state && <span className="text-muted-foreground/60"> · {t.state}</span>}
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className={`font-medium ${tone}`}>{CONGRESS_TXN_LABELS[t.txnType] ?? t.txnType}</span>
              {t.amountRange && <span className="tabular-nums text-muted-foreground">{t.amountRange}</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground/70 cursor-help">{relative}</span>
                </TooltipTrigger>
                <TooltipContent>
                  Traded {relative}, disclosed {lagDays} day{lagDays === 1 ? "" : "s"} later
                </TooltipContent>
              </Tooltip>
              {t.ptrLink && (
                <a
                  href={t.ptrLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Filing
                </a>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
