import { rehypeCodeDefaultOptions, remarkNpm } from "fumadocs-core/mdx-plugins";
import { metaSchema } from "fumadocs-core/source/schema";
import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";
import { transformerTwoslash } from "fumadocs-twoslash";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { z } from "zod";
import { remarkMermaid } from "./lib/remark-mermaid";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: frontmatterSchema.extend({
      feishuToken: z.string().optional(),
      lastSyncedAt: z.string().optional(),
      order: z.number().optional(),
      tags: z.array(z.string()).optional(),
    }),
    postprocess: {
      // Custom stringify: when a `<Mermaid chart="..." />` JSX node (emitted
      // by lib/remark-mermaid.ts) is serialised for /llms.mdx and friends,
      // turn it back into a ```mermaid fenced code block. Without this the
      // default "children-only" treatment for unknown JSX flow elements
      // would drop the chart from the LLM-facing markdown entirely.
      includeProcessedMarkdown: {
        stringify(node) {
          if (
            node &&
            typeof node === "object" &&
            "type" in node &&
            (node as { type: string }).type === "mdxJsxFlowElement" &&
            "name" in node &&
            (node as { name?: string }).name === "Mermaid"
          ) {
            const attrs = (
              node as {
                attributes?: Array<{
                  type: string;
                  name?: string;
                  value?: unknown;
                }>;
              }
            ).attributes;
            const chartAttr = attrs?.find(
              (a) => a.type === "mdxJsxAttribute" && a.name === "chart",
            );
            const raw = chartAttr?.value;
            const chart =
              typeof raw === "string"
                ? raw
                : raw && typeof raw === "object" && "value" in raw
                  ? String((raw as { value: unknown }).value ?? "")
                  : "";
            return `\`\`\`mermaid\n${chart}\n\`\`\``;
          }
        },
      },
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  // `lastModified` reads git log so each page exposes `page.data.lastModified`
  // for <PageLastUpdate /> in app/docs/[[...slug]]/page.tsx.
  plugins: [lastModified()],
  mdxOptions: {
    remarkPlugins: [
      remarkMermaid,
      remarkMath,
      // Auto-expand ```npm fenced blocks into Tab-style npm/pnpm/yarn/bun
      // codeblocks. The `persist` id keeps the chosen package manager in
      // sync across pages via Fumadocs UI's persisted Tab state.
      [remarkNpm, { persist: { id: "package-manager" } }],
    ],
    rehypePlugins: (v) => [rehypeKatex, ...v],
    rehypeCodeOptions: {
      themes: { light: "github-light", dark: "github-dark" },
      // Inherit Shiki's transformers for `[!code highlight]`, `[!code ++]`,
      // `[!code --]`, `[!code focus]`, `[!code word:Foo]` annotations,
      // then add Twoslash on top for `ts twoslash` hover-type popups.
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash(),
      ],
      // Twoslash needs all candidate languages declared up-front (no lazy
      // loading). Cover the languages we actually use across MDX bodies.
      langs: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "bash",
        "sh",
        "json",
        "yaml",
        "html",
        "css",
        "md",
        "mdx",
        "python",
        "powershell",
        "sql",
        "dockerfile",
      ],
    },
  },
});
