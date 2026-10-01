/**
 * hostAgentBridge.ts
 *
 * Runs ONLY on the Windows Host Agent (when IS_HOST_AGENT=true).
 * Establishes an outbound authenticated Socket.IO connection to the Railway
 * Server, then listens for forwarded control events and executes them locally
 * using Windows-only automation services.
 *
 * Flow:
 *   Controller → Railway Server → (this bridge) → inputAutomation / terminalManager / automationExecutor
 *
 * IMPORTANT: This module must NOT be imported on the Railway server itself.
 * Server-side code (socketHandler.ts) only relays events; it never calls
 * inputAutomation or terminalManager directly.
 */

import { io as ioClient, Socket } from "socket.io-client";
import {
  MouseMoveSchema,
  MouseClickSchema,
  MouseButtonActionSchema,
  MouseScrollSchema,
  KeyboardKeySchema,
  KeyboardTypeSchema,
  TerminalSpawnSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  VoiceExecutionRequestSchema,
} from "@jarvis/shared";
import { inputAutomation } from "./inputAutomation.js";
import { terminalManager } from "./terminalManager.js";
import { automationExecutor } from "./automationExecutor.js";
import { voiceEngine } from "./voiceEngine.js";
import { getHostCredential } from "./hostAuth.js";
import { CONFIG } from "../config.js";

let bridgeSocket: Socket | null = null;
let reconnectCount = 0;

/**
 * Starts the outbound connection from the Windows Host Agent to Railway.
 * Called once from server.ts when IS_HOST_AGENT=true and JARVIS_SERVER_URL is set.
 */
export function startHostAgentBridge(railwayServerUrl: string): void {
  if (bridgeSocket) {
    console.warn("[JARVIS HOST] Bridge already running — skipping duplicate start.");
    return;
  }

  const hostCredential = getHostCredential();

  console.log(`[JARVIS HOST] Connecting to Railway Server: ${railwayServerUrl}`);

  bridgeSocket = ioClient(railwayServerUrl, {
    auth: {
      isHost: true,
      hostCredential,
    },
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 20000,
  });

  const socket = bridgeSocket;

  // ─── Connection Lifecycle ─────────────────────────────────────────────────

  socket.on("connect", () => {
    reconnectCount = 0;
    console.log(`[JARVIS HOST] Connected to Railway Server (socket: ${socket.id})`);
    console.log("[JARVIS HOST] Host authenticated");
    console.log("[JARVIS HOST] Registered successfully");

    // Notify Railway of screen metrics so controllers can use correct scaling
    const metrics = inputAutomation.getMetrics();
    socket.emit("host:screen_metrics", metrics);
  });

  socket.on("disconnect", (reason) => {
    reconnectCount += 1;
    console.log(`[JARVIS HOST] Disconnected (reason: ${reason}, attempt #${reconnectCount})`);
    console.log("[JARVIS HOST] Reconnecting...");
  });

  socket.on("connect_error", (err) => {
    console.warn(`[JARVIS HOST] Connection error: ${err.message}`);
  });

  socket.on("auth:error", ({ message }: { message: string }) => {
    console.error(`[JARVIS HOST] Authentication failed: ${message}`);
    console.error("[JARVIS HOST] Check that JARVIS_SECRET matches the Railway Server JARVIS_SECRET.");
  });

  // ─── Mouse Control ────────────────────────────────────────────────────────

  socket.on("host:control:mouse_move", (data: unknown) => {
    const parsed = MouseMoveSchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] mouse_move executed");
    inputAutomation.handleMouseMove(parsed.data);
  });

  socket.on("host:control:mouse_click", (data: unknown) => {
    const parsed = MouseClickSchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] mouse_click executed");
    inputAutomation.handleMouseClick(parsed.data);
  });

  socket.on("host:control:mouse_button", (data: unknown) => {
    const parsed = MouseButtonActionSchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] mouse_button executed");
    inputAutomation.handleMouseButtonAction(parsed.data);
  });

  socket.on("host:control:mouse_scroll", (data: unknown) => {
    const parsed = MouseScrollSchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] mouse_scroll executed");
    inputAutomation.handleMouseScroll(parsed.data);
  });

  // ─── Keyboard Control ─────────────────────────────────────────────────────

  socket.on("host:control:key", (data: unknown) => {
    const parsed = KeyboardKeySchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] key executed");
    inputAutomation.handleKeyboardKey(parsed.data);
  });

  socket.on("host:control:type", (data: unknown) => {
    const parsed = KeyboardTypeSchema.safeParse(data);
    if (!parsed.success) return;
    console.log("[JARVIS WINDOWS] type executed");
    inputAutomation.handleKeyboardType(parsed.data);
  });

  // ─── Terminal (Windows PTY) ───────────────────────────────────────────────

  socket.on("host:terminal:spawn", (data: unknown) => {
    const parsed = TerminalSpawnSchema.safeParse(data || {});
    if (!parsed.success) return;

    const inst = terminalManager.createSession(parsed.data, socket.id);
    socket.emit("host:terminal:ready", {
      sessionId: inst.sessionId,
      cols: inst.cols,
      rows: inst.rows,
    });
    console.log(`[JARVIS WINDOWS] terminal spawned: ${inst.sessionId}`);
  });

  socket.on("host:terminal:input", (data: unknown) => {
    const parsed = TerminalInputSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.write(parsed.data.sessionId, parsed.data.data, socket.id);
  });

  socket.on("host:terminal:resize", (data: unknown) => {
    const parsed = TerminalResizeSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.resize(parsed.data, socket.id);
  });

  socket.on("host:terminal:kill", (data: unknown) => {
    const parsed = TerminalKillSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.kill(parsed.data.sessionId, socket.id);
    console.log(`[JARVIS WINDOWS] terminal killed: ${parsed.data.sessionId}`);
  });

  // ─── Voice Execution ──────────────────────────────────────────────────────

  socket.on("host:voice:execute", async (payload: unknown) => {
    const parsed = VoiceExecutionRequestSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.approved) return;

    const intent = voiceEngine.parseTranscript(
      (payload as any).rawTranscript || "",
      (payload as any).language
    );
    if (parsed.data.modifiedPayload) {
      intent.payload = { ...intent.payload, ...parsed.data.modifiedPayload };
    }

    const result = await automationExecutor.executeIntent(intent);
    console.log(`[JARVIS WINDOWS] voice executed: ${intent.type} → ${result.success ? "OK" : "FAIL"}`);
    socket.emit("host:voice:result", { intent, result });
  });

  // ─── Screen Metrics Request ───────────────────────────────────────────────

  socket.on("host:request_screen_metrics", () => {
    const metrics = inputAutomation.getMetrics();
    socket.emit("host:screen_metrics", metrics);
  });

  console.log("[JARVIS HOST] Host Agent Bridge event handlers registered");
}

// Pipe terminal output back to Railway → Controller (registered once at module level)
terminalManager.on("data", ({ sessionId, data }: { sessionId: string; data: string }) => {
  if (bridgeSocket?.connected) {
    bridgeSocket.emit("host:terminal:data", { sessionId, data });
  }
});

terminalManager.on("exit", ({ sessionId, code, signal }: { sessionId: string; code: number | null; signal: string | null }) => {
  if (bridgeSocket?.connected) {
    bridgeSocket.emit("host:terminal:exit", { sessionId, code, signal });
  }
});

/**
 * Gracefully shuts down the bridge connection.
 * Called on process exit.
 */
export function stopHostAgentBridge(): void {
  if (bridgeSocket) {
    bridgeSocket.removeAllListeners();
    bridgeSocket.disconnect();
    bridgeSocket = null;
    console.log("[JARVIS HOST] Bridge disconnected");
  }
}
