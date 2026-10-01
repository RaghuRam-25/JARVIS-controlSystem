import assert from "assert";
import { voiceEngine, updateVoiceContext, clearVoiceContext } from "../services/voiceEngine.js";

async function runVoiceTests() {
  console.log("\n=======================================================");
  console.log("  JARVIS INTELLIGENT MULTI-STEP VOICE COMMAND TESTS");
  console.log("=======================================================\n");

  clearVoiceContext();

  // Test 1: "Chrome খুলে দাও"
  console.log('[TEST 1] "Chrome খুলে দাও" -> Chrome opens/focuses');
  const t1 = voiceEngine.parseTranscript("Chrome খুলে দাও");
  assert.ok(["OPEN_APP", "MULTI_STEP_PLAN"].includes(t1.type), `Expected OPEN_APP/MULTI_STEP_PLAN, got ${t1.type}`);
  assert.strictEqual(t1.payload.steps[0].target, "chrome");
  assert.strictEqual(t1.payload.steps[0].action, "open_or_focus");
  console.log("  -> [TEST 1 PASSED] Chrome open intent parsed properly.\n");

  // Test 2: "Chrome খুলে YouTube এ যাও"
  console.log('[TEST 2] "Chrome খুলে YouTube এ যাও" -> Chrome opens -> YouTube opens');
  const t2 = voiceEngine.parseTranscript("Chrome খুলে YouTube এ যাও");
  assert.strictEqual(t2.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t2.payload.steps.length, 2);
  assert.strictEqual(t2.payload.steps[0].action, "open_or_focus");
  assert.strictEqual(t2.payload.steps[0].target, "chrome");
  assert.strictEqual(t2.payload.steps[1].action, "open_url");
  assert.ok(t2.payload.steps[1].url.includes("youtube.com"));
  console.log("  -> [TEST 2 PASSED] 2-step plan: Chrome -> YouTube.\n");

  // Test 3: "Chrome খুলে YouTube এ গিয়ে Python tutorial search করো"
  console.log('[TEST 3] "Chrome খুলে YouTube এ গিয়ে Python tutorial search করো"');
  const t3 = voiceEngine.parseTranscript("Chrome খুলে YouTube এ গিয়ে Python tutorial search করো");
  assert.strictEqual(t3.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t3.payload.steps.length, 3);
  assert.strictEqual(t3.payload.steps[0].action, "open_or_focus");
  assert.strictEqual(t3.payload.steps[0].target, "chrome");
  assert.strictEqual(t3.payload.steps[1].action, "open_url");
  assert.ok(t3.payload.steps[1].url.includes("youtube.com"));
  assert.strictEqual(t3.payload.steps[2].action, "search");
  assert.ok(t3.payload.steps[2].query.toLowerCase().includes("python tutorial"));
  console.log("  -> [TEST 3 PASSED] 3-step plan: Chrome -> YouTube -> Search Python tutorial.\n");

  // Test 4: "Chrome খুলে Google এ গিয়ে JARVIS V1 search করো"
  console.log('[TEST 4] "Chrome খুলে Google এ গিয়ে JARVIS V1 search করো"');
  const t4 = voiceEngine.parseTranscript("Chrome খুলে Google এ গিয়ে JARVIS V1 search করো");
  assert.strictEqual(t4.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t4.payload.steps.length, 3);
  assert.strictEqual(t4.payload.steps[0].action, "open_or_focus");
  assert.strictEqual(t4.payload.steps[1].action, "open_url");
  assert.ok(t4.payload.steps[1].url.includes("google.com"));
  assert.strictEqual(t4.payload.steps[2].action, "search");
  assert.ok(t4.payload.steps[2].query.toLowerCase().includes("jarvis v1"));
  console.log("  -> [TEST 4 PASSED] 3-step plan: Chrome -> Google -> Search JARVIS V1.\n");

  // Test 5: "ক্রোমটা খুলে ইউটিউবে যাও"
  console.log('[TEST 5] "ক্রোমটা খুলে ইউটিউবে যাও" (Bengali inflections)');
  const t5 = voiceEngine.parseTranscript("ক্রোমটা খুলে ইউটিউবে যাও");
  assert.strictEqual(t5.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t5.payload.steps[0].target, "chrome");
  assert.strictEqual(t5.payload.steps[1].action, "open_url");
  assert.ok(t5.payload.steps[1].url.includes("youtube.com"));
  console.log("  -> [TEST 5 PASSED] Bengali inflected intent parsed.\n");

  // Test 6: "ক্রোম ওপেন করে ইউটিউব চালু করো"
  console.log('[TEST 6] "ক্রোম ওপেন করে ইউটিউব চালু করো"');
  const t6 = voiceEngine.parseTranscript("ক্রোম ওপেন করে ইউটিউব চালু করো");
  assert.strictEqual(t6.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t6.payload.steps[0].target, "chrome");
  assert.strictEqual(t6.payload.steps[1].action, "open_url");
  assert.ok(t6.payload.steps[1].url.includes("youtube.com"));
  console.log("  -> [TEST 6 PASSED] Alternative phrasing matches intent.\n");

  // Test 7: "Chrome খোলো, তারপর YouTube এ গিয়ে AI search করো"
  console.log('[TEST 7] "Chrome খোলো, তারপর YouTube এ গিয়ে AI search করো"');
  const t7 = voiceEngine.parseTranscript("Chrome খোলো, তারপর YouTube এ গিয়ে AI search করো");
  assert.strictEqual(t7.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t7.payload.steps[0].target, "chrome");
  assert.strictEqual(t7.payload.steps[1].action, "open_url");
  assert.strictEqual(t7.payload.steps[2].action, "search");
  assert.ok(t7.payload.steps[2].query.toLowerCase().includes("ai"));
  console.log("  -> [TEST 7 PASSED] Comma-separated complex sentence parsed.\n");

  // Test 8: Context Awareness - "এখন YouTube এ যাও" (after Chrome is already open)
  console.log('[TEST 8] Context follow-up: "এখন YouTube এ যাও"');
  updateVoiceContext({ currentApplication: "chrome", lastAction: "open_or_focus", lastTarget: "chrome" });
  const t8 = voiceEngine.parseTranscript("এখন YouTube এ যাও");
  assert.strictEqual(t8.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t8.payload.steps[0].action, "open_or_focus");
  assert.strictEqual(t8.payload.steps[0].target, "chrome");
  assert.strictEqual(t8.payload.steps[1].action, "open_url");
  assert.ok(t8.payload.steps[1].url.includes("youtube.com"));
  console.log("  -> [TEST 8 PASSED] Correctly used active Chrome context.\n");

  // Test 9: Context Awareness - "এখানে Python search করো" (after YouTube is open)
  console.log('[TEST 9] Context follow-up: "এখানে Python search করো"');
  updateVoiceContext({ currentApplication: "chrome", currentUrl: "https://www.youtube.com", lastAction: "open_url" });
  const t9 = voiceEngine.parseTranscript("এখানে Python search করো");
  assert.strictEqual(t9.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t9.payload.steps[0].action, "open_or_focus");
  const searchStep = t9.payload.steps.find((s: any) => s.action === "search");
  assert.ok(searchStep, "Must have search step");
  assert.ok(searchStep.url.includes("youtube.com/results?search_query=python") || searchStep.query.toLowerCase().includes("python"));
  console.log("  -> [TEST 9 PASSED] Correctly searched within active YouTube context.\n");

  // Test 10: Speech with filler words - "ভাই Chrome টা একটু খুলে দাও তারপর YouTube এ নিয়ে যাও"
  console.log('[TEST 10] Filler words: "ভাই Chrome টা একটু খুলে দাও তারপর YouTube এ নিয়ে যাও"');
  clearVoiceContext();
  const t10 = voiceEngine.parseTranscript("ভাই Chrome টা একটু খুলে দাও তারপর YouTube এ নিয়ে যাও");
  assert.strictEqual(t10.type, "MULTI_STEP_PLAN");
  assert.strictEqual(t10.payload.steps[0].target, "chrome");
  assert.strictEqual(t10.payload.steps[1].action, "open_url");
  assert.ok(t10.payload.steps[1].url.includes("youtube.com"));
  console.log("  -> [TEST 10 PASSED] Filler words stripped and intent fully extracted.\n");

  console.log(">>> ALL 10 VOICE INTENT TEST CASES PASSED PERFECTLY! <<<\n");
}

runVoiceTests().catch((err) => {
  console.error("Voice test failed:", err);
  process.exit(1);
});
