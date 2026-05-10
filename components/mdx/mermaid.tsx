"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const source = chart.replace(/\\n/g, "\n");
    loadMermaid().then(async (mermaid) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: resolvedTheme === "dark" ? "dark" : "default",
        securityLevel: "loose",
        fontFamily: "inherit",
      });
      try {
        const { svg, bindFunctions } = await mermaid.render(`m${id}`, source);
        if (cancelled) return;
        setSvg(svg);
        queueMicrotask(() => {
          if (containerRef.current) bindFunctions?.(containerRef.current);
        });
      } catch (err) {
        if (!cancelled) {
          setSvg(
            `<pre style="white-space:pre-wrap;color:#c33">Mermaid error: ${
              err instanceof Error ? err.message : String(err)
            }</pre>`,
          );
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) {
    return (
      <div className="my-4 rounded-md border border-fd-border bg-fd-muted/30 p-4 text-sm text-fd-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-4 flex justify-center overflow-x-auto rounded-md border border-fd-border bg-fd-card p-4"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted SVG from mermaid
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
