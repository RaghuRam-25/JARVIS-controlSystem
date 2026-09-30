import type { NextConfig } from "next";
import fs from "fs";
import path from "path";
import { loadEnvConfig } from "@next/env";

const monorepoRoot = path.resolve(__dirname, "../../");

/**
 * Next.js 16 removed the `envDir` option, so the root `.env` is loaded
 * explicitly here. Loading it into `process.env` before the config is
 * evaluated makes every `NEXT_PUBLIC_*` key available for inlining.
 */
const originalNodeEnv = process.env.NODE_ENV;

for (const dir of [monorepoRoot, __dirname]) {
  if (fs.existsSync(path.join(dir, ".env"))) {
    loadEnvConfig(dir);
  }
}

// NODE_ENV is owned by the Next.js CLI (dev/prod/build). A stray value coming
// from .env would flip `next build` into dev mode and break prerendering.
const mutableEnv = process.env as Record<string, string | undefined>;
if (originalNodeEnv !== undefined) {
  mutableEnv.NODE_ENV = originalNodeEnv;
} else {
  delete mutableEnv.NODE_ENV;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;