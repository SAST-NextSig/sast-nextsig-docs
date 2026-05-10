# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A documentation site built on **Fumadocs** (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) running on **Next.js 16** App Router with **React 19** and **TypeScript 6**. Beyond a standard docs site, it ships:

- An **AI chat search** (`/api/chat`) backed by OpenRouter + the Vercel AI SDK, with a flexsearch-indexed `search` tool over docs content.
- **LLM-friendly endpoints** — `/llms.txt`, `/llms-full.txt`, and per-page `/llms.mdx/docs/<slug>/content.md` raw markdown.
- **Dynamic OG images** at `/og/docs/<slug>/image.png` rendered via `next/og`.
- Content negotiation in `proxy.ts` so doc URLs return markdown when the client prefers it.

Package manager is **pnpm** (`pnpm-lock.yaml`). Lint/format is **Biome**, not ESLint+Prettier — don't introduce a second formatter.

## Commands

```bash
pnpm dev              # Next.js dev server (http://localhost:3000)
pnpm build            # production build
pnpm start            # serve production build
pnpm types:check      # fumadocs-mdx && next typegen && tsc --noEmit  ← see note below
pnpm lint             # biome check
pnpm format           # biome format --write
```

**`pnpm types:check` is the only correct typecheck.** Running `tsc` alone fails because (a) `fumadocs-mdx` must regenerate `.source/` (the `collections/*` import target) and (b) `next typegen` produces the `LayoutProps<…>` / `PageProps<…>` / `RouteContext<…>` global types used throughout `app/`.

`postinstall` runs `fumadocs-mdx` automatically — if `.source/` is missing after a fresh clone, run `pnpm install` (or `pnpm exec fumadocs-mdx`) before anything else.

## Environment

`.env.local` (gitignored) needs:

- `OPENROUTER_API_KEY` — required for `/api/chat` to work.
- `OPENROUTER_MODEL` — optional override; defaults to `anthropic/claude-3.5-sonnet` (see `app/api/chat/route.ts`).

## Architecture

### Content pipeline (the load-bearing part)

```
content/docs/*.mdx
    │  (fumadocs-mdx postprocess; configured in source.config.ts)
    ▼
.source/             ← gitignored, generated artifact
    │  imported as `collections/server` via tsconfig path alias
    ▼
lib/source.ts        ← creates the Fumadocs `source` loader (single source of truth for pages)
    │
    ├─► app/docs/[[...slug]]/page.tsx  (HTML doc pages)
    ├─► app/api/search/route.ts         (Fumadocs/Orama search index)
    ├─► app/api/chat/route.ts           (flexsearch index for AI chat tool)
    ├─► app/llms.txt + llms-full.txt    (LLM index + concatenated dump)
    ├─► app/llms.mdx/docs/[[...slug]]   (per-page raw markdown)
    └─► app/og/docs/[...slug]           (per-page OG images)
```

Two things to know:

1. **`source.config.ts` sets `postprocess.includeProcessedMarkdown: true`.** That's what enables `page.data.getText('processed')` used by the LLM endpoints and the AI chat search. Don't remove it.
2. **`lib/source.ts` is the only place that calls `loader(...)`.** All consumers (HTML pages, search routes, og routes, llms routes) go through the same `source` instance. Changing the source schema touches everything downstream.

### `proxy.ts` (Next.js 16 proxy / formerly middleware)

Two rewrite rules — order matters:

- `/docs/<path>.md` → `/llms.mdx/docs/<path>/content.md` (explicit suffix).
- If `Accept` headers prefer markdown (`isMarkdownPreferred`): `/docs/<path>` → `/llms.mdx/docs/<path>/content.md` (content negotiation).

This is how the same canonical URL serves HTML to browsers and markdown to LLM clients / curl.

### AI chat (`app/api/chat/route.ts`)

- The flexsearch index is built once at module load (`searchServer = createSearchServer()`). It iterates `source.getPages()` and pulls `page.data.getText('processed')` in chunks of 50.
- Streams via `streamText` from `ai`, with `stopWhen: stepCountIs(5)` capping tool-call iterations.
- Custom UI message type `ChatUIMessage` carries a `data-client` part with `location.href` — `convertDataPart` turns it into a synthetic system text so the model knows the user's current page.
- The exported `SearchTool` type is imported by `components/ai/search.tsx` to keep client/server tool typing in sync — when you change the tool's `inputSchema` or output, the client picks it up automatically.

### Routing & layouts

- `app/(home)` — landing pages (route group, doesn't affect URL).
- `app/docs/layout.tsx` — wraps `DocsLayout` and mounts the `<AISearch>` provider + floating "Ask AI" trigger.
- `app/docs/[[...slug]]/page.tsx` — renders MDX from `source.getPage(slug)`, with `MarkdownCopyButton` and `ViewOptionsPopover` linking to GitHub via `gitConfig` from `lib/shared.ts`.
- `lib/layout.shared.tsx` — shared nav/branding for `HomeLayout` and `DocsLayout`. Reads `appName` and `gitConfig` from `lib/shared.ts`.

### Path aliases (tsconfig)

- `@/*` → repo root (e.g. `@/lib/source`, `@/components/mdx`).
- `collections/*` → `./.source/*` — used only by `lib/source.ts` for `import { docs } from 'collections/server'`.

### Two MDX/Markdown rendering paths — don't confuse them

- **Doc pages** use `components/mdx.tsx` → `getMDXComponents()` wrapping `defaultMdxComponents` from `fumadocs-ui/mdx`. This is the static MDX pipeline.
- **AI chat responses** use `components/markdown.tsx` → a runtime `remark` → `remark-rehype` → `hast-util-to-jsx-runtime` pipeline with a custom `rehypeWrapWords` plugin (wraps each word in `<span class="animate-fd-fade-in">` for streaming token animation) and a custom `Pre` that swaps in `DynamicCodeBlock`. There's also a module-level `cache: Map<string, Promise<ReactNode>>` to dedupe re-renders during streaming.

If you need to render markdown anywhere new, pick the path intentionally — the chat one is heavier and tied to React Suspense.

## Conventions worth knowing

- **Branding lives in `lib/shared.ts`** — `appName`, `docsRoute`, `docsImageRoute`, `docsContentRoute`, and `gitConfig`. The defaults still point at `fuma-nama/fumadocs`; update before shipping.
- **Buttons**: `components/ui/button.tsx` exports `buttonVariants` (CVA). It defines both `variant` and `color` props (Fumadocs uses `color`) — they map to the same styles, so use whichever matches the surrounding code.
- Class merging uses `tailwind-merge` re-exported as `cn` from `lib/cn.ts`. No `clsx` in the project — don't add it.
- Tailwind is **v4** via `@tailwindcss/postcss` (no `tailwind.config.js`). Theme comes from Fumadocs presets imported in `app/global.css` (`fumadocs-ui/css/neutral.css` + `preset.css`); custom tokens use the `fd-` prefix (e.g. `bg-fd-primary`, `text-fd-muted-foreground`).
- Biome config (`biome.json`) ignores `.source` along with `node_modules`, `.next`, `dist`, `build`. Don't lint generated content.
