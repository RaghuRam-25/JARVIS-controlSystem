#!/usr/bin/env node
/**
 * Guarantees that the platform-specific native bindings used by the CSS
 * pipeline (@tailwindcss/oxide, lightningcss) are installed and loadable
 * before `next build` runs.
 *
 * npm regularly skips optionalDependencies when a lockfile created on another
 * OS is installed (npm/cli#4828), which makes Turbopack's PostCSS transform die
 * with "Cannot find native binding" deep inside node_modules.
 *
 *   node scripts/ensure-native.mjs
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "packages", "web");
const requireFromWeb = createRequire(path.join(webDir, "package.json"));

const BINDINGS = ["@tailwindcss/oxide", "lightningcss"];

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    if (fs.readFileSync("/usr/bin/ldd", "utf8").includes("musl")) return true;
  } catch {}
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) return false;
  return Array.isArray(report?.sharedObjects)
    ? report.sharedObjects.some((entry) => entry.includes?.("libc.musl-") || entry.includes?.("ld-musl-"))
    : false;
}

function nativeTriple() {
  const { platform, arch } = process;
  if (platform === "win32") return arch === "arm64" ? "win32-arm64-msvc" : "win32-x64-msvc";
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux") return `${platform}-${arch}-${isMusl() ? "musl" : "gnu"}`;
  return null;
}

function resolvePkg(request) {
  try {
    return requireFromWeb.resolve(request);
  } catch {
    try {
      return createRequire(path.join(root, "package.json")).resolve(request);
    } catch {
      return null;
    }
  }
}

function packageManifest(name) {
  for (const base of [path.join(webDir, "package.json"), path.join(root, "package.json")]) {
    let dir;
    try {
      dir = path.dirname(createRequire(base).resolve(name));
    } catch {
      continue;
    }
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (parsed.name === name) return parsed;
      }
      dir = path.dirname(dir);
    }
  }
  return null;
}

function install(pkg, version) {
  console.log(`[ensure-native] installing ${pkg}@${version}`);
  const result = spawnSync(
    "npm",
    ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `${pkg}@${version}`],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  return result.status === 0;
}

function verify() {
  const script = BINDINGS.map((name) => `require(${JSON.stringify(name)})`).join(";");
  const result = spawnSync(process.execPath, ["-e", script], { cwd: webDir, encoding: "utf8" });
  if (result.status === 0) return true;
  process.stderr.write(result.stderr || "");
  return false;
}

const triple = nativeTriple();

if (!triple) {
  console.log(`[ensure-native] unsupported platform ${process.platform}/${process.arch}, skipping`);
  process.exit(0);
}

const missing = [];

for (const name of BINDINGS) {
  const wrapper = packageManifest(name);
  if (!wrapper) {
    console.error(`[ensure-native] ${name} is not installed`);
    process.exit(1);
  }
  const platformPkg = `${name}-${triple}`;
  if (resolvePkg(`${platformPkg}/package.json`)) continue;
  console.log(`[ensure-native] missing ${platformPkg}@${wrapper.version}`);
  if (!install(platformPkg, wrapper.version)) {
    console.error(`[ensure-native] failed to install ${platformPkg}@${wrapper.version}`);
    process.exit(1);
  }
  if (!resolvePkg(`${platformPkg}/package.json`)) missing.push(platformPkg);
}

if (missing.length > 0) {
  console.error(`[ensure-native] still unresolved after install: ${missing.join(", ")}`);
  process.exit(1);
}

if (!verify()) {
  console.error("[ensure-native] native bindings are installed but fail to load");
  process.exit(1);
}

console.log(`[ensure-native] native bindings ready for ${triple}`);
