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
  hostCredential: "/api/host/credential",
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

/**
 * True for loopback / RFC1918 / link-local / `.local` hosts.
 * Only these are allowed to receive an implicit dev port, because a public
 * deployment terminates TLS on 80/443 at the edge and any explicit port is
 * unreachable (Railway rejects `host:4000` behind its proxy).
 */
function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }

  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;

  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Normalizes any user/QR supplied host reference into an absolute origin.
 *
 * Rules:
 * - explicit scheme is always preserved
 * - explicit port is always preserved
 * - loopback / private LAN hosts without a port get the dev API port appended
 * - public hostnames (Railway, custom domains) never get a port appended
 */
function normalizeOrigin(raw: string, fallbackPort: string): string | null {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!url.hostname) return null;

  if (!url.port) {
    if (isPrivateHostname(url.hostname)) {
      url.port = fallbackPort;
    } else {
      // Public origin: force TLS and never expose an internal port.
      if (!hasScheme || url.protocol === "http:") {
        url.protocol = "https:";
      }
    }
  }

  return stripTrailingSlash(url.origin);
}

function resolveBase(override: string): string {
  if (override) {
    const normalized = normalizeOrigin(override, API_PORT);
    if (normalized) return normalized;
  }

  const origin = currentOrigin();
  if (!origin) return `http://localhost:${API_PORT}`;

  const normalized = normalizeOrigin(origin, API_PORT);
  return normalized || `http://localhost:${API_PORT}`;
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
 * Accepts a bare LAN IP ("192.168.1.50"), a host:port pair, or a full URL.
 * A port is filled in only for loopback/private LAN hosts; public origins such
 * as Railway domains stay port-less so the proxy terminates TLS on 443.
 */
export function resolveHostApiUrl(host?: string): string {
  if (!host) return getApiBaseUrl();
  return normalizeOrigin(host.trim(), API_PORT) || getApiBaseUrl();
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

/**
 * Fetches the Host credential from the Host Agent.
 *
 * The endpoint only answers loopback callers, so this resolves on the Host
 * machine (Electron shell / local dev) and returns null everywhere else.
 */
export async function fetchHostCredential(base: string = getApiBaseUrl()): Promise<string | null> {
  try {
    const res = await fetch(apiUrl(API_ENDPOINTS.hostCredential, base), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.hostCredential === "string" ? data.hostCredential : null;
  } catch {
    return null;
  }
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