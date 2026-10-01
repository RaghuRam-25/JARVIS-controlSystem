import assert from "assert";
import { pairingManager } from "../services/pairingManager.js";
import { terminalManager } from "../services/terminalManager.js";
import { inputAutomation } from "../services/inputAutomation.js";
import { getHostCredential, verifyHostCredential, isLoopbackAddress } from "../services/hostAuth.js";
import { generateUUID } from "@jarvis/shared";

/**
 * Regression tests for the vulnerabilities fixed during the audit. Each case
 * reproduces the original exploit and asserts it is now refused.
 */
async function runHardeningTests() {
  console.log("\n--- [SECURITY HARDENING REGRESSION TESTS] ---");

  // 1. Host credential must be required and unforgeable
  console.log("[1/6] Host credential cannot be self-asserted...");
  const realCredential = getHostCredential();
  assert.ok(realCredential.length === 64, "Host credential must be a SHA-256 hex digest");
  assert.ok(verifyHostCredential(realCredential), "Issued credential must verify");
  assert.ok(!verifyHostCredential(undefined), "undefined must be rejected");
  assert.ok(!verifyHostCredential(""), "empty string must be rejected");
  assert.ok(!verifyHostCredential("true"), "literal 'true' must be rejected");
  assert.ok(!verifyHostCredential("1"), "numeric coercion must be rejected");
  assert.ok(!verifyHostCredential(`${realCredential}x`), "near-miss credential must be rejected");
  assert.ok(!verifyHostCredential(realCredential.slice(0, -1)), "truncated credential must be rejected");
  assert.ok(!verifyHostCredential(realCredential.toUpperCase()), "case must not be normalized away");
  assert.ok(
    !verifyHostCredential(realCredential.replace(/^./, (c) => (c === "a" ? "b" : "a"))),
    "single-character mutation must be rejected"
  );

  // 2. Host credential endpoint is loopback-only
  console.log("[2/6] Host credential is only released to loopback callers...");
  assert.ok(isLoopbackAddress("127.0.0.1"), "127.0.0.1 is loopback");
  assert.ok(isLoopbackAddress("::1"), "::1 is loopback");
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"), "IPv4-mapped loopback is loopback");
  assert.ok(!isLoopbackAddress("192.168.1.50"), "LAN address is not loopback");
  assert.ok(!isLoopbackAddress("10.0.0.5"), "RFC1918 is not loopback");
  assert.ok(!isLoopbackAddress(""), "missing address is not loopback");
  assert.ok(!isLoopbackAddress(null), "null address is not loopback");
  assert.ok(!isLoopbackAddress("8.8.8.8"), "public address is not loopback");

  // 3. Paired token is delivered to the requesting socket only, and only once
  console.log("[3/6] Approved pairing token is delivered once, to the right socket...");
  const challenge = pairingManager.createChallenge();
  const requestPromise = pairingManager.requestPairing(
    {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      clientName: "Regression Phone",
      clientFingerprint: "fp-regression-0000000001",
      deviceType: "phone",
    },
    "192.168.1.77",
    "socket-abc"
  );

  const pending = pairingManager.getPendingApprovals();
  assert.strictEqual(pending.length, 1, "One pending approval expected");
  assert.strictEqual(pairingManager.getSocketIdForRequest(pending[0].requestId), "socket-abc");

  const approved = await pairingManager.handleHostDecision(pending[0].requestId, "approve");
  assert.strictEqual(approved.success, true, "Approval must succeed");
  const requestResult = await requestPromise;
  assert.strictEqual(requestResult.status, "pending", "Request resolves as pending");

  const delivered = pairingManager.consumeTokenForRequest(pending[0].requestId);
  assert.ok(delivered, "Token must be retrievable for socket delivery");
  assert.strictEqual(
    pairingManager.consumeTokenForRequest(pending[0].requestId),
    null,
    "Token must be single-use so it cannot be replayed to another listener"
  );
  assert.strictEqual(delivered, approved.session?.token, "Delivered token must match issued token");
  assert.ok(await pairingManager.validateToken(delivered), "Delivered token must authenticate");

  // 4. Terminal sessions are owned by the socket that spawned them
  console.log("[4/6] Terminal sessions reject non-owner access...");
  const session = terminalManager.createSession({ cols: 80, rows: 24 }, "owner-socket");
  assert.ok(session.sessionId, "Session created");
  assert.ok(
    terminalManager.write(session.sessionId, "echo owner\r\n", "owner-socket"),
    "Owner may write to its own session"
  );
  assert.strictEqual(
    terminalManager.write(session.sessionId, "echo attacker\r\n", "attacker-socket"),
    false,
    "Non-owner must not write to the session"
  );
  assert.strictEqual(
    terminalManager.kill(session.sessionId, "attacker-socket"),
    false,
    "Non-owner must not kill the session"
  );
  assert.strictEqual(
    terminalManager.resize({ sessionId: session.sessionId, cols: 100, rows: 30 }, "attacker-socket"),
    false,
    "Non-owner must not resize the session"
  );
  terminalManager.kill(session.sessionId, "owner-socket");

  // 5. Terminal cwd cannot escape the host working tree
  console.log("[5/6] Terminal cwd traversal is refused...");
  const traversal = terminalManager.createSession(
    { cwd: process.platform === "win32" ? "C:\\Windows\\System32" : "/etc" },
    "owner-socket"
  );
  assert.strictEqual(
    traversal.cwd,
    process.cwd(),
    "System directories must fall back to the server working directory"
  );
  terminalManager.kill(traversal.sessionId, "owner-socket");

  const missing = terminalManager.createSession({ cwd: "definitely-not-a-real-dir-xyz" }, "owner-socket");
  assert.strictEqual(missing.cwd, process.cwd(), "Non-existent cwd must fall back");
  terminalManager.kill(missing.sessionId, "owner-socket");

  // 6. PowerShell command injection through keyboard payloads is neutralized
  console.log("[6/6] Keyboard injection payloads are dropped...");
  const capture: string[] = [];
  const service = inputAutomation as unknown as { sendCommand: (cmd: string) => void };
  const original = service.sendCommand.bind(service);
  service.sendCommand = (cmd: string) => {
    capture.push(cmd);
  };

  try {
    inputAutomation.handleKeyboardKey({
      key: '"; Start-Process calc; #',
      action: "press",
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    assert.strictEqual(capture.length, 0, "Arbitrary key strings must emit no PowerShell command");
    assert.ok(
      capture.every((c) => !c.includes("Start-Process")),
      "Injection payload must never reach the PowerShell command line"
    );

    capture.length = 0;
    inputAutomation.handleKeyboardKey({
      key: "Enter",
      action: "press",
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    assert.strictEqual(capture.length, 1, "Known keys must still work");
    assert.ok(capture[0].includes("{ENTER}"), "Enter maps to {ENTER}");

    capture.length = 0;
    inputAutomation.handleKeyboardType({ text: "'; Start-Process calc; #" });
    assert.strictEqual(capture.length, 1, "Typing must still emit a command");

    const typed = capture[0];
    const payload = typed.slice(typed.indexOf("SendWait('") + "SendWait('".length, -2);
    assert.ok(
      payload.includes("''"),
      "A single quote in typed text must be doubled so it cannot terminate the PowerShell literal"
    );
    const quoteCount = (payload.match(/'/g) || []).length;
    assert.strictEqual(quoteCount % 2, 0, "Quotes in the emitted literal must stay balanced");
    assert.ok(
      typed.endsWith("')"),
      "The PowerShell literal must be closed by the framework, not by attacker input"
    );

    // SendKeys metacharacters must be neutralized so they cannot alter the call.
    inputAutomation.handleKeyboardType({ text: "{(ENTER)}" });
    const braces = capture[capture.length - 1];
    assert.ok(
      braces.includes("{{}{(}ENTER{)}{}}"),
      "SendKeys braces must be escaped so the payload is typed literally"
    );

    // Double quotes and backticks are inert inside a single-quoted literal.
    inputAutomation.handleKeyboardType({ text: 'a"b`c' });
    const inert = capture[capture.length - 1];
    assert.ok(inert.includes('a"b`c'), "Double quotes/backticks stay literal inside single quotes");
    assert.ok(!inert.includes('`"'), "Backtick-escaping is no longer used");
  } finally {
    service.sendCommand = original;
  }

  inputAutomation.cleanup();
  pairingManager.revokeAllSessions("Hardening test cleanup");

  console.log("\n>>> ALL SECURITY HARDENING TESTS PASSED! <<<\n");
}

runHardeningTests().catch((err) => {
  console.error("Hardening test failed:", err);
  process.exit(1);
});