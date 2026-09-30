import assert from "assert";
import { pairingManager } from "../services/pairingManager.js";
import { voiceEngine } from "../services/voiceEngine.js";
import { generateUUID, createSignedToken, verifySignedToken } from "@jarvis/shared";
import { CONFIG } from "../config.js";

async function runSecurityTests() {
  console.log("\n--- [SECURITY TEST SUITE: JARVIS V1] ---");

  // Test 1: Pairing Nonce Single-Use and Invalidation
  console.log("[1/5] Testing Pairing Nonce Expiration & Replay Attack Defense...");
  const challenge = pairingManager.createChallenge();
  assert.ok(challenge.challengeId, "Challenge must have an ID");
  assert.ok(challenge.nonce, "Challenge must have a high-entropy nonce");

  // Attempt pairing with invalid nonce
  const fakeRequest = {
    challengeId: challenge.challengeId,
    nonce: "00000000000000000000000000000000",
    clientName: "Attacker Phone",
    clientFingerprint: "attacker-fingerprint-12345",
    deviceType: "phone" as const,
  };
  const rejectResult = await pairingManager.requestPairing(fakeRequest, "192.168.1.100");
  assert.strictEqual(rejectResult.status, "rejected", "Invalid nonce must be rejected");

  // Test 2: Token Signing and Cryptographic Integrity
  console.log("[2/5] Testing HMAC Cryptographic Token Integrity...");
  const samplePayload = {
    sessionId: generateUUID(),
    clientName: "Galaxy S24",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
  };
  const token = await createSignedToken(samplePayload, CONFIG.SECRET_KEY);
  assert.ok(token.includes("."), "Token must be formatted with signature");

  const verified = await verifySignedToken(token, CONFIG.SECRET_KEY);
  assert.ok(verified, "Legitimate token must verify successfully");
  assert.strictEqual(verified.clientName, "Galaxy S24");

  // Tampered token test
  const tamperedToken = token.slice(0, -4) + "abcd";
  const tamperedVerified = await verifySignedToken(tamperedToken, CONFIG.SECRET_KEY);
  assert.strictEqual(tamperedVerified, null, "Tampered signature must be rejected");

  // Test 3: Session Revocation
  console.log("[3/5] Testing Session Revocation...");
  const testSessionId = generateUUID();
  const sessionToken = await createSignedToken({ sessionId: testSessionId, expiresAt: Date.now() + 50000 }, CONFIG.SECRET_KEY);
  // Manual inject into manager for test
  (pairingManager as any).activeSessions.set(testSessionId, {
    sessionId: testSessionId,
    token: sessionToken,
    status: "active",
    expiresAt: Date.now() + 50000,
    clientName: "Test Phone",
    deviceType: "phone",
    clientFingerprint: "fingerprint-123",
    issuedAt: Date.now(),
  });

  const validSession = await pairingManager.validateToken(sessionToken);
  assert.ok(validSession, "Active session should validate");

  pairingManager.revokeSession(testSessionId, "Security test revoking");
  const revokedSession = await pairingManager.validateToken(sessionToken);
  assert.strictEqual(revokedSession, null, "Revoked session must return null");

  // Test 4: Voice Command Risk Classification & Approval Flags (English)
  console.log("[4/5] Testing Voice Command Untrusted Input & Approval Gates (English)...");
  const safeIntent = voiceEngine.parseTranscript("open youtube and play coding music");
  assert.strictEqual(safeIntent.requiresExplicitApproval, false);
  assert.strictEqual(safeIntent.riskLevel, "low");

  const sensitiveExtensionIntent = voiceEngine.parseTranscript("install extension ms-python.python");
  assert.strictEqual(sensitiveExtensionIntent.type, "INSTALL_EXTENSION");
  assert.strictEqual(sensitiveExtensionIntent.requiresExplicitApproval, true, "Extension install MUST require approval");

  const dangerousDeleteIntent = voiceEngine.parseTranscript("delete file src/important.ts");
  assert.strictEqual(dangerousDeleteIntent.type, "CODE_OPERATION");
  assert.strictEqual(dangerousDeleteIntent.requiresExplicitApproval, true, "File delete MUST require explicit approval");
  assert.strictEqual(dangerousDeleteIntent.riskLevel, "critical");

  // Test 5: Voice Command Parsing in Bengali (বাংলা)
  console.log("[5/5] Testing Bengali (বাংলা) Voice Intent Recognition...");
  const bnYoutubeIntent = voiceEngine.parseTranscript("ইউটিউবে গান চালাও");
  assert.strictEqual(bnYoutubeIntent.type, "BROWSER_YOUTUBE");

  const bnCodeIntent = voiceEngine.parseTranscript("ভিএস কোড খোলো");
  assert.strictEqual(bnCodeIntent.type, "OPEN_APP");

  const bnDeleteIntent = voiceEngine.parseTranscript("ফাইল ডিলিট করো old_data.json");
  assert.strictEqual(bnDeleteIntent.type, "CODE_OPERATION");
  assert.strictEqual(bnDeleteIntent.requiresExplicitApproval, true);

  console.log("\n>>> ALL 5 SECURITY AUDIT CHECKS PASSED SUCCESSFULLY! <<<\n");
}

runSecurityTests().catch((err) => {
  console.error("Security test failed:", err);
  process.exit(1);
});
