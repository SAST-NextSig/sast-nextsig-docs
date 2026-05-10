import { CalendarIcon, ExternalLinkIcon, UserIcon } from "lucide-react";

interface ShareRecord {
  speaker: string;
  date: string;
  title: string;
  link?: { text: string; url: string };
}

interface ShareArchiveData {
  updatedAt: string;
  records: ShareRecord[];
}

const TOPIC_GRADIENTS = [
  "from-indigo-500/20 to-cyan-500/10",
  "from-amber-500/20 to-rose-500/10",
  "from-emerald-500/20 to-cyan-500/10",
  "from-violet-500/20 to-fuchsia-500/10",
  "from-sky-500/20 to-blue-500/10",
  "from-rose-500/20 to-orange-500/10",
];

function pickGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return TOPIC_GRADIENTS[Math.abs(hash) % TOPIC_GRADIENTS.length];
}

function speakerInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // For "Max Qian" → "MQ"; for "s3loy" → "S3"; for single token take first 2 chars.
  const [first, second] = trimmed.split(/[\s_-]+/).filter(Boolean);
  if (first && second) return (first[0] + second[0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export function ShareArchive({ data }: { data: ShareArchiveData }) {
  const records = [...data.records].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  const groups = new Map<string, ShareRecord[]>();
  for (const r of records) {
    let bucket = groups.get(r.date);
    if (!bucket) {
      bucket = [];
      groups.set(r.date, bucket);
    }
    bucket.push(r);
  }
  const updatedAt = new Date(data.updatedAt);

  return (
    <div className="my-6">
      <p className="mb-6 text-xs text-fd-muted-foreground">
        共 {data.records.length} 条记录 · 上次同步：
        <time dateTime={data.updatedAt}>
          {Number.isFinite(updatedAt.getTime())
            ? updatedAt.toISOString().slice(0, 10)
            : data.updatedAt}
        </time>
      </p>

      <div className="space-y-8">
        {Array.from(groups.entries()).map(([date, items]) => (
          <section key={date}>
            <div className="mb-3 flex items-center gap-2">
              <CalendarIcon className="size-4 text-fd-muted-foreground" />
              <h3 className="m-0 text-sm font-semibold text-fd-foreground">
                {date}
              </h3>
              <span className="text-xs text-fd-muted-foreground">
                · {items.length} 场
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((rec) => (
                <ShareCard
                  key={`${date}-${rec.speaker}-${rec.title}`}
                  record={rec}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ShareCard({ record }: { record: ShareRecord }) {
  const gradient = pickGradient(record.title || record.speaker);
  const card = (
    <article
      className={`group relative overflow-hidden rounded-xl border border-fd-border bg-fd-card p-4 transition hover:border-fd-primary/40 hover:shadow-md`}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b ${gradient}`}
      />
      <div className="relative flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-fd-border bg-fd-card text-xs font-semibold text-fd-foreground shadow-sm">
          {speakerInitials(record.speaker)}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="m-0 truncate text-base font-semibold text-fd-foreground">
            {record.title || "未命名分享"}
          </h4>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-fd-muted-foreground">
            <UserIcon className="size-3" />
            {record.speaker || "匿名"}
          </p>
        </div>
      </div>

      {record.link ? (
        <p className="relative mt-3 flex items-center gap-1.5 text-xs">
          <ExternalLinkIcon className="size-3 shrink-0 text-fd-muted-foreground" />
          <span className="truncate text-fd-primary group-hover:underline">
            {record.link.text}
          </span>
        </p>
      ) : (
        <p className="relative mt-3 text-xs text-fd-muted-foreground/70">
          暂无对应文档
        </p>
      )}
    </article>
  );

  if (!record.link) return card;
  return (
    <a
      href={record.link.url}
      target="_blank"
      rel="noreferrer noopener"
      className="block no-underline"
    >
      {card}
    </a>
  );
}
