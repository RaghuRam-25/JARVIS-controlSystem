import "./env.js";
import os from "os";
import path from "path";
import crypto from "crypto";

function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function readInt(key: string, fallback: number): number {
  const parsed = parseInt(readString(key, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const CONFIG = {
  NODE_ENV: readString("NODE_ENV", "development"),
  HOST_BIND_ADDRESS: readString("HOST_BIND_ADDRESS", "0.0.0.0"),
  PORT: readInt("PORT", 4000),
  WEB_PORT: readInt("WEB_PORT", 3000),
  HOST_NAME: readString("HOST_NAME", os.hostname() || "JARVIS-Windows-Host"),
  SECRET_KEY: readString("JARVIS_SECRET", "") || crypto.randomBytes(32).toString("hex"),
  PAIRING_NONCE_TTL_MS: readInt("PAIRING_NONCE_TTL_MS", 60000), // 60 seconds
  SESSION_TTL_MS: readInt("SESSION_TTL_MS", 604800000), // 7 days
  MAX_PAIRING_ATTEMPTS_PER_MIN: readInt("MAX_PAIRING_ATTEMPTS_PER_MIN", 5),
  CORS_ORIGIN: readString("CORS_ORIGIN", "*"),
  PUBLIC_SIGNALING_URL: readString("PUBLIC_SIGNALING_URL", ""),
  DATA_DIR: readString("DATA_DIR", "") || path.join(os.homedir(), ".jarvis-host"),
};