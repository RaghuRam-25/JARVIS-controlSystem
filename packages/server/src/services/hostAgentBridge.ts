/**
 * hostAgentBridge.ts
 *
 * Runs ONLY on the Windows Host Agent (when IS_HOST_AGENT=true).
 * Establishes an outbound authenticated Socket.IO connection to the Railway
 * Server, then listens for forwarded control events and executes them locally
 * using Windows-only automation services (User32.dll, PowerShell, SendInput).
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
      isHostAgent: true,
      role: "host-agent",
      hostCredential,
    },
    query: {
      isHost: "true",
      isHostAgent: "true",
      role: "host-agent",
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
    socket.emit("screen:metrics", metrics);
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

  // ─── Mouse Control Handlers ───────────────────────────────────────────────

  const handleMouseMove = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:mouse_move");
    const parsed = MouseMoveSchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid mouse_move payload:", parsed.error.issues);
      return;
    }
    inputAutomation.handleMouseMove(parsed.data);
  };

  const handleMouseClick = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:mouse_click");
    const parsed = MouseClickSchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid mouse_click payload:", parsed.error.issues);
      return;
    }
    console.log("[JARVIS HOST] Executing Windows mouse click");
    inputAutomation.handleMouseClick(parsed.data);
  };

  const handleMouseButton = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:mouse_button");
    const parsed = MouseButtonActionSchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid mouse_button payload:", parsed.error.issues);
      return;
    }
    console.log(`[JARVIS HOST] Executing Windows mouse button (${parsed.data.action} ${parsed.data.button})`);
    inputAutomation.handleMouseButtonAction(parsed.data);
  };

  const handleMouseScroll = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:mouse_scroll");
    const parsed = MouseScrollSchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid mouse_scroll payload:", parsed.error.issues);
      return;
    }
    console.log("[JARVIS HOST] Executing Windows mouse scroll");
    inputAutomation.handleMouseScroll(parsed.data);
  };

  socket.on("control:mouse_move", handleMouseMove);
  socket.on("host:control:mouse_move", handleMouseMove);

  socket.on("control:mouse_click", handleMouseClick);
  socket.on("host:control:mouse_click", handleMouseClick);

  socket.on("control:mouse_button", handleMouseButton);
  socket.on("host:control:mouse_button", handleMouseButton);

  socket.on("control:mouse_scroll", handleMouseScroll);
  socket.on("host:control:mouse_scroll", handleMouseScroll);

  // ─── Keyboard Control Handlers ────────────────────────────────────────────

  const handleKey = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:key");
    const parsed = KeyboardKeySchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid key payload:", parsed.error.issues);
      return;
    }
    console.log(`[JARVIS HOST] Executing Windows key (${parsed.data.key})`);
    inputAutomation.handleKeyboardKey(parsed.data);
  };

  const handleType = (data: unknown) => {
    console.log("[JARVIS HOST] CONTROL RECEIVED: control:type");
    const parsed = KeyboardTypeSchema.safeParse(data);
    if (!parsed.success) {
      console.warn("[JARVIS HOST] Invalid type payload:", parsed.error.issues);
      return;
    }
    console.log("[JARVIS HOST] Executing Windows type text");
    inputAutomation.handleKeyboardType(parsed.data);
  };

  socket.on("control:key", handleKey);
  socket.on("host:control:key", handleKey);

  socket.on("control:type", handleType);
  socket.on("host:control:type", handleType);

  // ─── Terminal (Windows PTY) ───────────────────────────────────────────────

  const handleTerminalSpawn = (data: unknown) => {
    const parsed = TerminalSpawnSchema.safeParse(data || {});
    if (!parsed.success) return;

    const inst = terminalManager.createSession(parsed.data, socket.id);
    socket.emit("host:terminal:ready", {
      sessionId: inst.sessionId,
      cols: inst.cols,
      rows: inst.rows,
    });
    socket.emit("terminal:ready", {
      sessionId: inst.sessionId,
      cols: inst.cols,
      rows: inst.rows,
    });
    console.log(`[JARVIS WINDOWS] terminal spawned: ${inst.sessionId}`);
  };

  const handleTerminalInput = (data: unknown) => {
    const parsed = TerminalInputSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.write(parsed.data.sessionId, parsed.data.data, socket.id);
  };

  const handleTerminalResize = (data: unknown) => {
    const parsed = TerminalResizeSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.resize(parsed.data, socket.id);
  };

  const handleTerminalKill = (data: unknown) => {
    const parsed = TerminalKillSchema.safeParse(data);
    if (!parsed.success) return;
    terminalManager.kill(parsed.data.sessionId, socket.id);
    console.log(`[JARVIS WINDOWS] terminal killed: ${parsed.data.sessionId}`);
  };

  socket.on("terminal:spawn", handleTerminalSpawn);
  socket.on("host:terminal:spawn", handleTerminalSpawn);

  socket.on("terminal:input", handleTerminalInput);
  socket.on("host:terminal:input", handleTerminalInput);

  socket.on("terminal:resize", handleTerminalResize);
  socket.on("host:terminal:resize", handleTerminalResize);

  socket.on("terminal:kill", handleTerminalKill);
  socket.on("host:terminal:kill", handleTerminalKill);

  // ─── Voice Execution ──────────────────────────────────────────────────────

  const handleVoiceExecute = async (payload: unknown) => {
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
    socket.emit("voice:result", result);
  };

  socket.on("voice:execute", handleVoiceExecute);
  socket.on("host:voice:execute", handleVoiceExecute);

  // ─── Screen Metrics Request ───────────────────────────────────────────────

  const handleMetricsRequest = () => {
    const metrics = inputAutomation.getMetrics();
    socket.emit("host:screen_metrics", metrics);
    socket.emit("screen:metrics", metrics);
  };

  socket.on("host:request_screen_metrics", handleMetricsRequest);
  socket.on("request_screen_metrics", handleMetricsRequest);

  console.log("[JARVIS HOST] Host Agent Bridge event handlers registered");
}

// Pipe terminal output back to Railway → Controller (registered once at module level)
terminalManager.on("data", ({ sessionId, data }: { sessionId: string; data: string }) => {
  if (bridgeSocket?.connected) {
    bridgeSocket.emit("host:terminal:data", { sessionId, data });
    bridgeSocket.emit("terminal:data", { sessionId, data });
  }
});

terminalManager.on("exit", ({ sessionId, code, signal }: { sessionId: string; code: number | null; signal: string | null }) => {
  if (bridgeSocket?.connected) {
    bridgeSocket.emit("host:terminal:exit", { sessionId, code, signal });
    bridgeSocket.emit("terminal:exit", { sessionId, code, signal });
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
