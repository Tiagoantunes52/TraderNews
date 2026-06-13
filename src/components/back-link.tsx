"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BackLink({ fallbackHref = "/dashboard", label = "Back" }: { fallbackHref?: string; label?: string }) {
  const router = useRouter();

  const onClick = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  };

  return (
    <Button
      variant="link"
      onClick={onClick}
      className="h-auto gap-1 p-0 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </Button>
  );
}
