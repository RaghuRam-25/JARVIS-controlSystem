#!/usr/bin/env node
/**
 * Runs a command with the root .env file loaded into process.env.
 *
 * Next.js resolves its listen port from `process.env.PORT` *before* loading
 * .env, so `next dev -p 3000` can never be driven by WEB_PORT. This wrapper
 * keeps the root .env as the single source of truth for ports as well.
 *
 *   node scripts/with-env.mjs next dev
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createRequire } from "module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");

function parseEnvFile(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(envFile, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/with-env.mjs <command> [...args]");
  process.exit(1);
}

const finalArgs = [...args];
const isNextServer =
  /(^|[\\/])next(\.cmd)?$/i.test(command) &&
  finalArgs.some((a) => a === "dev" || a === "start");
const hasExplicitPort = finalArgs.some((a) => a === "-p" || a === "--port");

if (isNextServer && !hasExplicitPort) {
  const webPort = process.env.WEB_PORT || "3000";
  finalArgs.push("-p", webPort);
  console.log(`[with-env] next server port -> ${webPort} (WEB_PORT)`);
}

// Prefer launching the Next.js CLI through node directly so no shell is needed.
let commandToRun = command;
let commandArgs = finalArgs;
let options = { stdio: "inherit", shell: process.platform === "win32", env: process.env };

if (isNextServer) {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    options = { stdio: "inherit", env: process.env };
    commandToRun = process.execPath;
    commandArgs = [require.resolve("next/dist/bin/next"), ...finalArgs];
  } catch {
    /* fall back to the plain spawn above */
  }
}

const child = spawn(commandToRun, commandArgs, options);

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));