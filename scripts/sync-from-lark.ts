/**
 * Sync the SAST Next Sig wiki space from Feishu/Lark into content/docs/.
 *
 * Run: pnpm sync:lark            (full sync, cleans content/docs first)
 *      pnpm sync:lark --dry-run  (no writes)
 *      pnpm sync:lark --no-clean (preserve existing files)
 *
 * Requires: lark-cli on PATH, authenticated as a user that can read the wiki space.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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

// Wiki nodes whose `parent_node_token` is empty but which `wiki nodes list` does
// not return — we list them as additional seeds and pull via wiki spaces get_node.
const EXTRA_SEEDS = ["KatOwPcwTiGfRxk5LBRc9RJtnDe"];

// node_token → relative slug under content/docs (no leading slash, no .mdx).
// Empty-container nodes (index, first-meeting/index, second-meeting) and the
// archive page (rendered from JSON via <ShareArchive />) are not listed here;
// the clean step preserves them via HANDWRITTEN_FILES below.
const PATH_MAP: Record<string, string> = {
  VxqLwYkTZiFiBskJPAncgRtHnjf: "getting-started", // SAST Next Sig 服用指南
  WKbnw04HYirT2kkm6KTcvZltnm6: "first-meeting/why-proxy-traffic-gets-detected",
  LziGwjFEIigqNcklL4VcdeRPngb: "first-meeting/context-engineering",
  N9lswyBw9iuB7PkiDSOcneznnqe: "first-meeting/claude-code-getting-started",
  UFPmwhdrOiFw9TkP3TicoCIqnVf: "first-meeting/cloudflare-tunnel-deployment",
};

// node_token of the bitable that drives the share-archive page.
const BITABLE_ARCHIVE_TOKEN = "UYPIbjgltah32Msm56QcWSz8npg";

// Files we hand-write and don't want overwritten by sync. Paths are relative
// to CONTENT_DIR. The clean step below preserves these explicitly.
const HANDWRITTEN_FILES = new Set([
  "index.mdx",
  "second-meeting.mdx",
  "components.mdx",
  "archive.mdx",
  "first-meeting/index.mdx",
  "meta.json",
  "first-meeting/meta.json",
]);

interface Node {
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  parent_node_token: string;
  has_child: boolean;
}

function lark(args: string[], timeoutMs = 90_000): string {
  // shell:true so Windows resolves the lark-cli.cmd shim on PATH.
  // We single-quote each arg to keep JSON --params intact regardless of shell.
  const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  return execSync(`lark-cli ${quoted}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
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

function flattenTree(): Node[] {
  const seen = new Set<string>();
  const result: Node[] = [];
  const visit = (parent: string) => {
    for (const item of listChildren(parent)) {
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
  return result;
}

interface TransformResult {
  body: string;
  mediaTokens: string[];
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
  //     We delete only the first H1 whose text fuzzy-matches the node title,
  //     and any leading H1 occurring before substantive content.
  const escapedTitle = nodeTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  md = md.replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\n+`, "m"), "");
  md = md.replace(/^#\s+[^\n]+\n+/, "");

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

  // 6. Embedded sheet/bitable/whiteboard/etc. — replace with hint blockquote.
  md = md.replace(
    /<(sheet|bitable|whiteboard|mindnote|slides|file)\b[^>]*\/>/g,
    "\n> 飞书表格 / 文件嵌入块未在静态站点渲染，请[查看飞书原文](#)。\n",
  );
  md = md.replace(
    /<(sheet|bitable|whiteboard|mindnote|slides|file)\b[^>]*>[\s\S]*?<\/\1>/g,
    "\n> 飞书表格 / 文件嵌入块未在静态站点渲染，请[查看飞书原文](#)。\n",
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
        /^\s*(title|published|tags|date|category|categories|author|description)\s*:/m.test(
          inner,
        )
      ) {
        const lines = inner
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
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
  //     Allow blockquote markers `> ` before the fence so quoted code blocks
  //     are normalised too.
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
    // Drop leading record-id column.
    const stripped = line.replace(/^\|[^|]*\|/, "|");
    const cells = stripped
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
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
      // Some cells render as [https://...](https://...) — collapse to just URL.
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

function _transformBitableMarkdown(rawTable: string): string {
  const lines = rawTable.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("`_record_id`")) continue;
    if (line.startsWith("Meta:")) continue;
    if (!line.startsWith("|")) {
      out.push(line);
      continue;
    }
    // Drop the first column (record id / metadata).
    let stripped = line.replace(/^\|[^|]*\|/, "|");
    // Strip Lark person mentions of the form "Alias [@真实姓名](avatar-url)"
    // — keep only the alias to avoid leaking real names + avatar URLs.
    stripped = stripped.replace(/\s*\[@[^\]]+\]\(https?:\/\/[^)]+\)/g, "");
    out.push(stripped);
  }
  return out.join("\n").trim();
}

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

function deriveDescription(body: string): string {
  // Build paragraphs from body, skipping headings, blockquotes, code fences,
  // tables, and JSX/HTML-only lines. Pick the first paragraph longer than 20
  // characters as a representative description.
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

function downloadMedia(token: string): boolean {
  const target = join(MEDIA_DIR, `${token}.png`);
  if (existsSync(target)) return true;
  // lark-cli rejects absolute --output paths. Run from MEDIA_DIR with a
  // relative filename so the constraint is satisfied.
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
    });
  } catch (e) {
    console.error(
      `[sync] media-download ${token} 失败: ${(e as Error).message.split("\n")[0]}`,
    );
    return false;
  }
  return existsSync(target);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const noClean = argv.includes("--no-clean");

  console.log("[sync] 拉取 wiki 节点树…");
  const nodes = flattenTree();
  console.log(`[sync] 共 ${nodes.length} 个节点`);

  if (!noClean && !dryRun) {
    cleanContentDir();
    rmSync(MEDIA_DIR, { recursive: true, force: true });
  }
  if (!dryRun) {
    mkdirSync(CONTENT_DIR, { recursive: true });
    mkdirSync(MEDIA_DIR, { recursive: true });
  }

  const stamp = new Date().toISOString();

  for (const node of nodes) {
    const slug = PATH_MAP[node.node_token];
    if (!slug) {
      console.log(
        `[sync] 跳过未映射节点: ${node.node_token} (${node.title.trim()})`,
      );
      continue;
    }
    const filePath = join(CONTENT_DIR, `${slug}.mdx`);
    const url = `${WIKI_URL_PREFIX}${node.node_token}`;
    console.log(
      `[sync] ${slug.padEnd(48)} ← ${node.obj_token} (${node.obj_type})`,
    );

    let body = "";
    let media: string[] = [];

    if (node.obj_type === "docx") {
      let rawMd = "";
      let rawXml = "";
      try {
        rawMd = larkContent(node.obj_token, "markdown");
        rawXml = larkContent(node.obj_token, "xml");
      } catch (e) {
        console.error(
          `[sync] fetch ${node.obj_token} 失败: ${(e as Error).message.split("\n")[0]}`,
        );
        continue;
      }
      const result = transformDocxMarkdown(rawMd, rawXml, node.title);
      body = result.body;
      media = result.mediaTokens;

      // Empty container / placeholder → friendly placeholder body.
      if (!body.trim()) {
        if (node.has_child) {
          body = "本节包含若干篇分享内容，请从左侧目录进入。\n";
        } else {
          body = `> 此页面暂未填充内容。原始飞书文档：[${node.title.trim()}](${url})\n`;
        }
      }
    } else {
      // bitable / sheet etc. — handled separately below.
      console.log(`[sync] 跳过非 docx 节点 (${node.obj_type})`);
      continue;
    }

    if (!dryRun) {
      for (const tok of media) downloadMedia(tok);
    }

    const fm = frontmatter({
      title: node.title.trim(),
      description: deriveDescription(body),
      feishuToken: node.obj_token,
      lastSyncedAt: stamp,
    });
    const finalContent = `${fm}\n${body}`;
    if (!dryRun) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, finalContent, "utf8");
    }
  }

  if (!dryRun) {
    syncShareArchive(stamp);
  }

  console.log(
    "[sync] 完成（手写文件已保留：" +
      Array.from(HANDWRITTEN_FILES).join(", ") +
      "）",
  );
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

function cleanContentDir() {
  if (!existsSync(CONTENT_DIR)) return;
  const stack: string[] = [CONTENT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(CONTENT_DIR, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (HANDWRITTEN_FILES.has(rel)) continue;
      rmSync(full, { force: true });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
