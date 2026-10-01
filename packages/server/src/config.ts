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
  SECRET_IS_EPHEMERAL: !readString("JARVIS_SECRET", ""),
  PAIRING_NONCE_TTL_MS: readInt("PAIRING_NONCE_TTL_MS", 60000), // 60 seconds
  SESSION_TTL_MS: readInt("SESSION_TTL_MS", 604800000), // 7 days
  MAX_PAIRING_ATTEMPTS_PER_MIN: readInt("MAX_PAIRING_ATTEMPTS_PER_MIN", 5),
  CORS_ORIGIN: readString("CORS_ORIGIN", "*"),
  PUBLIC_SIGNALING_URL: readString("PUBLIC_SIGNALING_URL", ""),
  DATA_DIR: readString("DATA_DIR", "") || path.join(os.homedir(), ".jarvis-host"),

  /**
   * JARVIS_SERVER_URL — set ONLY on the Windows Host Agent.
   * When set, the Host Agent will establish an outbound authenticated
   * Socket.IO connection to this Railway Server URL.
   * Example: https://jarvisserver-production-613e.up.railway.app
   * Leave empty on Railway itself (the server does not connect to itself).
   */
  JARVIS_SERVER_URL: readString("JARVIS_SERVER_URL", ""),

  /**
   * IS_HOST_AGENT — set to "true" on the Windows Host Agent.
   * This enables the outbound Railway bridge and Windows-side execution.
   * On Railway (cloud server), this must NOT be set.
   */
  IS_HOST_AGENT: readString("IS_HOST_AGENT", "false") === "true",

  /**
   * The public URL at which this server is reachable from the internet.
   * Resolution order:
   *   1. PUBLIC_SIGNALING_URL (explicit override)
   *   2. RAILWAY_PUBLIC_DOMAIN (auto-injected by Railway)
   *   3. empty string → LAN-only mode (QR encodes the LAN IP)
   */
  get PUBLIC_SERVER_URL(): string {
    const explicit = readString("PUBLIC_SIGNALING_URL", "");
    if (explicit) return explicit.replace(/\/+$/, "");

    const railwayDomain = readString("RAILWAY_PUBLIC_DOMAIN", "");
    if (railwayDomain) return `https://${railwayDomain}`;

    return "";
  },
};

// An ephemeral secret silently invalidates every session on restart and breaks
// token validation across replicas, so it must never reach production.
if (CONFIG.SECRET_IS_EPHEMERAL && CONFIG.NODE_ENV === "production") {
  console.error(
    "[JARVIS] FATAL: JARVIS_SECRET is not set. Every restart would invalidate all paired devices " +
      "and multi-instance deployments cannot validate tokens. Generate one with:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

if (CONFIG.SECRET_IS_EPHEMERAL) {
  console.warn(
    "[JARVIS] WARNING: JARVIS_SECRET is not set. Using an ephemeral key; all sessions " +
      "will be invalidated when the Host Agent restarts."
  );
}