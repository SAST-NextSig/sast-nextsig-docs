/**
 * Sync the SAST Next Sig wiki space from Feishu/Lark into content/docs/.
 *
 * Run modes:
 *   pnpm sync:lark              incremental — pull only nodes whose
 *                               obj_edit_time is newer than the local copy.
 *                               Missing media is downloaded; existing media
 *                               is left untouched.
 *   pnpm sync:lark --force      re-pull every node and re-download every
 *                               image regardless of cached state.
 *   pnpm sync:lark --clean      delete every script-managed file (anything
 *                               with `feishuToken` in its frontmatter), wipe
 *                               public/lark-media, then full pull. Hand-
 *                               written files (no `feishuToken`) are kept.
 *                               Implies --force.
 *   pnpm sync:lark --dry-run    log what would happen, no writes.
 *
 * Everything is dynamic:
 *   - Slug = slugify(node.title). CJK is preserved verbatim — modern URL
 *     stacks handle non-ASCII fine. Override per-doc by adding a single
 *     line to the docx body in Lark:  `slug: my-custom-slug`
 *   - Folder structure = wiki parent-chain. A container's children live in
 *     `<container-slug>/` and its own docx body is written as
 *     `<container-slug>/index.mdx`.
 *   - Per-folder `meta.json` is auto-generated when missing (page order
 *     follows Lark's wiki order). Existing `meta.json` files are never
 *     overwritten — hand-edit them to lock in a custom order.
 *   - Hand-written vs script-managed is decided by frontmatter, not a
 *     hard-coded list: a file is owned by the script iff it has a
 *     `feishuToken:` field. Anything without one is left alone.
 *   - Embedded `<bitable token="..." />` blocks in a docx are replaced with
 *     a real markdown table fetched from the bitable's first table.
 *
 * Special-cased nodes:
 *   - BITABLE_ARCHIVE_TOKEN still drives lib/data/share-records.json via
 *     syncShareArchive(); the page itself (app/.../archive.mdx) consumes
 *     the JSON through the <ShareArchive /> component.
 *
 * Requires: lark-cli on PATH, authenticated as a user that can read the wiki.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const SPACE_ID = "7625304658956799168";
const ROOT = process.cwd();
const CONTENT_DIR = join(ROOT, "content", "docs");
const MEDIA_DIR = join(ROOT, "public", "lark-media");
const DATA_DIR = join(ROOT, "lib", "data");
const WIKI_URL_PREFIX = "https://njupt-sast.feishu.cn/wiki/";

// Wiki nodes whose `parent_node_token` is empty but which `wiki nodes list`
// does not return — listed as additional discovery seeds and pulled via
// `wiki spaces get_node`.
const EXTRA_SEEDS = ["KatOwPcwTiGfRxk5LBRc9RJtnDe"];

// Tokens to skip entirely. Children of an ignored token are also skipped
// silently. Keep this minimal — only for nodes that genuinely shouldn't
// produce a page (root-anchor docs, archived sections, etc.).
const IGNORED_TOKENS = new Set<string>([
  // "SAST Next Sig" — root anchor, duplicates the hand-written index.mdx.
  "KatOwPcwTiGfRxk5LBRc9RJtnDe",
]);

// node_token of the bitable backing the <ShareArchive /> component on the
// hand-written archive page. Synced separately into
// lib/data/share-records.json — does not produce an MDX file.
const BITABLE_ARCHIVE_TOKEN = "UYPIbjgltah32Msm56QcWSz8npg";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface Node {
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  parent_node_token: string;
  has_child: boolean;
  /** Unix seconds, as a numeric string. */
  obj_edit_time: string;
}

interface SyncOptions {
  force: boolean;
  clean: boolean;
  dryRun: boolean;
}

interface TransformResult {
  body: string;
  mediaTokens: string[];
}

interface ExistingFile {
  /** path relative to CONTENT_DIR, posix slashes */
  path: string;
  feishuToken: string;
  feishuEditTime: number | null;
  legacyIso: string | null;
}

// --------------------------------------------------------------------------
// lark-cli wrappers
// --------------------------------------------------------------------------

function lark(args: string[], timeoutMs = 90_000): string {
  const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  // stdio: ["pipe", "pipe", "pipe"] silences lark-cli's stderr chatter
  // (skill-registration probes, "[page N] fetching…" pagination notices,
  // etc.) — the sync script does its own progress logging. On non-zero
  // exit Node still surfaces the error and we re-throw with the captured
  // stderr appended for diagnostics.
  try {
    return execSync(`lark-cli ${quoted}`, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : (err.stderr?.toString("utf8") ?? "");
    throw new Error(
      stderr.trim() ? `${err.message}\n${stderr.trim()}` : err.message,
    );
  }
}

function larkJson(args: string[], timeoutMs = 90_000): unknown {
  const raw = lark(args, timeoutMs);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from lark-cli ${args.join(" ")}: ${(e as Error).message}\nRaw: ${raw.slice(0, 500)}`,
    );
  }
}

function larkContent(token: string, format: "markdown" | "xml"): string {
  const out = larkJson([
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--doc",
    token,
    "--doc-format",
    format,
    "--detail",
    format === "xml" ? "with-ids" : "simple",
    "--as",
    "user",
  ]) as { data?: { document?: { content?: string } } };
  return out?.data?.document?.content ?? "";
}

function listChildren(parentToken = ""): Node[] {
  const params = parentToken
    ? { space_id: SPACE_ID, parent_node_token: parentToken }
    : { space_id: SPACE_ID };
  const out = larkJson([
    "wiki",
    "nodes",
    "list",
    "--params",
    JSON.stringify(params),
    "--page-all",
  ]) as { data?: { items?: Node[] } };
  return out?.data?.items ?? [];
}

function getNode(token: string): Node | null {
  try {
    const out = larkJson([
      "wiki",
      "spaces",
      "get_node",
      "--params",
      JSON.stringify({ token }),
    ]) as { data?: { node?: Node } };
    return out?.data?.node ?? null;
  } catch {
    return null;
  }
}

interface TreeListing {
  /** All nodes flat */
  nodes: Node[];
  /** Direct children of a given parent_node_token (preserves wiki order) */
  childrenOf: Map<string, Node[]>;
}

function flattenTree(): TreeListing {
  const seen = new Set<string>();
  const result: Node[] = [];
  const childrenOf = new Map<string, Node[]>();
  const visit = (parent: string) => {
    const items = listChildren(parent);
    childrenOf.set(parent, items);
    for (const item of items) {
      if (seen.has(item.node_token)) continue;
      seen.add(item.node_token);
      result.push(item);
      if (item.has_child) visit(item.node_token);
    }
  };
  visit("");
  for (const seed of EXTRA_SEEDS) {
    if (seen.has(seed)) continue;
    const node = getNode(seed);
    if (node) {
      seen.add(node.node_token);
      result.push(node);
    }
  }
  return { nodes: result, childrenOf };
}

// --------------------------------------------------------------------------
// Slug derivation — fully dynamic (no per-doc config)
// --------------------------------------------------------------------------

/**
 * Build a URL-safe slug. Keeps Latin alphanumerics and CJK characters; turns
 * common separators (spaces, `/` `:` `：` `|` `_` etc.) into single dashes.
 * Lower-cases ASCII so URLs are stable regardless of how the title was cased
 * in Lark. CJK is preserved verbatim — modern URL stacks handle non-ASCII.
 */
function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s_:：|/\\—–·•、，,。.]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Allow per-doc slug override without touching the script: any line of the
 * form `slug: my-custom-slug` near the top of the docx body wins. Looked up
 * across the first ~2KB so it can sit alongside the user's pseudo-frontmatter
 * blockquote (`> title: …`, `> tags: …`) or as a free-standing line.
 */
function extractSlugFromBody(rawMd: string): string | null {
  const head = rawMd.slice(0, 2048);
  const m = head.match(
    /(?:^|\n)\s*(?:>\s*)?slug:\s*([A-Za-z0-9_\-./]+)\s*(?:\n|$)/,
  );
  return m ? m[1].trim().replace(/^\/+|\/+$/g, "") : null;
}

function autoSlug(
  node: Node,
  rawMd: string | undefined,
  bitableSlugByToken: Map<string, string>,
): string | null {
  // Priority 1 — explicit `slug:` line in the docx body (user override).
  if (rawMd) {
    const fromBody = extractSlugFromBody(rawMd);
    if (fromBody) return fromBody;
  }
  // Priority 2 — slug derived from the share-archive bitable's
  // `分享标题 / 内容` column (matched by Lark URL token in `分享文档`).
  const fromBitable =
    bitableSlugByToken.get(node.obj_token) ??
    bitableSlugByToken.get(node.node_token);
  if (fromBitable) return fromBitable;
  // Priority 3 — slugify the wiki node's own title (CJK preserved).
  const auto = slugify(node.title);
  return auto || null;
}

/**
 * Build a `token → slugified-share-title` map by reading the share-archive
 * bitable. Each record's `分享文档` cell is parsed for a Lark URL; the token
 * (whether `wiki/<node_token>` or `docx/<obj_token>`) is keyed against the
 * record's `分享标题 / 内容` column. Records without a Lark URL (external
 * blogs etc.) and records whose title produces an empty slug are skipped.
 *
 * Network failure is non-fatal — returns an empty map so the sync falls
 * through to title-based slugs.
 */
function loadBitableSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  let records: ShareRecord[];
  try {
    records = fetchBitableRecords(BITABLE_ARCHIVE_TOKEN);
  } catch (e) {
    console.error(
      `[sync] bitable slug-map 拉取失败: ${(e as Error).message.split("\n")[0]} (使用标题作为兜底)`,
    );
    return map;
  }
  const seenSlugs = new Set<string>();
  for (const r of records) {
    if (!r.link?.url) continue;
    const tokens = extractLarkTokens(r.link.url);
    if (tokens.length === 0) continue;
    const slug = slugify(r.title);
    if (!slug) continue;
    if (seenSlugs.has(slug)) {
      // Two records would slugify to the same path — fall back to title-
      // based slug for both rather than silently overwriting one.
      console.log(
        `[sync] ⚠ bitable 标题重复: '${r.title}' → 跳过 slug 映射,改用 wiki 标题`,
      );
      for (const t of tokens) map.delete(t);
      continue;
    }
    seenSlugs.add(slug);
    for (const t of tokens) map.set(t, slug);
  }
  return map;
}

/**
 * Pull every Lark token (node_token or obj_token) out of a URL string.
 * Handles both `feishu.cn/wiki/<token>` and `feishu.cn/docx/<token>` forms,
 * with or without query parameters.
 */
function extractLarkTokens(url: string): string[] {
  const out: string[] = [];
  for (const m of url.matchAll(
    /\bfeishu\.cn\/(?:wiki|docx)\/([A-Za-z0-9]+)/g,
  )) {
    out.push(m[1]);
  }
  return out;
}

function hasIgnoredAncestor(node: Node, byToken: Map<string, Node>): boolean {
  let cur = byToken.get(node.parent_node_token);
  while (cur) {
    if (IGNORED_TOKENS.has(cur.node_token)) return true;
    cur = byToken.get(cur.parent_node_token);
  }
  return false;
}

/**
 * Build the ancestor folder chain for a node. For each ancestor we use its
 * docx body (if available) so a `slug:` override there changes the folder
 * name. Falls back to slugify(title). Returns null if any ancestor is
 * unmappable or ignored.
 */
function ancestorFolders(
  node: Node,
  byToken: Map<string, Node>,
  ancestorSlug: (n: Node) => string | null,
): string[] | null {
  const segments: string[] = [];
  let cur = byToken.get(node.parent_node_token);
  while (cur) {
    if (IGNORED_TOKENS.has(cur.node_token)) return null;
    const s = ancestorSlug(cur);
    if (!s) return null;
    segments.unshift(s);
    cur = byToken.get(cur.parent_node_token);
  }
  return segments;
}

// --------------------------------------------------------------------------
// docx markdown transform
// --------------------------------------------------------------------------

/**
 * Render an embedded `<bitable token="…" />` block as an inline markdown
 * table by listing the bitable's first table. Errors degrade to a hint
 * blockquote so a single broken embed doesn't block the whole sync.
 */
function renderBitableEmbed(token: string): string {
  try {
    const tablesResp = larkJson([
      "base",
      "+table-list",
      "--base-token",
      token,
    ]) as { data?: { tables?: { id: string; name?: string }[] } };
    const tableId = tablesResp?.data?.tables?.[0]?.id;
    if (!tableId) {
      return `\n> 飞书多维表格 (token=${token}) 没有可读的表\n`;
    }
    const raw = lark([
      "base",
      "+record-list",
      "--base-token",
      token,
      "--table-id",
      tableId,
      "--limit",
      "200",
      "--format",
      "markdown",
    ]);
    const cleaned = sanitizeBitableMarkdown(raw);
    if (!cleaned) {
      return `\n> 飞书多维表格 (token=${token}) 表内无数据\n`;
    }
    return `\n${cleaned}\n`;
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return `\n> 飞书多维表格 (token=${token}) 拉取失败: ${msg}\n`;
  }
}

function sanitizeBitableMarkdown(rawTable: string): string {
  const lines = rawTable.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("`_record_id`")) continue;
    if (line.startsWith("Meta:")) continue;
    if (!line.startsWith("|")) {
      // skip non-table prose; keep things tight
      continue;
    }
    // Drop the record-id column on a pipe-aware split so embedded `\|`
    // inside cell content (e.g. markdown link text) doesn't get truncated.
    const cells = splitMarkdownTableRow(line);
    const trimmed = [cells[0], ...cells.slice(2)]; // drop column 1 (record id)
    let rebuilt = trimmed.join("|");
    // Strip Lark person mentions of the form "Alias [@真实姓名](avatar-url)"
    // — keep only the alias to avoid leaking real names + avatar URLs.
    rebuilt = rebuilt.replace(/\s*\[@[^\]]+\]\(https?:\/\/[^)]+\)/g, "");
    out.push(rebuilt);
  }
  return out.join("\n").trim();
}

/**
 * Split a markdown-table row on UNESCAPED `|` only — pipes inside cell
 * content escape themselves as `\|`, and a naive split shreds them. The
 * leading and trailing empty strings (from `|...|` borders) are kept so
 * callers can preserve column count via slicing.
 */
function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      buf += "|"; // unescape
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  return cells;
}

function transformDocxMarkdown(
  rawMd: string,
  rawXml: string,
  nodeTitle: string,
): TransformResult {
  let md = rawMd;

  // 1a. Drop top-level <title>…</title> tags (some authors write them inline).
  md = md.replace(/<title>[\s\S]*?<\/title>/gi, "");

  // 1b. Drop the document H1 — Fumadocs renders the title from frontmatter.
  const escapedTitle = nodeTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  md = md.replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "m"), "");
  md = md.replace(/^#\s+[^\n]+\n+/, "");

  // 1c. If the user added `slug: foo` near the top, strip it from the body
  //     (we already consumed it for the URL; no need to render it).
  md = md.replace(
    /(?:^|\n)\s*(?:>\s*)?slug:\s*[A-Za-z0-9_\-./]+\s*(?=\n|$)/,
    "",
  );

  // 2. Map image tokens by parsing xml. Order is preserved.
  const xmlImgTokens: string[] = [];
  for (const m of rawXml.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
    xmlImgTokens.push(m[1]);
  }
  let imgIdx = 0;
  md = md.replace(
    /!\[([^\]]*)\]\(https:\/\/[^/]*\.feishu(?:cdn)?\.[^/]+\/[^)]+\)/g,
    (_match, alt: string) => {
      const tok = xmlImgTokens[imgIdx++];
      if (!tok) return `<!-- 图片缺失 file_token -->`;
      return `![${alt || ""}](/lark-media/${tok}.png)`;
    },
  );

  // 3. Code fences default to ```Plaintext — re-tag with a heuristic.
  md = md.replace(/```Plaintext\s*\n([\s\S]*?)```/g, (_match, body: string) => {
    const head = body.split("\n").slice(0, 3).join("\n");
    let lang = "text";
    if (
      /\b(flowchart|graph(?:\s+(?:LR|RL|TB|TD|BT))?|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|gantt|pie|erDiagram|mindmap|gitGraph|journey|timeline)\b/.test(
        head,
      )
    )
      lang = "mermaid";
    else if (
      /^\s*(import |from\s+\S+\s+import|def\s+|class\s+\w+\s*[(:])/m.test(body)
    )
      lang = "python";
    else if (
      /^\s*(function\s+|const\s+|let\s+\w|=>|interface\s+|type\s+\w)/m.test(
        body,
      )
    )
      lang = "typescript";
    else if (
      /^\s*(SELECT|FROM|WHERE|INSERT|UPDATE|CREATE\s+TABLE)\b/im.test(head)
    )
      lang = "sql";
    else if (
      /^\s*\$\s+\w/m.test(head) ||
      /^#!\/(?:usr\/)?bin\/(?:bash|sh)/m.test(head)
    )
      lang = "bash";
    else if (/^\{[\s\S]*\}\s*$/.test(body.trim())) lang = "json";
    return `\`\`\`${lang}\n${body}\`\`\``;
  });

  // 4. Strip <cite type="user" ...></cite> mentions — they leak open_id.
  md = md.replace(/<cite\b[^>]*\/?>/g, "");
  md = md.replace(/<\/cite>/g, "");

  // 5. <folder_manager> appears on container/index docs — drop it.
  md = md.replace(/<folder_manager\s*>\s*<\/folder_manager>/g, "");
  md = md.replace(/<folder_manager\s*\/>/g, "");

  // 6. Embedded bitable — render the first table as an inline markdown
  //     table. Other embeds (sheet/whiteboard/mindnote/slides/file) stay as
  //     a hint blockquote pointing at the original.
  md = md.replace(/<bitable\b([^>]*?)\/>/g, (_match, attrs: string) => {
    const token = extractAttr(attrs, "token");
    if (!token) return "\n> 飞书多维表格嵌入块缺少 token\n";
    return renderBitableEmbed(token);
  });
  md = md.replace(
    /<bitable\b([^>]*?)>[\s\S]*?<\/bitable>/g,
    (_match, attrs: string) => {
      const token = extractAttr(attrs, "token");
      if (!token) return "\n> 飞书多维表格嵌入块缺少 token\n";
      return renderBitableEmbed(token);
    },
  );
  md = md.replace(
    /<(sheet|whiteboard|mindnote|slides|file)\b[^>]*\/>/g,
    (_match, kind: string) =>
      `\n> 飞书 ${kind} 嵌入块未在静态站点渲染，请[查看飞书原文](#)。\n`,
  );
  md = md.replace(
    /<(sheet|whiteboard|mindnote|slides|file)\b[^>]*>[\s\S]*?<\/\1>/g,
    (_match, kind: string) =>
      `\n> 飞书 ${kind} 嵌入块未在静态站点渲染，请[查看飞书原文](#)。\n`,
  );

  // 7. ::: note / ::: warning / ::: tip → <Callout>.
  md = md.replace(
    /^:::\s*(\w+)\s*\n([\s\S]*?)\n^:::\s*$/gm,
    (_match, kind: string, inner: string) => {
      const k = kind.toLowerCase();
      const type =
        k === "warn" || k === "warning" || k === "danger"
          ? "warn"
          : k === "note"
            ? "note"
            : "info";
      return `<Callout type="${type}">\n\n${inner.trim()}\n\n</Callout>`;
    },
  );

  // 8. Author-written `warning:foo` single line into a Callout.
  md = md.replace(
    /^warning:\s*(.+)$/gm,
    (_match, text: string) => `<Callout type="warn">${text.trim()}</Callout>`,
  );

  // 9. Inline pseudo frontmatter the author wrote in body
  //    (--- title: ... published: ... tags: ... ---). Convert to a blockquote
  //    so MDX won't try to parse it as real frontmatter.
  md = md.replace(
    /(^|\n)---\s*\n([\s\S]*?)\n---\s*(\n|$)/g,
    (full, lead: string, inner: string, trail: string) => {
      if (
        /^\s*(title|published|tags|date|category|categories|author|description|slug)\s*:/m.test(
          inner,
        )
      ) {
        const lines = inner
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !/^slug\s*:/i.test(l)) // already extracted
          .map((l) => `> ${l}`);
        return `${lead}\n${lines.join("\n")}\n${trail}`;
      }
      return full;
    },
  );

  // 10. Drop any orphan `---` that the pseudo-frontmatter rule didn't pair up.
  md = md.replace(/^---\s*$/gm, "");

  // 11. Lower-case fenced code-block languages (Shiki tokens are
  //     case-sensitive: `Bash`/`TypeScript`/`Dockerfile` won't load).
  md = md.replace(
    /^([>\s]*)```([A-Za-z][\w+-]*)([^\n]*)$/gm,
    (_full, prefix: string, lang: string, rest: string) =>
      `${prefix}\`\`\`${lang.toLowerCase()}${rest}`,
  );

  // 11b. Flatten markdown links inside headings — Fumadocs' Heading already
  //      wraps the heading in an <a>, so nested <a> causes hydration errors.
  md = md.replace(
    /^(#{1,6}\s+)(.+)$/gm,
    (_m, hash: string, body: string) =>
      `${hash}${body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}`,
  );

  // 12. Collapse 3+ blank lines.
  md = md.replace(/\n{3,}/g, "\n\n");

  return { body: `${md.trim()}\n`, mediaTokens: xmlImgTokens };
}

function extractAttr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

// --------------------------------------------------------------------------
// bitable share-archive (drives <ShareArchive />)
// --------------------------------------------------------------------------

interface ShareRecord {
  speaker: string;
  date: string;
  title: string;
  link?: { text: string; url: string };
}

function fetchBitableRecords(baseToken: string): ShareRecord[] {
  const tables = larkJson([
    "base",
    "+table-list",
    "--base-token",
    baseToken,
  ]) as { data?: { tables?: { id: string }[] } };
  const tableId = tables?.data?.tables?.[0]?.id;
  if (!tableId) throw new Error("no table found");
  const rawTable = lark([
    "base",
    "+record-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--limit",
    "200",
    "--format",
    "markdown",
  ]);
  return parseShareRecordsMd(rawTable);
}

function parseShareRecordsMd(rawTable: string): ShareRecord[] {
  const records: ShareRecord[] = [];
  const lines = rawTable.split("\n");
  let header: string[] | null = null;
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (line.startsWith("`_record_id`") || line.startsWith("Meta:")) continue;
    // Drop leading record-id column. Be careful: cell content may contain
    // escaped pipes (`\|`) inside markdown link text — split on UNESCAPED
    // pipes only, then unescape each cell.
    const cells = splitMarkdownTableRow(line)
      .slice(1, -1) // drop the empty edges from leading/trailing `|`
      .slice(1) // drop the record-id column
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    const get = (name: string) => {
      if (!header) return "";
      const idx = header.indexOf(name);
      return idx >= 0 ? (cells[idx] ?? "") : "";
    };
    const rawSpeaker = get("分享者");
    const speaker = rawSpeaker
      .replace(/\s*\[@[^\]]+\]\(https?:\/\/[^)]+\)/g, "")
      .trim();
    const date = get("分享时间")
      .replace(/\s+00:00:00$/, "")
      .trim();
    const title = get("分享标题 / 内容").trim();
    const linkCell = get("分享文档");
    const linkMatch = linkCell.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    let link: ShareRecord["link"] | undefined;
    if (linkMatch) {
      const [, text, url] = linkMatch;
      const cleanText = text === url ? prettifyUrl(url) : text;
      link = { text: cleanText, url };
    }
    if (!speaker && !title) continue;
    records.push({ speaker, date, title, link });
  }
  return records;
}

function prettifyUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 1 ? u.pathname : "");
  } catch {
    return url;
  }
}

// --------------------------------------------------------------------------
// frontmatter & description helpers
// --------------------------------------------------------------------------

function escapeYaml(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return String(value);
  const s = String(value);
  if (s === "") return undefined;
  if (/^[A-Za-z0-9_\- ]+$/.test(s) && !/^[\s-]/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function frontmatter(
  data: Record<string, string | number | undefined>,
): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(data)) {
    const escaped = escapeYaml(v);
    if (escaped === undefined) continue;
    lines.push(`${k}: ${escaped}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * Escape a string so it's safe as a double-quoted MDX/JSX attribute value.
 * Covers `"`, `<`, `>`, `&`, `{`, `}` — the chars MDX parses specially in
 * attribute context. Newlines collapse to single spaces (cards are one-liners).
 */
function escapeMdxAttr(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * Build the `<Cards>` block that container index pages append to summarize
 * their direct children. Each child becomes one `<Card>` linking to its page,
 * with title and description sourced from frontmatter (description comes via
 * descByToken — populated from freshly rendered bodies for synced entries
 * and from existing frontmatter for up-to-date ones).
 *
 * Returns "" when the container has no card-eligible children — caller falls
 * back to the placeholder hint blockquote.
 */
function buildContainerCardsBlock(
  childrenWiki: Node[],
  tokenToSlug: Map<string, string>,
  descByToken: Map<string, string>,
  containerTargetRel: string,
): string {
  // containerTargetRel like "第一次分享会/index.mdx" → parents = ["第一次分享会"]
  const parentSegs = containerTargetRel.split("/").slice(0, -1);
  const cards: string[] = [];
  for (const child of childrenWiki) {
    if (IGNORED_TOKENS.has(child.node_token)) continue;
    if (child.obj_type !== "docx") continue;
    const slug = tokenToSlug.get(child.node_token);
    if (!slug) continue;
    const title = escapeMdxAttr(child.title.trim());
    if (!title) continue;
    const href = `/docs/${[...parentSegs, slug].join("/")}`;
    const desc = descByToken.get(child.node_token);
    const descAttr = desc ? ` description="${escapeMdxAttr(desc)}"` : "";
    cards.push(`  <Card title="${title}" href="${href}"${descAttr} />`);
  }
  if (cards.length === 0) return "";
  return ["## 本节内容", "", "<Cards>", ...cards, "</Cards>"].join("\n");
}

function deriveDescription(body: string): string {
  const lines = body.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (
      line.startsWith("#") ||
      line.startsWith(">") ||
      line.startsWith("|") ||
      line.startsWith("---") ||
      line.startsWith("<") ||
      /^[*\-+]\s/.test(line) ||
      /^\d+\.\s/.test(line)
    ) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  const candidate =
    paragraphs.find((p) => p.length >= 20) ?? paragraphs[0] ?? "";
  return candidate
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Read a file's frontmatter as raw YAML text. Returns null if the file does
 * not exist or has no frontmatter block.
 */
function readFrontmatterRaw(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  return text.slice(3, end);
}

function parseFeishuFrontmatter(
  fm: string,
): { token: string; editTime: number | null; legacyIso: string | null } | null {
  const tokenMatch = fm.match(/^\s*feishuToken:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  if (!tokenMatch) return null;
  const editMatch = fm.match(/^\s*feishuEditTime:\s*['"]?(\d+)['"]?\s*$/m);
  const isoMatch = fm.match(/^\s*lastSyncedAt:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  return {
    token: tokenMatch[1],
    editTime: editMatch ? Number(editMatch[1]) : null,
    legacyIso: isoMatch ? isoMatch[1] : null,
  };
}

/**
 * Pull a single string-valued field out of a raw frontmatter block. Handles
 * single-quoted, double-quoted, or bare scalar values. Returns null if the
 * field is absent. Single-quoted YAML doubles `''` → `'`; we undo that.
 */
function extractFrontmatterField(fm: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const single = fm.match(
    new RegExp(`^\\s*${escapedName}:\\s*'((?:[^']|'')*)'\\s*$`, "m"),
  );
  if (single) return single[1].replace(/''/g, "'");
  const double = fm.match(
    new RegExp(`^\\s*${escapedName}:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m"),
  );
  if (double) return double[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const bare = fm.match(
    new RegExp(`^\\s*${escapedName}:\\s*([^\\n'"][^\\n]*?)\\s*$`, "m"),
  );
  if (bare) return bare[1];
  return null;
}

/**
 * Walk CONTENT_DIR, returning every `.mdx` file whose frontmatter has a
 * `feishuToken`. These are the files the script owns; anything else is
 * treated as hand-written and left alone.
 */
function scanExistingSyncedFiles(): ExistingFile[] {
  const out: ExistingFile[] = [];
  if (!existsSync(CONTENT_DIR)) return out;
  const stack: string[] = [CONTENT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".mdx")) continue;
      const fm = readFrontmatterRaw(full);
      if (!fm) continue;
      const parsed = parseFeishuFrontmatter(fm);
      if (!parsed) continue;
      // The archive bitable token shows up on a hand-written page that
      // consumes lib/data/share-records.json via <ShareArchive />. The
      // sync owns the JSON, not the page, so don't track it as a managed
      // file (otherwise it'd get flagged as orphan or wiped by --clean).
      if (parsed.token === BITABLE_ARCHIVE_TOKEN) continue;
      out.push({
        path: relative(CONTENT_DIR, full).replace(/\\/g, "/"),
        feishuToken: parsed.token,
        feishuEditTime: parsed.editTime,
        legacyIso: parsed.legacyIso,
      });
    }
  }
  return out;
}

function shouldSyncDocx(
  node: Node,
  existing: ExistingFile | undefined,
  opts: SyncOptions,
): { sync: boolean; reason: string } {
  if (opts.force) return { sync: true, reason: "force" };
  if (!existing) return { sync: true, reason: "missing" };
  const remoteEdit = Number(node.obj_edit_time);
  if (!Number.isFinite(remoteEdit) || remoteEdit <= 0) {
    return { sync: true, reason: "no-remote-edit-time" };
  }
  if (existing.feishuEditTime != null) {
    if (remoteEdit > existing.feishuEditTime) {
      return { sync: true, reason: "newer" };
    }
    return { sync: false, reason: "up-to-date" };
  }
  if (existing.legacyIso) {
    const existingSec = Math.floor(
      new Date(existing.legacyIso).getTime() / 1000,
    );
    if (Number.isFinite(existingSec) && remoteEdit > existingSec) {
      return { sync: true, reason: "newer-legacy" };
    }
    return { sync: false, reason: "up-to-date-legacy" };
  }
  return { sync: true, reason: "no-stored-edit-time" };
}

// --------------------------------------------------------------------------
// media download (incremental by default)
// --------------------------------------------------------------------------

function downloadMedia(token: string, opts: SyncOptions): boolean {
  const target = join(MEDIA_DIR, `${token}.png`);
  if (existsSync(target) && !opts.force) return true;
  if (opts.dryRun) {
    console.log(`[sync] (dry) media ${token}`);
    return true;
  }
  try {
    const quoted = [
      "docs",
      "+media-download",
      "--token",
      token,
      "--output",
      `./${token}.png`,
      "--overwrite",
    ]
      .map((a) => `"${a.replace(/"/g, '\\"')}"`)
      .join(" ");
    execSync(`lark-cli ${quoted}`, {
      encoding: "utf8",
      cwd: MEDIA_DIR,
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(
      `[sync] media-download ${token} 失败: ${(e as Error).message.split("\n")[0]}`,
    );
    return false;
  }
  return existsSync(target);
}

// --------------------------------------------------------------------------
// folder meta.json auto-generation
// --------------------------------------------------------------------------

function maybeWriteFolderMeta(
  folderRel: string,
  container: Node,
  childrenSlugs: string[],
  containerHasIndex: boolean,
  opts: SyncOptions,
) {
  const metaPath = join(CONTENT_DIR, folderRel, "meta.json");
  if (existsSync(metaPath)) return; // never overwrite hand-written meta
  if (opts.dryRun) {
    console.log(`[sync] (dry) meta ${folderRel}/meta.json`);
    return;
  }
  const pages = [...(containerHasIndex ? ["index"] : []), ...childrenSlugs];
  const meta = {
    title: container.title.trim(),
    defaultOpen: true,
    pages,
  };
  mkdirSync(dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  console.log(`[sync] ${folderRel}/meta.json (auto)`);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function parseArgs(argv: string[]): SyncOptions {
  const flags = new Set(argv);
  return {
    force: flags.has("--force") || flags.has("-f") || flags.has("--clean"),
    clean: flags.has("--clean"),
    dryRun: flags.has("--dry-run"),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.dryRun
    ? "dry-run"
    : opts.clean
      ? "clean"
      : opts.force
        ? "force"
        : "incremental";
  console.log(`[sync] 模式: ${mode}`);

  console.log("[sync] 拉取 wiki 节点树…");
  const { nodes, childrenOf } = flattenTree();
  console.log(`[sync] 共 ${nodes.length} 个节点`);

  console.log("[sync] 拉取分享归档 bitable (slug 来源)…");
  const bitableSlugByToken = loadBitableSlugMap();
  console.log(
    `[sync] bitable 命中 ${bitableSlugByToken.size} 个 token → slug 映射`,
  );

  const byToken = new Map<string, Node>();
  for (const n of nodes) byToken.set(n.node_token, n);

  // Pre-scan disk so we can match new wiki paths against existing files,
  // detect renames, and surface orphans without a hand-coded HANDWRITTEN list.
  const existingFiles = scanExistingSyncedFiles();
  const existingByToken = new Map<string, ExistingFile>();
  for (const f of existingFiles) existingByToken.set(f.feishuToken, f);

  if (opts.clean && !opts.dryRun) {
    // Wipe everything the script owns:
    //   1. .mdx files with `feishuToken` (the synced docs)
    //   2. meta.json inside script-managed sub-folders (auto-gen by
    //      maybeWriteFolderMeta — top-level meta.json is hand-written and
    //      stays)
    //   3. now-empty folders bubbled up to (but not including) CONTENT_DIR
    //   4. all downloaded images
    const managedFolders = new Set<string>();
    for (const f of existingFiles) {
      managedFolders.add(dirname(f.path));
      rmSync(join(CONTENT_DIR, f.path), { force: true });
    }
    for (const folder of managedFolders) {
      if (!folder || folder === ".") continue;
      const metaPath = join(CONTENT_DIR, folder, "meta.json");
      if (existsSync(metaPath)) rmSync(metaPath, { force: true });
    }
    pruneEmptyFolders(managedFolders);
    rmSync(MEDIA_DIR, { recursive: true, force: true });
    existingByToken.clear();
  }
  if (!opts.dryRun) {
    mkdirSync(CONTENT_DIR, { recursive: true });
    mkdirSync(MEDIA_DIR, { recursive: true });
  }

  const stamp = new Date().toISOString();

  // First pass: fetch raw markdown for each docx so we can resolve `slug:`
  // overrides (which may reference an ancestor's slug). Nodes that we don't
  // need to sync (up-to-date) reuse the existing path entirely.
  interface Pending {
    node: Node;
    rawMd: string;
    rawXml: string;
    targetRel: string;
    decision: { sync: boolean; reason: string };
  }
  const pending: Pending[] = [];
  const tokenToSlug = new Map<string, string>(); // node_token → slug segment

  // Resolve slugs in two phases: first leaves with cached body, then
  // ancestors using the cache. Containers may not need their own body
  // fetched if we only care about their slug — but we need the body anyway
  // (to write index.mdx) when the container itself owns content.
  let skippedNoSlug = 0;
  let skippedNonDocx = 0;
  let skippedIgnored = 0;

  // Phase 1: figure out which nodes are in scope and pre-fetch markdown
  // (only when sync is needed).
  for (const node of nodes) {
    if (node.obj_type !== "docx") {
      skippedNonDocx++;
      continue;
    }
    if (IGNORED_TOKENS.has(node.node_token)) {
      skippedIgnored++;
      continue;
    }
    if (hasIgnoredAncestor(node, byToken)) {
      skippedIgnored++;
      continue;
    }

    const existing = existingByToken.get(node.obj_token);
    const decision = shouldSyncDocx(node, existing, opts);
    // Containers always re-render so their auto-generated <Cards> block
    // tracks the current child list — adding or removing a sibling page
    // doesn't change the container's own obj_edit_time, so without this
    // override the cards would silently go stale.
    if (node.has_child && !decision.sync) {
      decision.sync = true;
      decision.reason = "container-cards-refresh";
    }

    let rawMd = "";
    let rawXml = "";
    if (decision.sync) {
      try {
        rawMd = larkContent(node.obj_token, "markdown");
        rawXml = larkContent(node.obj_token, "xml");
      } catch (e) {
        console.error(
          `[sync] fetch ${node.obj_token} 失败: ${(e as Error).message.split("\n")[0]}`,
        );
        continue;
      }
    }

    const slug = autoSlug(node, rawMd || undefined, bitableSlugByToken);
    if (!slug) {
      skippedNoSlug++;
      console.log(
        `[sync] ⚠ 无法生成 slug (标题为空或全是符号): ${node.node_token} (${node.title.trim()})`,
      );
      continue;
    }
    tokenToSlug.set(node.node_token, slug);
    pending.push({ node, rawMd, rawXml, targetRel: "", decision });
  }

  // Phase 2: build target paths now that every in-scope node has a slug.
  const ancestorSlug = (n: Node): string | null => {
    const cached = tokenToSlug.get(n.node_token);
    if (cached) return cached;
    // Ancestor not in pending (e.g., its docx hasn't been fetched yet
    // because we didn't need to sync it). Try its existing file path
    // as the canonical slug, else slugify the title.
    const existing = existingByToken.get(n.obj_token);
    if (existing) {
      const segs = existing.path.replace(/\.mdx$/, "").split("/");
      const folder = segs.slice(0, -1).join("/");
      const last = segs[segs.length - 1];
      if (n.has_child) {
        // container — its slug is its folder name (the parent of index)
        if (last === "index") return segs[segs.length - 2] ?? null;
        return folder.split("/").pop() ?? null;
      }
      return last;
    }
    const auto = slugify(n.title);
    return auto || null;
  };

  for (const p of pending) {
    const parents = ancestorFolders(p.node, byToken, ancestorSlug);
    if (parents == null) {
      skippedNoSlug++;
      continue;
    }
    const slug = tokenToSlug.get(p.node.node_token);
    if (!slug) {
      skippedNoSlug++;
      continue;
    }
    p.targetRel = p.node.has_child
      ? [...parents, slug, "index.mdx"].join("/")
      : [...parents, `${slug}.mdx`].join("/");
  }

  // Phase 3a: render bodies for every entry that needs syncing, and collect
  // descriptions for ALL pending entries (synced + up-to-date). The latter
  // feeds the auto-generated <Cards> block on container index pages — each
  // child's description is sourced from this map rather than re-fetched.
  interface RenderedBody {
    body: string;
    media: string[];
  }
  const renderedByToken = new Map<string, RenderedBody>();
  const descByToken = new Map<string, string>();

  for (const p of pending) {
    if (!p.targetRel) continue;
    if (p.decision.sync) {
      const result = transformDocxMarkdown(p.rawMd, p.rawXml, p.node.title);
      renderedByToken.set(p.node.node_token, {
        body: result.body,
        media: result.mediaTokens,
      });
      const desc = deriveDescription(result.body);
      if (desc) descByToken.set(p.node.node_token, desc);
    } else {
      const existing = existingByToken.get(p.node.obj_token);
      if (existing) {
        const fm = readFrontmatterRaw(join(CONTENT_DIR, existing.path));
        const desc = fm ? extractFrontmatterField(fm, "description") : null;
        if (desc) descByToken.set(p.node.node_token, desc);
      }
    }
  }

  // Placeholder fallback that older sync runs wrote into container indexes
  // — strip it before appending fresh cards so we don't render both.
  const CONTAINER_PLACEHOLDER_RE =
    /^本节包含若干篇分享内容[，,]\s*请从左侧目录进入[。.]?\s*$/m;

  // Phase 3b: write files and track what we touched
  const writtenPaths = new Set<string>();
  let synced = 0;
  let skippedUpToDate = 0;
  let renamedFromOld = 0;

  for (const p of pending) {
    if (!p.targetRel) continue;
    writtenPaths.add(p.targetRel);

    const filePath = join(CONTENT_DIR, p.targetRel);
    const existing = existingByToken.get(p.node.obj_token);

    // Detect rename: the doc lives somewhere else on disk under a different
    // path. If we're refreshing content anyway, just delete the old file
    // (the new one is written below). If the doc is up-to-date, move the
    // file with renameSync so we don't lose content for nodes that didn't
    // need a re-fetch.
    const isRename = existing !== undefined && existing.path !== p.targetRel;
    if (isRename) {
      console.log(`[sync] rename: ${existing.path} → ${p.targetRel}`);
      renamedFromOld++;
    }

    if (!p.decision.sync) {
      // Up-to-date: move old file to new path if needed; otherwise skip.
      if (isRename && !opts.dryRun) {
        const oldFull = join(CONTENT_DIR, existing.path);
        const newFull = join(CONTENT_DIR, p.targetRel);
        mkdirSync(dirname(newFull), { recursive: true });
        // Windows renameSync errors if the target exists; clear it first.
        if (existsSync(newFull)) rmSync(newFull, { force: true });
        renameSync(oldFull, newFull);
      }
      skippedUpToDate++;
      continue;
    }

    // Refreshing content: delete the old file (if rename) before writing.
    if (isRename && !opts.dryRun) {
      rmSync(join(CONTENT_DIR, existing.path), { force: true });
    }

    console.log(
      `[sync] ${p.targetRel.padEnd(48)} ← ${p.node.obj_token} (${p.decision.reason})`,
    );

    const rendered = renderedByToken.get(p.node.node_token);
    let humanBody = (rendered?.body ?? "").trim();
    const media = rendered?.media ?? [];

    // Drop the auto-placeholder so it doesn't sit alongside the fresh cards.
    humanBody = humanBody.replace(CONTAINER_PLACEHOLDER_RE, "").trim();

    let cardsBlock = "";
    if (p.node.has_child) {
      const childrenWiki = childrenOf.get(p.node.node_token) ?? [];
      cardsBlock = buildContainerCardsBlock(
        childrenWiki,
        tokenToSlug,
        descByToken,
        p.targetRel,
      );
    }

    if (!humanBody && !cardsBlock) {
      if (p.node.has_child) {
        humanBody = "本节包含若干篇分享内容，请从左侧目录进入。";
      } else {
        const url = `${WIKI_URL_PREFIX}${p.node.node_token}`;
        humanBody = `> 此页面暂未填充内容。原始飞书文档：[${p.node.title.trim()}](${url})`;
      }
    }

    let body: string;
    if (cardsBlock) {
      const importLine =
        "import { Card, Cards } from 'fumadocs-ui/components/card';";
      body = humanBody
        ? `${importLine}\n\n${humanBody}\n\n${cardsBlock}\n`
        : `${importLine}\n\n${cardsBlock}\n`;
    } else {
      body = `${humanBody}\n`;
    }

    if (!opts.dryRun) {
      for (const tok of media) downloadMedia(tok, opts);
    }

    // Description: derive from the human-written body when present so the
    // SEO/OG snippet reflects what the author wrote, not the auto-cards.
    // For pure-cards container indexes, fall back to the placeholder hint.
    const descSource =
      humanBody || "本节包含若干篇分享内容，请从左侧目录进入。";
    const fm = frontmatter({
      title: p.node.title.trim(),
      description: deriveDescription(descSource),
      feishuToken: p.node.obj_token,
      feishuEditTime: p.node.obj_edit_time,
      lastSyncedAt: stamp,
    });
    const finalContent = `${fm}\n${body}`;
    if (!opts.dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, finalContent, "utf8");
    }
    synced++;
  }

  // Auto-generate per-folder meta.json for any container whose folder
  // doesn't already have one.
  let metasWritten = 0;
  for (const p of pending) {
    if (!p.node.has_child) continue;
    if (!p.targetRel) continue;
    const folderRel = dirname(p.targetRel); // e.g. "first-meeting"
    const childrenWiki = childrenOf.get(p.node.node_token) ?? [];
    const childrenSlugs: string[] = [];
    for (const child of childrenWiki) {
      if (IGNORED_TOKENS.has(child.node_token)) continue;
      if (child.obj_type !== "docx") continue;
      const childSlug = tokenToSlug.get(child.node_token);
      if (childSlug) childrenSlugs.push(childSlug);
    }
    const before = existsSync(join(CONTENT_DIR, folderRel, "meta.json"));
    maybeWriteFolderMeta(
      folderRel,
      p.node,
      childrenSlugs,
      /* containerHasIndex */ true,
      opts,
    );
    if (!before && !opts.dryRun) metasWritten++;
  }

  // Rewrite meta.json `pages` references for any slug we just renamed.
  // Top-level meta.json with hand-curated separators ("---分享会---") is
  // preserved — only string entries matching a known rename are touched.
  const slugRenames = collectSlugRenames(existingFiles, pending);
  if (slugRenames.size > 0) {
    const updated = rewriteMetaJsonReferences(slugRenames, opts);
    if (updated.length > 0) {
      console.log(`[sync] meta.json 自动更新 ${updated.length} 处 slug 引用:`);
      for (const u of updated) console.log(`        ${u}`);
    }
  }

  if (!opts.dryRun) {
    syncShareArchive(stamp);
  }

  // Orphan = was-synced file whose token is no longer in the wiki tree.
  // (A renamed file isn't orphan — the same token is still synced, just at
  // a new path — so we filter by token membership, not path membership.)
  const syncedTokens = new Set(pending.map((p) => p.node.obj_token));
  const orphans = existingFiles
    .filter((f) => !syncedTokens.has(f.feishuToken))
    .map((f) => f.path);
  if (orphans.length > 0) {
    console.log(
      `[sync] ⚠ ${orphans.length} 个孤立同步文件 (token 已不在 wiki 中,可手动删除或 --clean 重置):`,
    );
    for (const o of orphans) console.log(`        ${o}`);
  }

  console.log(
    `[sync] 完成 — 同步 ${synced},未变化 ${skippedUpToDate},重命名 ${renamedFromOld},meta.json 新建 ${metasWritten},忽略 ${skippedIgnored},未映射 ${skippedNoSlug},非 docx ${skippedNonDocx}`,
  );
}

interface PendingForRename {
  node: Node;
  targetRel: string;
}

/**
 * Walk every script-managed file and figure out which segment(s) of its
 * path changed this run. The result maps `old-slug → new-slug` for any
 * segment that genuinely renamed (folder names, file basenames). Used by
 * rewriteMetaJsonReferences to keep meta.json in sync after renames.
 */
function collectSlugRenames(
  existingFiles: ExistingFile[],
  pending: PendingForRename[],
): Map<string, string> {
  const renames = new Map<string, string>();
  for (const f of existingFiles) {
    const p = pending.find((x) => x.node.obj_token === f.feishuToken);
    if (!p?.targetRel || p.targetRel === f.path) continue;
    const oldSegs = f.path.split("/");
    const newSegs = p.targetRel.split("/");
    if (oldSegs.length !== newSegs.length) continue;
    for (let i = 0; i < oldSegs.length; i++) {
      if (oldSegs[i] === newSegs[i]) continue;
      const oldPiece = oldSegs[i].replace(/\.mdx$/, "");
      const newPiece = newSegs[i].replace(/\.mdx$/, "");
      if (oldPiece && newPiece && oldPiece !== newPiece) {
        renames.set(oldPiece, newPiece);
      }
    }
  }
  return renames;
}

function rewriteMetaJsonReferences(
  renames: Map<string, string>,
  opts: SyncOptions,
): string[] {
  const updated: string[] = [];
  if (!existsSync(CONTENT_DIR)) return updated;
  const stack: string[] = [CONTENT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name !== "meta.json") continue;
      const text = readFileSync(full, "utf8");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      if (
        !json ||
        typeof json !== "object" ||
        !Array.isArray((json as { pages?: unknown }).pages)
      ) {
        continue;
      }
      const meta = json as { pages: unknown[] };
      let touched = false;
      const before = meta.pages.slice();
      meta.pages = meta.pages.map((p) => {
        if (typeof p !== "string") return p;
        const next = renames.get(p);
        if (next && next !== p) {
          touched = true;
          return next;
        }
        return p;
      });
      if (!touched) continue;
      const rel = relative(CONTENT_DIR, full).replace(/\\/g, "/");
      const renamePairs = before
        .map((b, i) => [b, meta.pages[i]] as const)
        .filter(([a, b]) => a !== b)
        .map(([a, b]) => `${a} → ${b}`);
      updated.push(`${rel}: ${renamePairs.join(", ")}`);
      if (!opts.dryRun) {
        writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      }
    }
  }
  return updated;
}

/**
 * After --clean removes script-owned files, walk each managed folder and
 * delete it if empty, then bubble up to its parent. Stops at CONTENT_DIR
 * so the docs root itself is never removed.
 */
function pruneEmptyFolders(managedFolders: Set<string>) {
  // Process deepest paths first so child folders are evaluated before parents.
  const ordered = [...managedFolders]
    .filter((f) => f && f !== ".")
    .sort((a, b) => b.split("/").length - a.split("/").length);
  const visited = new Set<string>();
  for (const folder of ordered) {
    let dir = join(CONTENT_DIR, folder);
    while (dir !== CONTENT_DIR && !visited.has(dir)) {
      visited.add(dir);
      if (!existsSync(dir)) {
        dir = dirname(dir);
        continue;
      }
      try {
        if (readdirSync(dir).length > 0) break;
      } catch {
        break;
      }
      rmSync(dir, { recursive: true, force: true });
      dir = dirname(dir);
    }
  }
}

function syncShareArchive(stamp: string) {
  try {
    const records = fetchBitableRecords(BITABLE_ARCHIVE_TOKEN);
    mkdirSync(DATA_DIR, { recursive: true });
    const outPath = join(DATA_DIR, "share-records.json");
    writeFileSync(
      outPath,
      JSON.stringify({ updatedAt: stamp, records }, null, 2),
      "utf8",
    );
    console.log(
      `[sync] share-records.json ← bitable ${BITABLE_ARCHIVE_TOKEN} (${records.length} 条记录)`,
    );
  } catch (e) {
    console.error(
      `[sync] bitable archive 拉取失败: ${(e as Error).message.split("\n")[0]}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
