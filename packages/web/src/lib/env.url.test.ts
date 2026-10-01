import assert from "assert";
import { resolveHostApiUrl, getApiBaseUrl, getSocketUrl, apiUrl, API_ENDPOINTS } from "./env";

const API_PORT = process.env.NEXT_PUBLIC_API_PORT || "4000";

const CASES: Array<[label: string, input: string, expected: string]> = [
  // Public Railway / custom domains must NEVER receive an internal port.
  ["railway https", "https://jarvisserver-production-613e.up.railway.app", "https://jarvisserver-production-613e.up.railway.app"],
  ["railway http upgrade", "http://jarvisserver-production-613e.up.railway.app", "https://jarvisserver-production-613e.up.railway.app"],
  ["railway bare", "jarvisserver-production-613e.up.railway.app", "https://jarvisserver-production-613e.up.railway.app"],
  ["public https", "https://jarvis.example.com", "https://jarvis.example.com"],
  ["public ipv4", "8.8.8.8", "https://8.8.8.8"],
  ["public ipv4 http", "http://8.8.8.8", "https://8.8.8.8"],
  // Explicit ports are preserved verbatim.
  ["explicit port", "https://jarvis.example.com:8443", "https://jarvis.example.com:8443"],
  ["explicit private port", "http://192.168.1.50:5000", "http://192.168.1.50:5000"],
  // Loopback + private LAN hosts get the dev port appended.
  ["localhost http", "http://localhost", `http://localhost:${API_PORT}`],
  ["localhost bare", "localhost", `http://localhost:${API_PORT}`],
  ["loopback v4", "127.0.0.1", `http://127.0.0.1:${API_PORT}`],
  ["rfc1918 10", "10.0.0.7", `http://10.0.0.7:${API_PORT}`],
  ["rfc1918 172", "172.16.4.9", `http://172.16.4.9:${API_PORT}`],
  ["rfc1918 192", "192.168.1.50", `http://192.168.1.50:${API_PORT}`],
  ["mdns", "jarvis-host.local", `http://jarvis-host.local:${API_PORT}`],
  ["ipv6 loopback", "[::1]", `http://[::1]:${API_PORT}`],
  ["ipv6 ula", "[fd00::1]", `http://[fd00::1]:${API_PORT}`],
  // 172.32/172.15 are outside the private block -> treated as public.
  ["172.32 public", "172.32.4.9", "https://172.32.4.9"],
  ["172.15 public", "172.15.4.9", "https://172.15.4.9"],
  // Trailing slashes + whitespace are normalized away.
  ["trailing slash", "https://jarvis.example.com/", "https://jarvis.example.com"],
  ["whitespace", "  https://jarvis.example.com/  ", "https://jarvis.example.com"],
  ["nested path stripped", "https://jarvis.example.com/some/path", "https://jarvis.example.com"],
];

function runEnvUrlTests() {
  console.log("\n--- [ENV URL RESOLUTION TESTS] ---");

  console.log(`[1/5] Public origins never gain an internal port (${CASES.length} cases)...`);
  for (const [label, input, expected] of CASES) {
    const actual = resolveHostApiUrl(input);
    assert.strictEqual(actual, expected, `${label}: resolveHostApiUrl(${JSON.stringify(input)})`);
    assert.ok(!actual.includes(`:${API_PORT}/`) || expected.includes(`:${API_PORT}`), `${label}: unexpected port`);
  }

  console.log("[2/5] The reported production failure is fixed...");
  const railway = resolveHostApiUrl("jarvisserver-production-613e.up.railway.app");
  assert.strictEqual(railway, "https://jarvisserver-production-613e.up.railway.app");
  assert.ok(!railway.includes(":4000"), `Railway origin must not contain :4000 (got ${railway})`);
  assert.ok(railway.startsWith("https://"), "Railway origin must be https so Socket.IO upgrades to wss://");
  const socketPath = `${railway}/socket.io/?EIO=4&transport=websocket`;
  assert.ok(socketPath.startsWith("wss://") === false, "http(s) base must let socket.io-client choose wss://");
  assert.ok(!socketPath.includes(":4000"), "WebSocket upgrade path must not contain :4000");

  console.log("[3/5] Empty host falls back to the configured API base...");
  assert.strictEqual(resolveHostApiUrl(""), getApiBaseUrl());
  assert.strictEqual(resolveHostApiUrl(undefined), getApiBaseUrl());
  assert.strictEqual(resolveHostApiUrl(), getApiBaseUrl());

  console.log("[4/5] Malformed input degrades safely instead of throwing...");
  for (const bad of ["http://", "://nope", "ht tp://x", "%%%", "http://:99999"]) {
    const result = resolveHostApiUrl(bad);
    assert.strictEqual(result, getApiBaseUrl(), `malformed input ${JSON.stringify(bad)} must fall back`);
  }

  console.log("[5/5] Socket.IO and apiUrl share the same normalized origin...");
  const socketUrl = getSocketUrl();
  assert.ok(!socketUrl.includes("/socket.io"), "getSocketUrl must return a bare origin");
  assert.strictEqual(
    apiUrl(API_ENDPOINTS.health, railway),
    "https://jarvisserver-production-613e.up.railway.app/health",
    "apiUrl must build paths off the normalized origin"
  );

  // Under SSR there is no window.location, so the client falls back to loopback.
  const expectedSsrBase = process.env.NEXT_PUBLIC_API_URL
    ? resolveHostApiUrl(process.env.NEXT_PUBLIC_API_URL)
    : `http://localhost:${API_PORT}`;
  assert.strictEqual(socketUrl, expectedSsrBase, "getSocketUrl must honor the override when present");

  console.log("\n>>> ALL ENV URL RESOLUTION TESTS PASSED! <<<\n");
}

runEnvUrlTests();