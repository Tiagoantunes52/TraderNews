"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ChevronDown } from "lucide-react";

const PAGE_SIZE = 50;
const MAX_LIMIT = 500;

export function LoadMoreButton({ currentLimit }: { currentLimit: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const nextLimit = Math.min(currentLimit + PAGE_SIZE, MAX_LIMIT);
  const atCap = currentLimit >= MAX_LIMIT;

  const loadMore = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("limit", String(nextLimit));
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <div className="flex justify-center pt-2">
      <Button
        variant="outline"
        onClick={loadMore}
        disabled={pending || atCap}
        className="gap-2"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
        {atCap ? `Showing the most recent ${MAX_LIMIT}` : `Load ${PAGE_SIZE} more`}
      </Button>
    </div>
  );
}
