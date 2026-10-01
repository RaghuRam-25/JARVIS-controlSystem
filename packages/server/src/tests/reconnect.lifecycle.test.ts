import assert from "assert";
import { pairingManager } from "../services/pairingManager.js";
import { CONFIG } from "../config.js";

async function runReconnectLifecycleTests() {
  console.log("\n=======================================================");
  console.log("  JARVIS PAIRING CHALLENGE RECONNECT & LIFECYCLE TESTS ");
  console.log("=======================================================\n");

  // -------------------------------------------------------------------------
  // TEST 1: First pairing flow (Generate QR A -> Scan QR A -> Host Approve -> Connect)
  // -------------------------------------------------------------------------
  console.log("[TEST 1] First Pairing Flow (QR A)...");
  const challengeA = pairingManager.createChallenge();
  assert.ok(challengeA.challengeId, "Challenge A must have a unique challengeId");
  assert.ok(challengeA.nonce, "Challenge A must have a nonce");

  const requestAPromise = pairingManager.requestPairing({
    challengeId: challengeA.challengeId,
    nonce: challengeA.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.101", "socket-android-01");

  const pendingA = pairingManager.getPendingApprovals();
  assert.strictEqual(pendingA.length, 1, "There should be 1 pending approval for QR A");
  assert.strictEqual(pendingA[0].challengeId, challengeA.challengeId, "Pending approval must match Challenge A ID");

  const decisionA = await pairingManager.handleHostDecision(pendingA[0].requestId, "approve", "host-socket-01");
  assert.strictEqual(decisionA.success, true, "Host approval for QR A must succeed");
  assert.ok(decisionA.session?.token, "Session token A must be issued");

  const sessionTokenA = decisionA.session!.token;
  const sessionIdA = decisionA.session!.sessionId;
  const validatedA = await pairingManager.validateToken(sessionTokenA);
  assert.ok(validatedA, "Session A must be valid");
  assert.strictEqual(validatedA.sessionId, sessionIdA);

  const tokenDeliveredA = pairingManager.consumeTokenForRequest(pendingA[0].requestId);
  assert.strictEqual(tokenDeliveredA, sessionTokenA, "Token delivered to waiting socket");
  console.log("  -> [TEST 1 PASSED] Controller 1 successfully paired and session token A issued.");

  // -------------------------------------------------------------------------
  // TEST 2: Disconnect -> Generate QR B -> Scan QR B -> Approve -> Connect again
  // -------------------------------------------------------------------------
  console.log("\n[TEST 2] Disconnect & Reconnect Flow (QR B)...");
  // Android disconnects
  const revokedA = pairingManager.revokeSession(sessionIdA, "Controller disconnected");
  assert.strictEqual(revokedA, true, "Session A successfully revoked on disconnect");
  assert.strictEqual(await pairingManager.validateToken(sessionTokenA), null, "Old session token A must now be invalid");

  // Host generates QR B
  const challengeB = pairingManager.createChallenge();
  assert.notStrictEqual(challengeB.challengeId, challengeA.challengeId, "Challenge B must have a NEW unique ID");
  assert.notStrictEqual(challengeB.nonce, challengeA.nonce, "Challenge B must have a NEW nonce");

  // Android scans QR B
  const requestBPromise = pairingManager.requestPairing({
    challengeId: challengeB.challengeId,
    nonce: challengeB.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.102", "socket-android-02");

  const pendingB = pairingManager.getPendingApprovals();
  assert.strictEqual(pendingB.length, 1, "There should be 1 pending approval for QR B");
  assert.strictEqual(pendingB[0].challengeId, challengeB.challengeId, "Pending approval must match Challenge B ID");

  const decisionB = await pairingManager.handleHostDecision(pendingB[0].requestId, "approve", "host-socket-01");
  assert.strictEqual(decisionB.success, true, "Host approval for QR B must succeed");
  assert.ok(decisionB.session?.token, "Session token B must be issued");

  const sessionTokenB = decisionB.session!.token;
  const sessionIdB = decisionB.session!.sessionId;
  assert.notStrictEqual(sessionTokenB, sessionTokenA, "Session token B must be different from token A");
  assert.notStrictEqual(sessionIdB, sessionIdA, "Session ID B must be different from Session ID A");

  const validatedB = await pairingManager.validateToken(sessionTokenB);
  assert.ok(validatedB, "Session B must be valid");
  assert.strictEqual(validatedB.sessionId, sessionIdB);
  console.log("  -> [TEST 2 PASSED] Reconnect succeeded with completely fresh challenge B and session B.");

  // -------------------------------------------------------------------------
  // TEST 3: Disconnect again -> Generate QR C -> Scan QR C -> Approve -> Connect
  // -------------------------------------------------------------------------
  console.log("\n[TEST 3] Second Reconnect Cycle (QR C)...");
  pairingManager.revokeSession(sessionIdB, "Controller disconnected again");
  assert.strictEqual(await pairingManager.validateToken(sessionTokenB), null, "Session token B is now invalid");

  const challengeC = pairingManager.createChallenge();
  assert.notStrictEqual(challengeC.challengeId, challengeB.challengeId);

  const requestCPromise = pairingManager.requestPairing({
    challengeId: challengeC.challengeId,
    nonce: challengeC.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.103", "socket-android-03");

  const pendingC = pairingManager.getPendingApprovals();
  assert.strictEqual(pendingC.length, 1);
  const decisionC = await pairingManager.handleHostDecision(pendingC[0].requestId, "approve", "host-socket-01");
  assert.strictEqual(decisionC.success, true);
  const sessionTokenC = decisionC.session!.token;
  assert.ok(await pairingManager.validateToken(sessionTokenC));
  console.log("  -> [TEST 3 PASSED] Second reconnect cycle works seamlessly.");

  // -------------------------------------------------------------------------
  // TEST 4: Prevent duplicate submission / Idempotent handling for same QR
  // -------------------------------------------------------------------------
  console.log("\n[TEST 4] Scan SAME QR twice concurrently (Double-scan / retry handling)...");
  const challengeD = pairingManager.createChallenge();

  // First submission of Challenge D
  const submitD1 = pairingManager.submitPairing({
    challengeId: challengeD.challengeId,
    nonce: challengeD.nonce,
    clientName: "Pixel 8 Pro (Frame 1)",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.104", "socket-android-04a");
  assert.ok(!submitD1.immediate, "First submission must not fail immediately");
  assert.ok(submitD1.requestId, "First submission creates requestId");

  // Second duplicate submission of the SAME Challenge D (e.g. successive camera frames before lock)
  const submitD2 = pairingManager.submitPairing({
    challengeId: challengeD.challengeId,
    nonce: challengeD.nonce,
    clientName: "Pixel 8 Pro (Frame 2)",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.104", "socket-android-04b");

  assert.ok(!submitD2.immediate, "Duplicate submission of pending challenge must not throw 'already consumed'");
  assert.strictEqual(submitD2.requestId, submitD1.requestId, "Duplicate submission attaches to the same pending request");

  const pendingD = pairingManager.getPendingApprovals().filter((p) => p.challengeId === challengeD.challengeId);
  assert.strictEqual(pendingD.length, 1, "There must be exactly 1 pending approval, no duplicate approval created");

  const decisionD = await pairingManager.handleHostDecision(submitD1.requestId!, "approve");
  assert.strictEqual(decisionD.success, true);

  // Third submission AFTER approval (now consumed)
  const submitD3 = pairingManager.submitPairing({
    challengeId: challengeD.challengeId,
    nonce: challengeD.nonce,
    clientName: "Pixel 8 Pro (Late Frame)",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.104", "socket-android-04c");
  assert.strictEqual(submitD3.immediate?.status, "expired", "Once consumed, challenge is rejected");
  console.log("  -> [TEST 4 PASSED] Double submission safely handled without premature challenge destruction.");

  // -------------------------------------------------------------------------
  // TEST 5: QR TTL Expiration (> 60s) -> Scan old QR -> Expired -> Generate NEW QR -> Works
  // -------------------------------------------------------------------------
  console.log("\n[TEST 5] QR TTL Expiration & Subsequent New Challenge...");
  const challengeE = pairingManager.createChallenge();
  // Artificially simulate TTL expiration
  const managedE = (pairingManager as any).activeChallenges.get(challengeE.challengeId);
  managedE.expiresAt = Date.now() - 5000;

  const submitE = pairingManager.submitPairing({
    challengeId: challengeE.challengeId,
    nonce: challengeE.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.105");

  assert.strictEqual(submitE.immediate?.status, "expired", "Expired challenge must be rejected with expired status");
  assert.ok(submitE.immediate?.message.includes("expired"), "Error message must state QR has expired");

  // Host generates NEW QR
  const challengeF = pairingManager.createChallenge();
  const submitF = pairingManager.submitPairing({
    challengeId: challengeF.challengeId,
    nonce: challengeF.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.105");

  assert.ok(!submitF.immediate, "Fresh challenge F must succeed");
  const decisionF = await pairingManager.handleHostDecision(submitF.requestId!, "approve");
  assert.strictEqual(decisionF.success, true);
  console.log("  -> [TEST 5 PASSED] Expired challenge rejected cleanly, new challenge immediately succeeds.");

  // -------------------------------------------------------------------------
  // TEST 6: Scan QR -> Cancel Request -> Generate NEW QR -> Scan NEW QR -> Works
  // -------------------------------------------------------------------------
  console.log("\n[TEST 6] Cancel Request flow...");
  const challengeG = pairingManager.createChallenge();
  const submitG = pairingManager.submitPairing({
    challengeId: challengeG.challengeId,
    nonce: challengeG.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.106");

  assert.ok(submitG.requestId);
  assert.strictEqual(pairingManager.getPendingApprovals().filter(p => p.requestId === submitG.requestId).length, 1);

  // Controller presses "Cancel Request"
  const cancelSuccess = pairingManager.cancelPairing(submitG.requestId!);
  assert.strictEqual(cancelSuccess, true, "Pairing request must cancel cleanly");
  assert.strictEqual(pairingManager.getPendingApprovals().filter(p => p.requestId === submitG.requestId).length, 0, "Pending approval removed on cancel");

  // Old challenge G is now cancelled
  const submitG_Retry = pairingManager.submitPairing({
    challengeId: challengeG.challengeId,
    nonce: challengeG.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.106");
  assert.strictEqual(submitG_Retry.immediate?.status, "expired", "Cancelled challenge cannot be reused");

  // Host generates NEW QR H
  const challengeH = pairingManager.createChallenge();
  const submitH = pairingManager.submitPairing({
    challengeId: challengeH.challengeId,
    nonce: challengeH.nonce,
    clientName: "Pixel 8 Pro",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.106");
  assert.ok(!submitH.immediate, "New QR H after cancellation must succeed");
  const decisionH = await pairingManager.handleHostDecision(submitH.requestId!, "approve");
  assert.strictEqual(decisionH.success, true);
  console.log("  -> [TEST 6 PASSED] Cancel request cleans state and allows subsequent pairing immediately.");

  // -------------------------------------------------------------------------
  // TEST 7: Disconnect controller -> Generate new QR -> Same device gets NEW token
  // -------------------------------------------------------------------------
  console.log("\n[TEST 7] Disconnect & Re-pair with same physical device fingerprint...");
  const oldSessionToken = decisionH.session!.token;
  pairingManager.revokeSession(decisionH.session!.sessionId, "Device disconnected");

  const challengeI = pairingManager.createChallenge();
  const submitI = pairingManager.submitPairing({
    challengeId: challengeI.challengeId,
    nonce: challengeI.nonce,
    clientName: "Pixel 8 Pro (Same Device)",
    clientFingerprint: "fingerprint-pixel-8-pro-001",
    deviceType: "phone",
  }, "192.168.1.107");

  const decisionI = await pairingManager.handleHostDecision(submitI.requestId!, "approve");
  assert.strictEqual(decisionI.success, true);
  assert.notStrictEqual(decisionI.session?.token, oldSessionToken, "New session token must be generated");
  assert.ok(await pairingManager.validateToken(decisionI.session?.token));
  console.log("  -> [TEST 7 PASSED] Re-pairing same device generates fresh token and session.");

  console.log("\n>>> ALL 7 RECONNECT & LIFECYCLE TESTS PASSED PERFECTLY! <<<\n");
}

runReconnectLifecycleTests().catch((err) => {
  console.error("Reconnect lifecycle test failed:", err);
  process.exit(1);
});
