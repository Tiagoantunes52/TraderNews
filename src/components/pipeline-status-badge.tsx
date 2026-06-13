import Link from "next/link";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "@/lib/format-date";

export function PipelineStatusBadge({
  lastRun,
  isAdmin,
}: {
  lastRun: Date | null;
  isAdmin: boolean;
}) {
  const label = lastRun ? `Updated ${formatDistanceToNow(lastRun)}` : "Never run";

  const body = (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground bg-muted/30">
      <Activity className="h-3 w-3" />
      <span className="hidden md:inline">{label}</span>
      <span className="md:hidden">
        {lastRun ? formatDistanceToNow(lastRun) : "—"}
      </span>
    </Badge>
  );

  // Admin: clickable into Settings to run the pipeline. Non-admin: read-only.
  return isAdmin ? (
    <Link
      href="/dashboard/settings"
      title="Open settings to run the pipeline"
      className="hover:text-foreground transition-colors"
    >
      {body}
    </Link>
  ) : (
    body
  );
}
