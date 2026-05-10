"use client";

import type { ReactElement, ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

/**
 * Generic responsive Recharts wrapper. Pass a single Recharts root element
 * (LineChart / BarChart / PieChart / AreaChart …) as `children`.
 *
 * Recharts requires a client component because it uses ResizeObserver.
 */
export function Chart({
  children,
  height = 300,
  className,
}: {
  children: ReactNode;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={
        className ??
        "my-6 w-full rounded-xl border border-fd-border bg-fd-card/40 p-4"
      }
      style={{ minHeight: height }}
    >
      <ResponsiveContainer width="100%" height={height}>
        {children as ReactElement}
      </ResponsiveContainer>
    </div>
  );
}
