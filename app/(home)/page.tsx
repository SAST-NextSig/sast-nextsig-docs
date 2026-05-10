import { ArrowRightIcon, BookOpenIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-col flex-1">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-fd-border">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,theme(colors.fd-primary/0.18),transparent_60%)]"
        />
        <div className="mx-auto flex max-w-5xl flex-col items-center px-4 py-20 text-center md:py-28">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs font-medium text-fd-muted-foreground">
            <SparklesIcon className="size-3.5" />
            南京邮电大学 · SAST · Next Sig
          </span>
          <h1 className="bg-gradient-to-br from-fd-foreground to-fd-foreground/60 bg-clip-text text-5xl font-bold tracking-tight text-transparent md:text-6xl">
            SAST Next Sig
          </h1>
          <p className="mt-4 max-w-2xl text-balance text-base text-fd-muted-foreground md:text-lg">
            一片相对干净的土壤 ——
            分享会形式的开放讨论，覆盖前沿技术与计算机底层。 内容来自飞书 Wiki
            的实时同步，开源在 GitHub。
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/docs"
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground shadow-sm transition hover:bg-fd-primary/90"
            >
              <BookOpenIcon className="size-4" />
              开始阅读
              <ArrowRightIcon className="size-4" />
            </Link>
            <Link
              href="/docs/getting-started"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-5 text-sm font-medium text-fd-foreground transition hover:bg-fd-muted"
            >
              服用指南
            </Link>
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-4 py-12 md:grid-cols-3">
        <FeatureCard
          title="主题随心"
          description="计算机、AI、网络、协议、操作系统 —— 分享者自由选题，深度优先。"
        />
        <FeatureCard
          title="飞书同步"
          description="原始内容写在飞书 Wiki，本站通过脚本自动转 MDX，结构化呈现。"
        />
        <FeatureCard
          title="可搜索 / 可问 AI"
          description="全站内容已建立全文索引；浮动按钮 Ask AI 直接基于文档回答问题。"
        />
      </section>
    </main>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="group rounded-xl border border-fd-border bg-fd-card p-5 transition hover:border-fd-primary/40 hover:shadow-sm">
      <h3 className="text-base font-semibold text-fd-foreground">{title}</h3>
      <p className="mt-2 text-sm text-fd-muted-foreground">{description}</p>
    </div>
  );
}
