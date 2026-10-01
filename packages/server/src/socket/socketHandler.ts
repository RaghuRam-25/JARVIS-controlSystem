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
 * both direct ("control:*") and namespaced ("host:control:*") events.
 * The Host Agent executes them locally on Windows.
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
      io.to("host-room").emit("pairing:approved", {
        requestId: data.requestId,
        sessionId: data.sessionId,
        clientName: data.clientName,
        deviceType: data.deviceType,
        clientFingerprint: data.clientFingerprint,
      });
    } else {
      // No known socket to deliver the token to; broadcast without token.
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
    const target = pairingManager.getSocketIdForRequest(data.requestId);
    if (target) {
      io.to(target).emit("pairing:rejected", data);
    }
    io.to("host-room").emit("pairing:rejected", data);
  });

  pairingManager.on("pairing_cancelled", (data) => {
    io.to("host-room").emit("pairing:cancelled", data);
  });

  pairingManager.on("session_revoked", (data) => {
    io.to(`session-${data.sessionId}`).emit("session:revoked", data);
    io.to("host-room").emit("session:revoked", data);
  });

  pairingManager.on("sessions_revoked_all", (data) => {
    io.emit("session:revoked_all", data);
  });

  /**
   * Resolves the target room or socket ID for the Windows Host Agent.
   * Prefers "windows-host-room" (dedicated daemon bridge), then "host-room",
   * then screenStreamManager.getHostSocketId().
   */
  const getWindowsHostTarget = (): string | null => {
    const winRoom = io.sockets.adapter.rooms.get("windows-host-room");
    if (winRoom && winRoom.size > 0) {
      return "windows-host-room";
    }
    const hostRoom = io.sockets.adapter.rooms.get("host-room");
    if (hostRoom && hostRoom.size > 0) {
      return "host-room";
    }
    return screenStreamManager.getHostSocketId();
  };

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

    const isHostAgent =
      isHost &&
      (Boolean(auth.isHostAgent) ||
        auth.role === "host-agent" ||
        auth.clientType === "host-agent" ||
        query.isHostAgent === "true" ||
        query.role === "host-agent");

    let session: AuthSession | null = null;

    if (isHost) {
      // ─── Windows Host Agent & Host UI Registration ────────────────────
      socket.join("host-room");

      if (isHostAgent) {
        socket.join("windows-host-room");
        screenStreamManager.registerHost(socket.id, true);
        console.log(`[JARVIS RELAY] Windows Host Agent registered: socket=${socket.id}`);
      } else {
        socket.join("host-ui-room");
        screenStreamManager.registerHost(socket.id, false);
        console.log(`[JARVIS RELAY] Web Host Deck registered: socket=${socket.id}`);
      }

      // Forward terminal output from Host Agent back to controller sockets
      const handleTerminalData = ({ sessionId, data }: { sessionId: string; data: string }) => {
        io.to(`term-${sessionId}`).emit("terminal:data", { sessionId, data });
      };
      socket.on("host:terminal:data", handleTerminalData);
      socket.on("terminal:data", handleTerminalData);

      const handleTerminalExit = ({ sessionId, code, signal }: { sessionId: string; code: number | null; signal: string | null }) => {
        io.to(`term-${sessionId}`).emit("terminal:exit", { sessionId, code, signal });
      };
      socket.on("host:terminal:exit", handleTerminalExit);
      socket.on("terminal:exit", handleTerminalExit);

      const handleTerminalReady = (data: { sessionId: string; cols: number; rows: number }) => {
        io.to(`term-${data.sessionId}`).emit("terminal:ready", data);
      };
      socket.on("host:terminal:ready", handleTerminalReady);
      socket.on("terminal:ready", handleTerminalReady);

      // Voice result relay: Host → Railway → Controller
      const handleVoiceResult = (payload: any) => {
        const result = payload?.result || payload;
        const intent = payload?.intent;
        io.emit("voice:result", result);
        io.to("host-room").emit("voice:executed", { intent, result });
      };
      socket.on("host:voice:result", handleVoiceResult);
      socket.on("voice:result", handleVoiceResult);

      // Screen metrics: Host advertises actual Windows resolution
      const handleScreenMetrics = (metrics: { width: number; height: number; scaleFactor: number }) => {
        io.emit("host:screen_metrics", metrics);
        io.emit("screen:metrics", metrics);
      };
      socket.on("host:screen_metrics", handleScreenMetrics);
      socket.on("screen:metrics", handleScreenMetrics);

      socket.on("disconnect", () => {
        screenStreamManager.unregisterHost(socket.id);
        console.log(`[JARVIS RELAY] Host socket disconnected: socket=${socket.id}`);
        // If no Windows Host remains, notify controllers
        const target = getWindowsHostTarget();
        if (!target) {
          io.emit("host:status", { online: false });
        }
      });

      // Notify controllers that host is online
      io.emit("host:status", { online: true });
    } else if (token) {
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
      if (!parsed.success) {
        console.warn("[JARVIS RAILWAY] Invalid WebRTC signal schema:", parsed.error.issues);
        return;
      }

      if (isHost) {
        // Forward signal from Host (answer, candidate, ready, screen_stopped)
        console.log(`[JARVIS RAILWAY] Host WebRTC signal (${parsed.data.type}) relayed -> target: ${parsed.data.target || "broadcast"}`);
        if (parsed.data.target) {
          io.to(parsed.data.target).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        } else {
          socket.broadcast.emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        }
      } else {
        // Forward signal from Viewer (offer, candidate, ready, request_offer)
        console.log(`[JARVIS RAILWAY] Viewer ${socket.id} WebRTC signal (${parsed.data.type}) relayed to Host rooms`);
        
        // Broadcast signal to all Host UI broadcasters in host-ui-room and host-room
        io.to("host-ui-room").emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        io.to("host-room").emit("webrtc:signal", { ...parsed.data, sender: socket.id });

        // If target was specifically designated, also emit to target
        if (parsed.data.target) {
          io.to(parsed.data.target).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
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
     * Finds the active Windows Host socket/room and relays an event to it.
     * Emits BOTH direct event name (e.g. "control:mouse_click") and prefixed
     * ("host:control:mouse_click") to guarantee 100% listener compatibility.
     * If no Host is connected, emits HOST_OFFLINE back to the controller.
     */
    const relayToHost = (eventName: string, data: unknown) => {
      const target = getWindowsHostTarget();
      if (!target) {
        console.warn(`[JARVIS RAILWAY] ${eventName} → HOST_OFFLINE (no host connected)`);
        socket.emit("host:offline", { event: eventName, message: "Windows Host Agent is not connected." });
        return;
      }
      console.log(`[JARVIS RAILWAY] Forwarding ${eventName} to Host Agent`);
      io.to(target).emit(eventName, data);
      if (!eventName.startsWith("host:")) {
        io.to(target).emit(`host:${eventName}`, data);
      }
    };

    // ─── Mouse & Touch Control (Relay to Windows Host) ────────────────────

    socket.on("control:mouse_move", (data) => {
      requireAuth(() => {
        const parsed = MouseMoveSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:mouse_move", parsed.data);
        }
      });
    });

    socket.on("control:mouse_click", (data) => {
      requireAuth(() => {
        const parsed = MouseClickSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:mouse_click", parsed.data);
        }
      });
    });

    socket.on("control:mouse_button", (data) => {
      requireAuth(() => {
        const parsed = MouseButtonActionSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:mouse_button", parsed.data);
        }
      });
    });

    socket.on("control:mouse_scroll", (data) => {
      requireAuth(() => {
        const parsed = MouseScrollSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:mouse_scroll", parsed.data);
        }
      });
    });

    // ─── Keyboard Control (Relay to Windows Host) ─────────────────────────

    socket.on("control:key", (data) => {
      requireAuth(() => {
        const parsed = KeyboardKeySchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:key", parsed.data);
        }
      });
    });

    socket.on("control:type", (data) => {
      requireAuth(() => {
        const parsed = KeyboardTypeSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("control:type", parsed.data);
        }
      });
    });

    // ─── Terminal (Relay to Windows Host) ────────────────────────────────

    socket.on("terminal:spawn", (data) => {
      requireAuth(() => {
        const parsed = TerminalSpawnSchema.safeParse(data || {});
        if (!parsed.success) return;

        const target = getWindowsHostTarget();
        if (!target) {
          socket.emit("host:offline", { event: "terminal:spawn", message: "Windows Host Agent is not connected." });
          return;
        }

        // Register controller to receive terminal output for this session
        const sessionId = parsed.data.sessionId || generateUUID();
        const spawnData = { ...parsed.data, sessionId };

        socket.join(`term-${sessionId}`);
        console.log(`[JARVIS RAILWAY] Forwarding terminal:spawn to Host Agent (sessionId=${sessionId})`);
        io.to(target).emit("terminal:spawn", spawnData);
        io.to(target).emit("host:terminal:spawn", spawnData);
      });
    });

    socket.on("terminal:input", (data) => {
      requireAuth(() => {
        const parsed = TerminalInputSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("terminal:input", parsed.data);
        }
      });
    });

    socket.on("terminal:resize", (data) => {
      requireAuth(() => {
        const parsed = TerminalResizeSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("terminal:resize", parsed.data);
        }
      });
    });

    socket.on("terminal:kill", (data) => {
      requireAuth(() => {
        const parsed = TerminalKillSchema.safeParse(data);
        if (parsed.success) {
          relayToHost("terminal:kill", parsed.data);
        }
      });
    });

    // ─── Voice Commands ───────────────────────────────────────────────────

    socket.on("voice:parse", (payload: { text: string; language?: "en" | "bn" }) => {
      requireAuth(() => {
        if (!payload?.text) return;
        const intent = voiceEngine.parseTranscript(payload.text, payload.language);
        socket.emit("voice:parsed", intent);
      });
    });

    socket.on("voice:execute", (payload) => {
      requireAuth(() => {
        const parsed = VoiceExecutionRequestSchema.safeParse(payload);
        if (!parsed.success) return;

        // Relay voice execution request to Windows Host Agent
        relayToHost("voice:execute", payload);
      });
    });
  });
}
