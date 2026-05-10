import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Next.js 16 blocks cross-origin requests to dev resources (/__nextjs_font/…
  // etc.) by default. When you open the site at 127.0.0.1 (or another host
  // alias) instead of localhost, fonts/HMR get blocked. Whitelist the loopback
  // aliases for dev only — has no effect on production builds.
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]"],
};

export default withMDX(config);
