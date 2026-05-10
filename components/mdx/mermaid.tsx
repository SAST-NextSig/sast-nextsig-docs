"use client";

import { Check, Copy, Download } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useId, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let lastInitTheme: "dark" | "default" | null = null;

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
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Authors sometimes write a literal `\n` inside Mermaid labels/Notes
    // hoping for a visible line break. Replacing it with an actual newline
    // breaks the source parser (the next directive looks like a
    // continuation of the previous statement). Use `<br/>` instead — with
    // `securityLevel: "loose"` Mermaid renders it as a line break inside
    // the label and leaves the surrounding source structure intact.
    const source = chart.replace(/\\n/g, "<br/>");
    const themeName: "dark" | "default" =
      resolvedTheme === "dark" ? "dark" : "default";
    loadMermaid().then(async (mermaid) => {
      // mermaid.initialize is global — only call when the theme actually
      // changed to avoid mid-render reconfiguration races between charts.
      if (lastInitTheme !== themeName) {
        mermaid.initialize({
          startOnLoad: false,
          theme: themeName,
          securityLevel: "loose",
          fontFamily: "inherit",
        });
        lastInitTheme = themeName;
      }
      try {
        const { svg, bindFunctions } = await mermaid.render(`m${id}`, source);
        if (cancelled) return;
        setSvg(svg);
        setError(null);
        queueMicrotask(() => {
          if (containerRef.current) bindFunctions?.(containerRef.current);
        });
      } catch (err) {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(chart);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard rejection (insecure context, denied permission)
    }
  }, [chart]);

  const handleDownloadSvg = useCallback(() => {
    if (!svg) return;
    triggerDownload(
      new Blob([withXmlHeader(svg)], { type: "image/svg+xml;charset=utf-8" }),
      "diagram.svg",
    );
  }, [svg]);

  const handleDownloadPng = useCallback(async () => {
    if (!svg) return;
    const blob = await svgToPngBlob(svg);
    if (blob) triggerDownload(blob, "diagram.png");
  }, [svg]);

  return (
    <div className="group relative my-4 rounded-md border border-fd-border bg-fd-card">
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <ToolbarButton
          label="Copy source"
          onClick={handleCopy}
          icon={
            copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )
          }
        />
        <ToolbarButton
          label="Download SVG"
          disabled={!svg}
          onClick={handleDownloadSvg}
          icon={
            <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide">
              <Download className="h-3.5 w-3.5" />
              SVG
            </span>
          }
        />
        <ToolbarButton
          label="Download PNG"
          disabled={!svg}
          onClick={handleDownloadPng}
          icon={
            <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide">
              <Download className="h-3.5 w-3.5" />
              PNG
            </span>
          }
        />
      </div>

      {error ? (
        <pre className="m-0 overflow-x-auto p-4 text-sm text-red-600 dark:text-red-400">
          Mermaid error: {error}
        </pre>
      ) : svg ? (
        <div
          ref={containerRef}
          className="flex justify-center overflow-x-auto p-4"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted SVG from mermaid
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="p-4 text-sm text-fd-muted-foreground">
          Rendering diagram…
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-md border border-fd-border bg-fd-background/80 px-2 py-1 text-fd-muted-foreground shadow-sm backdrop-blur transition hover:bg-fd-accent hover:text-fd-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Safari has a chance to honour the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function withXmlHeader(svg: string): string {
  return svg.startsWith("<?xml") ? svg : `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`;
}

/**
 * Rasterise the rendered Mermaid SVG to a PNG. Mermaid's SVG often only sets
 * `viewBox` (no explicit width/height), which makes <img> render at 0×0; we
 * patch dimensions in before drawing onto a 2x-DPI canvas.
 */
async function svgToPngBlob(svg: string): Promise<Blob | null> {
  const { source, width, height } = prepareSvgForRaster(svg);
  return await new Promise<Blob | null>((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(
      new Blob([source], { type: "image/svg+xml;charset=utf-8" }),
    );
    img.onload = () => {
      const scale = 2;
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => resolve(b), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function prepareSvgForRaster(svg: string): {
  source: string;
  width: number;
  height: number;
} {
  let width = 800;
  let height = 600;
  const viewBox = svg.match(
    /\bviewBox\s*=\s*"([\d.\-\s]+)"/i,
  );
  if (viewBox) {
    const parts = viewBox[1].split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width = parts[2] || width;
      height = parts[3] || height;
    }
  }
  const widthAttr = svg.match(/\bwidth\s*=\s*"([\d.]+)/i);
  const heightAttr = svg.match(/\bheight\s*=\s*"([\d.]+)/i);
  if (widthAttr) width = Number(widthAttr[1]) || width;
  if (heightAttr) height = Number(heightAttr[1]) || height;

  let source = svg;
  if (!/\bwidth\s*=/.test(source)) {
    source = source.replace(/<svg\b/i, `<svg width="${width}"`);
  }
  if (!/\bheight\s*=/.test(source)) {
    source = source.replace(/<svg\b/i, `<svg height="${height}"`);
  }
  return { source, width, height };
}
