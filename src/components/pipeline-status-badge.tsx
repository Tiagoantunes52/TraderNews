import Link from "next/link";
import { Activity } from "lucide-react";
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
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1 rounded-md border bg-muted/30">
      <Activity className="h-3 w-3" />
      <span className="hidden md:inline">{label}</span>
      <span className="md:hidden">
        {lastRun ? formatDistanceToNow(lastRun) : "—"}
      </span>
    </span>
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
