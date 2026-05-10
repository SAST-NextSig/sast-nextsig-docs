import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BookOpenIcon, FileTextIcon, UsersIcon } from "lucide-react";
import Image from "next/image";
import { SafeGithubInfo } from "@/components/safe-github-info";
import { appName, gitConfig } from "./shared";

const FEISHU_WIKI_URL =
  "https://njupt-sast.feishu.cn/wiki/space/7625304658956799168";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <Image
            src="/logo.jpg"
            alt={`${appName} logo`}
            width={24}
            height={24}
            className="rounded-md"
            priority
          />
          {appName}
        </span>
      ),
      url: "/",
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        icon: <BookOpenIcon />,
        text: "文档",
        url: "/docs",
        active: "nested-url",
      },
      {
        icon: <FileTextIcon />,
        text: "分享归档",
        url: "/docs/archive",
        active: "url",
      },
      {
        type: "menu",
        icon: <UsersIcon />,
        text: "更多",
        items: [
          {
            text: "飞书原始 Wiki",
            description: "未经裁剪的飞书 Wiki 空间",
            url: FEISHU_WIKI_URL,
            external: true,
          },
          {
            text: "SAST",
            description: "南京邮电大学 SAST",
            url: "https://sast.fun",
            external: true,
          },
          {
            text: "GitHub 仓库",
            description: "本站源码",
            url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
            external: true,
          },
        ],
      },
      // Star/fork badge — silently hides when the repo doesn't exist yet.
      {
        type: "custom",
        children: (
          <SafeGithubInfo
            owner={gitConfig.user}
            repo={gitConfig.repo}
            className="text-xs text-fd-muted-foreground"
          />
        ),
        secondary: true,
      },
    ],
  };
}
