import assert from "assert";
import { pairingManager } from "../services/pairingManager.js";
import { inputAutomation } from "../services/inputAutomation.js";
import { terminalManager } from "../services/terminalManager.js";
import { automationExecutor } from "../services/automationExecutor.js";
import { voiceEngine } from "../services/voiceEngine.js";

async function runE2ETests() {
  console.log("\n=== [E2E FLOW TEST SUITE: JARVIS V1] ===");

  // Step 1: Host creates one-time challenge
  console.log("Step 1: Host generates pairing QR challenge...");
  const challenge = pairingManager.createChallenge();
  assert.ok(challenge.challengeId, "Challenge ID generated");
  assert.ok(challenge.nonce, "Nonce generated");

  // Step 2: Controller sends pairing request
  console.log("Step 2: Mobile controller scans QR and requests pairing...");
  const pairRequestPromise = pairingManager.requestPairing({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    clientName: "Pixel 8 Pro (Android 14)",
    clientFingerprint: "fp-android-pixel8pro-998877",
    deviceType: "phone",
  }, "192.168.1.150");

  // Step 3: Host reviews pending requests & approves
  console.log("Step 3: Host receives pending approval event and approves...");
  const pending = pairingManager.getPendingApprovals();
  assert.strictEqual(pending.length, 1, "There should be 1 pending approval");
  assert.strictEqual(pending[0].clientName, "Pixel 8 Pro (Android 14)");

  const approvalResult = await pairingManager.handleHostDecision(pending[0].requestId, "approve");
  assert.strictEqual(approvalResult.success, true, "Host approved pairing");
  assert.ok(approvalResult.session?.token, "Token issued to mobile client");

  const sessionToken = approvalResult.session!.token;

  // Step 4: Verify mobile controller authentication
  console.log("Step 4: Authenticating mobile session with signed token...");
  const validatedSession = await pairingManager.validateToken(sessionToken);
  assert.ok(validatedSession, "Session successfully validated");
  assert.strictEqual(validatedSession.clientName, "Pixel 8 Pro (Android 14)");

  // Step 5: Screen metrics & Coordinate scaling
  console.log("Step 5: Testing display metrics and normalized coordinate scaling...");
  const metrics = inputAutomation.getMetrics();
  assert.ok(metrics.width > 0 && metrics.height > 0, "Display metrics detected");
  // Test sending scaled mouse movements
  inputAutomation.handleMouseMove({ normalizedX: 0.5, normalizedY: 0.5 });
  inputAutomation.handleMouseScroll({ deltaX: 0, deltaY: 2 });

  // Step 6: Interactive Windows PTY Terminal spawn & execution
  console.log("Step 6: Testing interactive Windows terminal session...");
  const term = terminalManager.createSession({ shell: "powershell.exe", cols: 80, rows: 24 });
  assert.ok(term.sessionId, "Terminal spawned with session ID");
  const writeSuccess = terminalManager.write(term.sessionId, "echo 'JARVIS_TERMINAL_READY'\r\n");
  assert.strictEqual(writeSuccess, true, "Wrote input to terminal stdin");
  terminalManager.kill(term.sessionId);

  // Step 7: Voice Intent & Automation execution
  console.log("Step 7: Testing Voice Automation Pipeline (Open YouTube)...");
  const intent = voiceEngine.parseTranscript("open youtube and search chill coding music");
  assert.strictEqual(intent.type, "BROWSER_YOUTUBE");
  assert.strictEqual(intent.requiresExplicitApproval, false);
  // Note: Automation executor handles URL generation
  assert.ok(intent.payload.url.includes("youtube.com"));

  // Step 8: Disconnect & Emergency Revoke All
  console.log("Step 8: Testing Host Emergency Revoke All...");
  pairingManager.revokeAllSessions("Host Emergency Disconnect");
  const postRevokeValidation = await pairingManager.validateToken(sessionToken);
  assert.strictEqual(postRevokeValidation, null, "All sessions must be invalidated immediately");

  inputAutomation.cleanup();

  console.log("\n>>> ALL E2E LIFECYCLE TESTS COMPLETED SUCCESSFULLY! <<<\n");
  process.exit(0);
}

runE2ETests().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
