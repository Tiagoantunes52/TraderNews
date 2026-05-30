"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
] as const;

type ThemeValue = (typeof OPTIONS)[number]["value"];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount detection to avoid hydration mismatch
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="h-8 w-8 sm:w-[88px] rounded-md bg-muted/50" aria-hidden />;
  }

  const current = (theme ?? "system") as ThemeValue;
  const currentOption = OPTIONS.find((o) => o.value === current) ?? OPTIONS[1];
  const NextIcon = currentOption.icon;
  const nextIndex = (OPTIONS.findIndex((o) => o.value === current) + 1) % OPTIONS.length;
  const nextValue = OPTIONS[nextIndex].value;

  return (
    <>
      {/* Mobile: single cycling icon button */}
      <Button
        variant="outline"
        size="icon"
        onClick={() => setTheme(nextValue)}
        aria-label={`Theme: ${currentOption.label} (tap for ${OPTIONS[nextIndex].label})`}
        className="h-8 w-8 sm:hidden"
      >
        <NextIcon className="h-4 w-4" />
      </Button>

      {/* sm+: segmented control */}
      <div className="hidden sm:inline-flex items-center rounded-md border bg-background p-0.5">
        {OPTIONS.map(({ value, icon: Icon, label }) => (
          <Button
            key={value}
            variant="ghost"
            size="icon"
            onClick={() => setTheme(value)}
            aria-label={`${label} theme`}
            aria-pressed={current === value}
            className={cn(
              "h-7 w-7 rounded-sm",
              current === value && "bg-muted text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        ))}
      </div>
    </>
  );
}
