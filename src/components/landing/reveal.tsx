"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type RevealProps = React.ComponentProps<"div"> & {
  /** Optional render delay in ms, applied via inline transition-delay for staggering. */
  delay?: number;
  /** Render as a different element (e.g. "li", "section"). Defaults to "div". */
  as?: React.ElementType;
};

/**
 * Scroll-reveal wrapper.
 *
 * Children start hidden (translated + faded) and animate into place the first
 * time the element scrolls into the viewport. The whole effect is CSS-driven —
 * this component only toggles the `is-visible` class via IntersectionObserver,
 * keeping the shipped JS tiny.
 *
 * Reduced motion: the `.reveal` base styles below are disabled under
 * `prefers-reduced-motion: reduce` (see globals.css), so content is shown
 * immediately with no transform/opacity animation regardless of this class.
 */
export function Reveal({ className, delay, as, style, children, ...props }: RevealProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  const Comp = (as ?? "div") as React.ElementType;

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // If IntersectionObserver is unavailable, just show the content.
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- rare no-IO fallback; reveal immediately
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Comp
      ref={ref}
      className={cn("reveal", visible && "is-visible", className)}
      style={delay ? { ...style, transitionDelay: `${delay}ms` } : style}
      {...props}
    >
      {children}
    </Comp>
  );
}
