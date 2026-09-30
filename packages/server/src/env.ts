import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/**
 * Resolves the monorepo root .env by walking up from this module until a
 * directory containing a `.env` file is found. Works identically for
 * `src/` (tsx dev) and `dist/` (compiled) without hardcoding a depth.
 */
function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const ENV_FILE_PATH = findEnvFile(__dirname);

if (ENV_FILE_PATH) {
  dotenv.config({ path: ENV_FILE_PATH, override: false });
}