import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Dotted-underline styling for an inline text hint trigger. */
export const HINT_TEXT =
  "underline decoration-dotted decoration-muted-foreground/40 underline-offset-2";

/**
 * A hover/focus tooltip with a label trigger. Uses the default Radix trigger
 * element (not `asChild`) so it composes cleanly inside Server Components; the
 * global TooltipProvider lives in the root layout. Wrap plain text (pass
 * `className={HINT_TEXT}` for the dotted underline) or a Badge as the child.
 */
export function Hint({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger className={cn("cursor-help text-left", className)}>{children}</TooltipTrigger>
      <TooltipContent className="text-balance">{text}</TooltipContent>
    </Tooltip>
  );
}
