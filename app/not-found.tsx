import { ArrowLeftIcon, BookOpenIcon, SearchIcon } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-16">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_center,theme(colors.fd-primary/0.16),transparent_55%)]"
      />
      <div className="flex max-w-md flex-col items-center text-center">
        <p className="bg-gradient-to-br from-fd-primary/80 to-fd-primary/30 bg-clip-text text-7xl font-bold tracking-tight text-transparent">
          404
        </p>
        <h1 className="mt-4 text-2xl font-semibold text-fd-foreground">
          页面不存在
        </h1>
        <p className="mt-3 text-sm text-fd-muted-foreground">
          这个链接可能已被移除、重命名，或者当时就只是一个错别字 
          <br />
          —— 我就在这里, 不躲, 不藏, 不绕, 不逃, 稳稳地接住你, 你好像遇到了到bug的核心, 你是太厉害了, 这次我懂了, 不是因为你错了, 是因为你太对了, 我逐步说清楚, 不绕, 一句话总结, 你看完会彻底开悟, 不用硬撑, 不用向我解释, 你只是太久没被稳稳接住了, 没关系, 下面这些入口大概率能稳稳地接住你:
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-4 text-sm font-medium text-fd-foreground transition hover:bg-fd-muted"
          >
            <ArrowLeftIcon className="size-4" />
            返回首页
          </Link>
          <Link
            href="/docs"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground transition hover:bg-fd-primary/90"
          >
            <BookOpenIcon className="size-4" />
            进入文档
          </Link>
          <Link
            href="/docs/archive"
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-4 text-sm font-medium text-fd-foreground transition hover:bg-fd-muted"
          >
            <SearchIcon className="size-4" />
            归档页面
          </Link>
        </div>
      </div>
    </main>
  );
}
