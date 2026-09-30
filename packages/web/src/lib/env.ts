/**
 * Single source of truth for every network value used by the web client.
 *
 * Everything here is driven by the root `.env` file (NEXT_PUBLIC_* keys), so
 * ports/URLs/ICE servers are configured in exactly one place instead of being
 * hardcoded across components.
 *
 * NOTE: `process.env.NEXT_PUBLIC_*` lookups must stay static — Next.js only
 * inlines literal member expressions into the browser bundle.
 */

const DEFAULT_API_PORT = "4000";
const DEFAULT_WEB_PORT = "3000";
const DEFAULT_STUN = "stun:stun.l.google.com:19302";

const API_URL_OVERRIDE = (process.env.NEXT_PUBLIC_API_URL || "").trim();
const SOCKET_URL_OVERRIDE = (process.env.NEXT_PUBLIC_SOCKET_URL || "").trim();

export const API_PORT = (process.env.NEXT_PUBLIC_API_PORT || "").trim() || DEFAULT_API_PORT;
export const WEB_PORT = (process.env.NEXT_PUBLIC_WEB_PORT || "").trim() || DEFAULT_WEB_PORT;

export const API_ENDPOINTS = {
  health: "/health",
  pairingChallenge: "/api/pairing/challenge",
  pairingRequest: "/api/pairing/request",
  pairingDecision: "/api/pairing/decision",
  pairingPending: "/api/pairing/pending",
  pairingSessions: "/api/pairing/sessions",
  pairingRevoke: "/api/pairing/revoke",
  pairingRevokeAll: "/api/pairing/revoke-all",
  systemStatus: "/api/system/status",
  voiceIntent: "/api/voice/intent",
} as const;

export type ApiEndpointPath = (typeof API_ENDPOINTS)[keyof typeof API_ENDPOINTS];

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function splitList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function currentOrigin(): string {
  if (typeof window === "undefined") return "";
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}`;
}

function resolveBase(override: string): string {
  if (override) return stripTrailingSlash(override);
  const origin = currentOrigin();
  return origin ? `${origin}:${API_PORT}` : `http://localhost:${API_PORT}`;
}

/** Base URL of the Host Agent for the machine this browser is running on. */
export function getApiBaseUrl(): string {
  return resolveBase(API_URL_OVERRIDE);
}

/** Socket.IO endpoint. Falls back to the API base when not overridden. */
export function getSocketUrl(): string {
  return resolveBase(SOCKET_URL_OVERRIDE || API_URL_OVERRIDE);
}

/**
 * Normalizes a Host reference into an absolute API base URL.
 * Accepts a bare LAN IP ("192.168.1.50"), a host:port pair, or a full URL,
 * and fills in NEXT_PUBLIC_API_PORT when no port is present.
 */
export function resolveHostApiUrl(host?: string): string {
  if (!host) return getApiBaseUrl();
  const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = API_PORT;
    return stripTrailingSlash(url.origin);
  } catch {
    return getApiBaseUrl();
  }
}

/** Builds a full request URL from an endpoint path in API_ENDPOINTS. */
export function apiUrl(endpoint: ApiEndpointPath, base: string = getApiBaseUrl()): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${stripTrailingSlash(base)}${path}`;
}

/** Web UI URL for a given Host LAN IP (used by the Android bridge screen). */
export function webUiUrl(host: string): string {
  return `http://${host}:${WEB_PORT}/?mode=controller`;
}

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [];

  const stunUrls = splitList(process.env.NEXT_PUBLIC_STUN_URLS || DEFAULT_STUN);
  if (stunUrls.length > 0) {
    servers.push({ urls: stunUrls });
  }

  const turnUrls = splitList(process.env.NEXT_PUBLIC_TURN_URL);
  if (turnUrls.length > 0) {
    const username = (process.env.NEXT_PUBLIC_TURN_USERNAME || "").trim();
    const credential = (process.env.NEXT_PUBLIC_TURN_CREDENTIAL || "").trim();
    servers.push({
      urls: turnUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  return servers;
}

export const ICE_SERVERS: RTCIceServer[] = buildIceServers();