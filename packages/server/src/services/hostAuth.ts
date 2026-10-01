import crypto from "crypto";
import { CONFIG } from "../config.js";

const HOST_CREDENTIAL_LABEL = "jarvis-v1.host-credential.v1";

/**
 * Derives the Host Agent credential from the configured signing secret.
 *
 * The Host role is the most privileged capability in the system (it can drive
 * the keyboard, spawn shells and approve pairings), so it must never be
 * claimable by a remote client. Deriving it from JARVIS_SECRET means it rotates
 * with the secret and requires no extra configuration.
 */
export function deriveHostCredential(): string {
  return crypto
    .createHmac("sha256", CONFIG.SECRET_KEY)
    .update(HOST_CREDENTIAL_LABEL)
    .digest("hex");
}

let cachedCredential: string | null = null;

export function getHostCredential(): string {
  if (!cachedCredential) {
    cachedCredential = deriveHostCredential();
  }
  return cachedCredential;
}

/** Constant-time comparison so the credential cannot be recovered by timing. */
export function verifyHostCredential(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }
  const expected = Buffer.from(getHostCredential(), "utf-8");
  const provided = Buffer.from(candidate, "utf-8");
  if (expected.length !== provided.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, provided);
}

/**
 * Only loopback callers may request the Host credential.
 *
 * The Host Deck UI always runs on the same machine as the Host Agent
 * (Electron shell -> http://localhost:<WEB_PORT>, or local dev). Anything
 * arriving from a LAN address or through a public reverse proxy is refused, so
 * a remote attacker cannot bootstrap host privileges over the network.
 */
export function isLoopbackAddress(remoteAddress?: string | null): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.trim().replace(/^::ffff:/i, "");
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
}