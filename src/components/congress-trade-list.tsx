import Link from "next/link";
import { TrendingUp, TrendingDown, ArrowLeftRight, ExternalLink } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format-date";

/** PURCHASE → emerald "Bought", SALE → rose "Sold". AInvest only distinguishes
 *  buy/sell; EXCHANGE/OTHER are reserved for a richer source. */
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function partyLabel(party: string | null): string | null {
  const p = (party ?? "").toLowerCase();
  if (p.startsWith("d")) return "Democrat";
  if (p.startsWith("r")) return "Republican";
  return party || null;
}

/** Party-tinted avatar fallback (blue Dem / red Rep / neutral). */
function partyAvatarTone(party: string | null): string {
  const p = (party ?? "").toLowerCase();
  if (p.startsWith("d")) return "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300";
  if (p.startsWith("r")) return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
  return "bg-muted text-muted-foreground";
}

/** En-dash the amount range for typographic polish ("$1K-$15K" → "$1K–$15K"). */
function fmtAmount(range: string): string {
  return range.replace(/\s*-\s*/g, "–");
}

/**
 * CapitolTrades-style list of congressional trades, shared by the stock detail
 * page (single ticker) and the insider page (cross-watchlist — pass `ticker` per
 * row to render a linked badge). Each row: a party-tinted avatar, the politician
 * with party·state and the trade/disclosure timing, and a right-aligned buy/sell
 * pill with the dollar range. The Filing link is safe to open externally — only
 * http(s) links are ever persisted (see congress-trades).
 */
export function CongressTradeList({ trades }: { trades: CongressTradeView[] }) {
  return (
    <ul className="divide-y divide-border">
      {trades.map((t) => {
        const bought = t.txnType === "PURCHASE";
        const sold = t.txnType === "SALE";
        const SideIcon = bought ? TrendingUp : sold ? TrendingDown : ArrowLeftRight;
        const sideClass = bought
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
          : sold
            ? "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
            : "bg-muted text-muted-foreground";
        const lagDays = Math.max(
          0,
          Math.round((Date.parse(t.disclosureDate) - Date.parse(t.transactionDate)) / 86_400_000)
        );
        const sub = [partyLabel(t.party), t.state].filter(Boolean).join(" · ");

        return (
          <li key={t.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Avatar className="size-9 shrink-0">
              <AvatarFallback className={cn("text-xs font-semibold", partyAvatarTone(t.party))}>
                {initials(t.politician)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{t.politician}</span>
                {t.ticker && (
                  <Badge asChild variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
                    <Link href={`/dashboard/stocks/${t.ticker}`}>{t.ticker}</Link>
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {sub && <span>{sub} · </span>}
                <span>traded {formatDistanceToNow(new Date(t.transactionDate))}</span>
                {lagDays > 0 && <span> · filed {lagDays}d later</span>}
              </p>
            </div>

            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge className={cn("gap-1 font-medium", sideClass)}>
                <SideIcon className="size-3" />
                {CONGRESS_TXN_LABELS[t.txnType] ?? t.txnType}
              </Badge>
              <div className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                {t.amountRange && <span>{fmtAmount(t.amountRange)}</span>}
                {t.ptrLink && (
                  <a
                    href={t.ptrLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="View filing"
                    className="inline-flex items-center text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
