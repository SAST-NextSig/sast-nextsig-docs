import { Banner } from "fumadocs-ui/components/banner";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Inter, Noto_Sans_SC } from "next/font/google";
import Link from "next/link";
import { appName } from "@/lib/shared";
import "./global.css";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description: "SAST Next Sig 文档站",
  openGraph: {
    title: appName,
    description: "SAST Next Sig 文档站",
    images: ["/logo.jpg"],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: appName,
    images: ["/logo.jpg"],
  },
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const notoSansSC = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-noto-sans-sc",
});

const i18n = {
  translations: {
    search: "搜索文档",
    searchNoResult: "暂无结果",
    toc: "本页内容",
    tocNoHeadings: "暂无标题",
    lastUpdate: "最后更新",
    chooseLanguage: "选择语言",
    nextPage: "下一篇",
    previousPage: "上一篇",
    chooseTheme: "切换主题",
    editOnGithub: "在 GitHub 上编辑",
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${inter.variable} ${notoSansSC.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen font-sans">
        <RootProvider i18n={i18n}>
          <Banner id="nextsig-launch-2026" variant="rainbow">
            <span>
              SAST Next Sig 文档站已上线 ·{" "}
              <Link
                href="/docs/components"
                className="underline decoration-dotted underline-offset-2"
              >
                组件速查
              </Link>{" "}
              收录了所有可用 MDX 组件
            </span>
          </Banner>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
