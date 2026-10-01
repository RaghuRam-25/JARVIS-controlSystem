/**
 * socketHandler.ts
 *
 * Railway-side Socket.IO handler.
 *
 * Architecture:
 *   Controller → Railway (this file) → Windows Host Agent (hostAgentBridge.ts)
 *
 * This file NO LONGER calls inputAutomation, terminalManager, or
 * automationExecutor directly. Those run only inside the Windows Host Agent.
 *
 * Control events are RELAYED to the authenticated Windows Host socket using
 * "host:control:*" events. The Host Agent executes them locally.
 */

import { Server as SocketIOServer, Socket } from "socket.io";
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
  WebRTCSignalSchema,
  VoiceExecutionRequestSchema,
  PairingRequestSchema,
  RevokeSessionSchema,
  AuthSession,
  generateUUID,
} from "@jarvis/shared";
import { pairingManager } from "../services/pairingManager.js";
import { screenStreamManager } from "../services/screenStreamManager.js";
import { voiceEngine } from "../services/voiceEngine.js";
import { verifyHostCredential } from "../services/hostAuth.js";

export function setupSocketHandlers(io: SocketIOServer) {
  // ─── Pairing Manager Events → Broadcast ─────────────────────────────────

  pairingManager.on("pairing_requested", (data) => {
    io.to("host-room").emit("pairing:requested", data);
  });

  pairingManager.on("pairing_approved", (data) => {
    const target = pairingManager.getSocketIdForRequest(data.requestId);
    if (target) {
      io.to(target).emit("pairing:approved", {
        ...data,
        token: pairingManager.consumeTokenForRequest(data.requestId) ?? undefined,
      });
    } else {
      // No known socket to deliver the token to; do not broadcast secrets.
      io.emit("pairing:approved", {
        requestId: data.requestId,
        sessionId: data.sessionId,
        clientName: data.clientName,
        deviceType: data.deviceType,
        clientFingerprint: data.clientFingerprint,
      });
    }
  });

  pairingManager.on("pairing_rejected", (data) => {
    io.emit("pairing:rejected", data);
  });

  pairingManager.on("pairing_cancelled", (data) => {
    io.to("host-room").emit("pairing:cancelled", data);
    io.emit("pairing:cancelled", data);
  });

  pairingManager.on("session_revoked", (data) => {
    io.emit("session:revoked", data);
  });

  pairingManager.on("all_sessions_revoked", (data) => {
    io.emit("session:revoked_all", data);
  });

  // ─── Terminal output relay: Host Agent → Railway → Controller ────────────
  // When the Windows Host Agent sends terminal data back to Railway via its
  // bridge socket, Railway forwards it to the matching controller socket(s).
  // This is handled inline in the host socket's event handlers below.

  // ─── Connection Handler ──────────────────────────────────────────────────

  io.on("connection", async (socket: Socket) => {
    const auth = (socket.handshake.auth || {}) as Record<string, unknown>;
    const query = (socket.handshake.query || {}) as Record<string, unknown>;
    const token = auth.token || query.token;

    // Host role is NEVER self-asserted. It requires a server-issued credential.
    const hostCredential =
      auth.hostCredential ||
      auth.hostKey ||
      query.hostCredential ||
      query.hostKey;
    const isHostCandidate = Boolean(auth.isHost) || query.isHost === "true";
    const isHost = isHostCandidate && verifyHostCredential(hostCredential);

    let session: AuthSession | null = null;

    if (isHost) {
      // ─── Windows Host Agent Registration ──────────────────────────────
      socket.join("host-room");
      screenStreamManager.registerHost(socket.id);
      console.log(`[JARVIS RELAY] Windows Host Agent registered: socket=${socket.id}`);

      // Forward terminal output from Host Agent back to controller sockets
      socket.on("host:terminal:data", ({ sessionId, data }: { sessionId: string; data: string }) => {
        io.to(`term-${sessionId}`).emit("terminal:data", { sessionId, data });
      });

      socket.on("host:terminal:exit", ({ sessionId, code, signal }: { sessionId: string; code: number | null; signal: string | null }) => {
        io.to(`term-${sessionId}`).emit("terminal:exit", { sessionId, code, signal });
      });

      socket.on("host:terminal:ready", (data: { sessionId: string; cols: number; rows: number }) => {
        // Forward to whoever is waiting for terminal ready in term-room
        io.to(`term-${data.sessionId}`).emit("terminal:ready", data);
      });

      // Voice result relay: Host → Railway → Controller
      socket.on("host:voice:result", ({ intent, result }: { intent: any; result: any }) => {
        // Broadcast result to all authenticated controllers
        io.emit("voice:result", result);
        io.to("host-room").emit("voice:executed", { intent, result });
      });

      // Screen metrics: Host advertises actual Windows resolution
      socket.on("host:screen_metrics", (metrics: { width: number; height: number; scaleFactor: number }) => {
        // Broadcast to all controllers so they use correct coordinate scaling
        io.emit("host:screen_metrics", metrics);
      });

      socket.on("disconnect", () => {
        screenStreamManager.unregisterHost(socket.id);
        console.log(`[JARVIS RELAY] Windows Host Agent disconnected: socket=${socket.id}`);
        // Notify all controllers that host went offline
        io.emit("host:status", { online: false });
      });

      // Notify controllers the host came online
      io.emit("host:status", { online: true });

    } else if (token) {
      // ─── Controller Authentication ─────────────────────────────────────
      session = await pairingManager.validateToken(token as string);
      if (!session) {
        socket.emit("auth:error", { message: "Unauthorized: Invalid or expired session token." });
      } else {
        socket.join(`session-${session.sessionId}`);
        screenStreamManager.registerViewer(socket.id);
        socket.emit("auth:success", { session });
      }
    } else {
      // Unauthenticated client awaiting pairing approval
    }

    // Runtime token authentication (allows immediate upgrade without reconnect)
    socket.on("auth:authenticate", async (payload: { token?: string }) => {
      if (!payload?.token) return;
      session = await pairingManager.validateToken(payload.token);
      if (session) {
        socket.join(`session-${session.sessionId}`);
        screenStreamManager.registerViewer(socket.id);
        socket.emit("auth:success", { session });
      } else {
        socket.emit("auth:error", { message: "Unauthorized: Invalid or expired session token." });
      }
    });

    // ─── Pairing Events ───────────────────────────────────────────────────

    socket.on("pairing:request", async (payload) => {
      const parsed = PairingRequestSchema.safeParse(payload);
      if (!parsed.success) return;

      const clientIp =
        (socket.handshake.headers["x-forwarded-for"] as string) ||
        socket.handshake.address ||
        "unknown";

      const { immediate, requestId } = pairingManager.submitPairing(parsed.data, clientIp, socket.id);
      socket.emit("pairing:status", {
        requestId,
        status: immediate ? immediate.status : "pending",
        message: immediate?.message,
      });
    });

    socket.on("pairing:cancel", (payload: { requestId?: string; challengeId?: string }) => {
      if (payload?.requestId) {
        pairingManager.cancelPairing(payload.requestId);
      } else if (payload?.challengeId) {
        pairingManager.cancelChallenge(payload.challengeId);
      }
    });

    socket.on("pairing:decision", async (payload: { requestId: string; decision: "approve" | "reject" }) => {
      if (!isHost) return;
      await pairingManager.handleHostDecision(payload.requestId, payload.decision, socket.id);
    });

    socket.on("session:revoke", (payload) => {
      const parsed = RevokeSessionSchema.safeParse(payload);
      if (parsed.success) {
        if (isHost || (session && session.sessionId === parsed.data.sessionId)) {
          pairingManager.revokeSession(parsed.data.sessionId, parsed.data.reason || "Revoked by user");
        }
      }
    });

    socket.on("session:revoke_all", () => {
      if (isHost) {
        pairingManager.revokeAllSessions("Host initiated emergency kill-switch");
      }
    });

    // ─── WebRTC Signaling ─────────────────────────────────────────────────

    socket.on("webrtc:signal", (data) => {
      const parsed = WebRTCSignalSchema.safeParse(data);
      if (!parsed.success) return;

      if (isHost) {
        // Forward signal from Host to target viewer or broadcast
        if (parsed.data.target) {
          io.to(parsed.data.target).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        } else {
          socket.broadcast.emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        }
      } else {
        // Viewer sending signal to Host
        const hostSocketId = screenStreamManager.getHostSocketId();
        if (hostSocketId) {
          io.to(hostSocketId).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        }
      }
    });

    // ─── Authenticated Controller Guard ───────────────────────────────────

    const requireAuth = (callback: () => void) => {
      if (isHost || session) {
        callback();
      } else {
        socket.emit("auth:error", { message: "Action requires authenticated session." });
      }
    };

    /**
     * Finds the active Windows Host socket and relays an event to it.
     * If no Host is connected, emits HOST_OFFLINE back to the controller.
     */
    const relayToHost = (hostEvent: string, data: unknown, logLabel: string) => {
      const hostSocketId = screenStreamManager.getHostSocketId();
      if (!hostSocketId) {
        console.warn(`[JARVIS RELAY] ${logLabel} → HOST_OFFLINE (no host connected)`);
        socket.emit("host:offline", { event: hostEvent, message: "Windows Host Agent is not connected." });
        return;
      }
      console.log(`[JARVIS RELAY] ${logLabel} → HOST`);
      io.to(hostSocketId).emit(hostEvent, data);
    };

    // ─── Mouse & Touch Control (Relay to Windows Host) ────────────────────

    socket.on("control:mouse_move", (data) => {
      requireAuth(() => {
        const parsed = MouseMoveSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:mouse_move", parsed.data, "mouse_move");
        }
      });
    });

    socket.on("control:mouse_click", (data) => {
      requireAuth(() => {
        const parsed = MouseClickSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:mouse_click", parsed.data, "mouse_click");
        }
      });
    });

    socket.on("control:mouse_button", (data) => {
      requireAuth(() => {
        const parsed = MouseButtonActionSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:mouse_button", parsed.data, "mouse_button");
        }
      });
    });

    socket.on("control:mouse_scroll", (data) => {
      requireAuth(() => {
        const parsed = MouseScrollSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:mouse_scroll", parsed.data, "mouse_scroll");
        }
      });
    });

    // ─── Keyboard Control (Relay to Windows Host) ─────────────────────────

    socket.on("control:key", (data) => {
      requireAuth(() => {
        const parsed = KeyboardKeySchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:key", parsed.data, "key");
        }
      });
    });

    socket.on("control:type", (data) => {
      requireAuth(() => {
        const parsed = KeyboardTypeSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:control:type", parsed.data, "type");
        }
      });
    });

    // ─── Terminal (Relay to Windows Host) ────────────────────────────────

    socket.on("terminal:spawn", (data) => {
      requireAuth(() => {
        const parsed = TerminalSpawnSchema.safeParse(data || {});
        if (!parsed.success) return;

        const hostSocketId = screenStreamManager.getHostSocketId();
        if (!hostSocketId) {
          socket.emit("host:offline", { event: "terminal:spawn", message: "Windows Host Agent is not connected." });
          return;
        }

        // Register controller to receive terminal output for this session
        const sessionId = parsed.data.sessionId || generateUUID();
        const spawnData = { ...parsed.data, sessionId };

        socket.join(`term-${sessionId}`);
        console.log(`[JARVIS RELAY] terminal:spawn → HOST (sessionId=${sessionId})`);
        io.to(hostSocketId).emit("host:terminal:spawn", spawnData);

        // Listen for ready confirmation from host and relay to controller
        // (handled via host:terminal:ready event from host socket above)
      });
    });

    socket.on("terminal:input", (data) => {
      requireAuth(() => {
        const parsed = TerminalInputSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:terminal:input", parsed.data, "terminal:input");
        }
      });
    });

    socket.on("terminal:resize", (data) => {
      requireAuth(() => {
        const parsed = TerminalResizeSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:terminal:resize", parsed.data, "terminal:resize");
        }
      });
    });

    socket.on("terminal:kill", (data) => {
      requireAuth(() => {
        const parsed = TerminalKillSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("host:terminal:kill", parsed.data, "terminal:kill");
        }
      });
    });

    // ─── Voice Commands ───────────────────────────────────────────────────

    socket.on("voice:parse", (payload: { text: string; language?: string }) => {
      requireAuth(() => {
        if (!payload || typeof payload.text !== "string") return;
        // Parsing is stateless — Railway can do this without Windows
        const intent = voiceEngine.parseTranscript(payload.text, payload.language || "auto");
        socket.emit("voice:parsed", intent);
      });
    });

    socket.on("voice:execute", async (payload) => {
      requireAuth(async () => {
        const parsed = VoiceExecutionRequestSchema.safeParse(payload);
        if (!parsed.success || !parsed.data.approved) return;

        const hostSocketId = screenStreamManager.getHostSocketId();
        if (!hostSocketId) {
          console.warn("[JARVIS RELAY] voice:execute → HOST_OFFLINE");
          socket.emit("host:offline", { event: "voice:execute", message: "Windows Host Agent is not connected." });
          return;
        }

        console.log("[JARVIS RELAY] voice:execute → HOST");
        // Relay the full payload to Windows Host Agent for execution
        io.to(hostSocketId).emit("host:voice:execute", payload);
        // Result will come back via host:voice:result → voice:result (see host events above)
      });
    });

    // ─── Disconnect ───────────────────────────────────────────────────────

    socket.on("disconnect", () => {
      if (session) {
        screenStreamManager.unregisterViewer(socket.id);
      }
    });
  });
}
