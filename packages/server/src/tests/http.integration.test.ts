/**
 * Boots the real HTTP + Socket.IO server and asserts the security guards hold
 * against live requests. Run with: npx tsx src/tests/http.integration.test.ts
 */
import type { AddressInfo } from "net";
import { io as ioClient, Socket } from "socket.io-client";

// Environment must be set before anything pulls in config.js.
const PORT = 47311;
process.env.PORT = String(PORT);
process.env.HOST_BIND_ADDRESS = "127.0.0.1";
process.env.JARVIS_SECRET = "a".repeat(64);
process.env.CORS_ORIGIN = "*";

const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not become ready");
}

function connectSocket(auth: Record<string, unknown>): Promise<{ socket: Socket; hostGranted: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, {
      auth,
      transports: ["websocket"],
      reconnection: false,
      timeout: 8000,
    });
    let hostGranted = false;
    const timer = setTimeout(() => reject(new Error("socket timeout")), 10000);

    socket.on("connect", () => {
      clearTimeout(timer);
      // A rejected socket receives auth:error only for the controller path.
      resolve({ socket, hostGranted });
    });
    socket.on("auth:error", () => {
      hostGranted = false;
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runHttpTests() {
  console.log("\n--- [LIVE HTTP / SOCKET SECURITY INTEGRATION TESTS] ---");

  const { server, io } = await import("../server.js");
  const { getHostCredential } = await import("../services/hostAuth.js");
  const credential = getHostCredential();
  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
  });
  await waitForServer();

  console.log("\n[A] Public endpoints that must stay open for pairing");
  const challenge = await fetch(`${BASE}/api/pairing/challenge`);
  check("GET /api/pairing/challenge is reachable", challenge.status === 200);

  const health = await fetch(`${BASE}/health`);
  check("GET /health is reachable", health.status === 200);

  console.log("\n[B] Host-only endpoints reject anonymous callers");
  for (const [method, path] of [
    ["GET", "/api/pairing/pending"],
    ["GET", "/api/pairing/sessions"],
    ["POST", "/api/pairing/revoke-all"],
  ] as const) {
    const res = await fetch(`${BASE}${path}`, { method });
    check(`${method} ${path} rejects anonymous access`, res.status === 401, `got ${res.status}`);
  }

  const anonDecision = await fetch(`${BASE}/api/pairing/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "00000000-0000-4000-8000-000000000000", decision: "approve" }),
  });
  check("POST /api/pairing/decision rejects anonymous approval", anonDecision.status === 401);

  console.log("\n[C] Forged host credentials are rejected");
  for (const bad of ["true", "1", "", credential.slice(0, -1), "x".repeat(64)]) {
    const res = await fetch(`${BASE}/api/pairing/pending`, {
      headers: { "X-Jarvis-Host-Credential": bad },
    });
    check(`forged credential ${JSON.stringify(bad.slice(0, 12))} rejected`, res.status === 401);
  }

  console.log("\n[D] Genuine host credential is accepted");
  const authed = await fetch(`${BASE}/api/pairing/pending`, {
    headers: { "X-Jarvis-Host-Credential": credential },
  });
  check("valid credential grants host access", authed.status === 200, `got ${authed.status}`);

  console.log("\n[E] Session listing never leaks tokens");
  const sessions = await fetch(`${BASE}/api/pairing/sessions`, {
    headers: { "X-Jarvis-Host-Credential": credential },
  });
  const body = await sessions.text();
  check("sessions response omits token field", !body.includes('"token"'), body.slice(0, 160));

  console.log("\n[F] Unauthenticated control events are refused");
  const rogue = await connectSocket({ isHost: true, token: "" });
  const terminalSpawned = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    rogue.socket.on("terminal:ready", () => {
      clearTimeout(timer);
      resolve(true);
    });
    rogue.socket.emit("terminal:spawn", { shell: "powershell.exe", cols: 80, rows: 24 });
  });
  check("anonymous client cannot spawn a terminal", terminalSpawned === false);

  const killSwitchRan = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), 2500);
    rogue.socket.on("session:revoked_all", () => {
      clearTimeout(timer);
      resolve(false);
    });
    rogue.socket.emit("session:revoke_all");
  });
  check("anonymous client cannot trigger the kill switch", killSwitchRan === true);

  rogue.socket.disconnect();

  console.log("\n[G] A genuine host socket is granted host privileges");
  const realHost = await connectSocket({ isHost: true, hostCredential: credential });
  const approvedEvents: Array<Record<string, unknown>> = [];
  realHost.socket.on("pairing:approved", (payload) => approvedEvents.push(payload));
  realHost.socket.on("host:terminal:spawn", (payload: any) => {
    realHost.socket.emit("host:terminal:ready", {
      sessionId: payload.sessionId,
      cols: payload.cols || 80,
      rows: payload.rows || 24,
    });
  });

  const challengeData: any = await (await fetch(`${BASE}/api/pairing/challenge`)).json();
  await fetch(`${BASE}/api/pairing/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: challengeData.challenge.challengeId,
      nonce: challengeData.challenge.nonce,
      clientName: "Integration Phone",
      clientFingerprint: "fp-integration-00000001",
      deviceType: "phone",
    }),
  });

  await new Promise((r) => setTimeout(r, 800));
  const pending: any = await (
    await fetch(`${BASE}/api/pairing/pending`, { headers: { "X-Jarvis-Host-Credential": credential } })
  ).json();
  check("host sees the pending pairing request", pending.pending?.length === 1);

  const decision = await fetch(`${BASE}/api/pairing/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Jarvis-Host-Credential": credential },
    body: JSON.stringify({ requestId: pending.pending[0].requestId, decision: "approve" }),
  });
  const decisionBody: any = await decision.json();
  check("host approval issues a session token", Boolean(decisionBody.session?.token));

  await new Promise((r) => setTimeout(r, 500));
  check("host received the pairing:approved event", approvedEvents.length === 1);
  check(
    "broadcast approval event never carries a token",
    approvedEvents.every((e) => e.token === undefined),
    JSON.stringify(approvedEvents).slice(0, 160)
  );

  const issuedToken = decisionBody.session.token;
  const paired = await connectSocket({ isHost: false, token: issuedToken });
  const spawnWorked = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    paired.socket.on("terminal:ready", () => {
      clearTimeout(timer);
      resolve(true);
    });
    paired.socket.emit("terminal:spawn", { shell: "powershell.exe", cols: 80, rows: 24 });
  });
  check("paired controller with a valid token CAN spawn a terminal", spawnWorked === true);

  paired.socket.disconnect();
  realHost.socket.disconnect();

  console.log("\n[H] Oversized payloads are refused");
  const huge = await fetch(`${BASE}/api/pairing/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: "x".repeat(300000), nonce: "y".repeat(300000) }),
  });
  check("oversized JSON body rejected", huge.status === 413 || huge.status === 400, `got ${huge.status}`);

  console.log(`\n>>> LIVE INTEGRATION: ${passed} passed, ${failed} failed <<<\n`);

  io.close();
  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

runHttpTests().catch((err) => {
  console.error("HTTP integration test failed:", err);
  process.exit(1);
});