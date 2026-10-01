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
} from "@jarvis/shared";
import { pairingManager } from "../services/pairingManager.js";
import { inputAutomation } from "../services/inputAutomation.js";
import { terminalManager } from "../services/terminalManager.js";
import { voiceEngine } from "../services/voiceEngine.js";
import { automationExecutor } from "../services/automationExecutor.js";
import { screenStreamManager } from "../services/screenStreamManager.js";
import { verifyHostCredential } from "../services/hostAuth.js";
import { CONFIG } from "../config.js";

export function setupSocketHandlers(io: SocketIOServer) {
  // Listen for pairing events from manager to broadcast to sockets
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

  // Terminal data piping
  terminalManager.on("data", ({ sessionId, data }) => {
    io.to(`term-${sessionId}`).emit("terminal:data", { sessionId, data });
  });

  terminalManager.on("exit", ({ sessionId, code, signal }) => {
    io.to(`term-${sessionId}`).emit("terminal:exit", { sessionId, code, signal });
  });

  // Connection handler
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
      socket.join("host-room");
      screenStreamManager.registerHost(socket.id);

      socket.on("disconnect", () => {
        screenStreamManager.unregisterHost(socket.id);
      });
    } else if (token) {
      // Authenticate controller
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

    // --- Pairing Events ---
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
        // Allow if host OR if controller session is revoking its own session
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

    // --- WebRTC Signaling ---
    socket.on("webrtc:signal", (data) => {
      const parsed = WebRTCSignalSchema.safeParse(data);
      if (!parsed.success) return;

      if (isHost) {
        // Forward signal to target viewer or broadcast
        if (parsed.data.target) {
          io.to(parsed.data.target).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        } else {
          socket.broadcast.emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        }
      } else {
        // Viewer sending to host
        const hostSocketId = screenStreamManager.getHostSocketId();
        if (hostSocketId) {
          io.to(hostSocketId).emit("webrtc:signal", { ...parsed.data, sender: socket.id });
        }
      }
    });

    // --- Authenticated Controller Guard ---
    const requireAuth = (callback: () => void) => {
      if (isHost || session) {
        callback();
      } else {
        socket.emit("auth:error", { message: "Action requires authenticated session." });
      }
    };

    // --- Remote Mouse & Touch Events ---
    socket.on("control:mouse_move", (data) => {
      requireAuth(() => {
        const parsed = MouseMoveSchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleMouseMove(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:mouse_move", parsed.data);
          }
        }
      });
    });

    socket.on("control:mouse_click", (data) => {
      requireAuth(() => {
        const parsed = MouseClickSchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleMouseClick(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:mouse_click", parsed.data);
          }
        }
      });
    });

    socket.on("control:mouse_button", (data) => {
      requireAuth(() => {
        const parsed = MouseButtonActionSchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleMouseButtonAction(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:mouse_button", parsed.data);
          }
        }
      });
    });

    socket.on("control:mouse_scroll", (data) => {
      requireAuth(() => {
        const parsed = MouseScrollSchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleMouseScroll(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:mouse_scroll", parsed.data);
          }
        }
      });
    });

    // --- Remote Keyboard Events ---
    socket.on("control:key", (data) => {
      requireAuth(() => {
        const parsed = KeyboardKeySchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleKeyboardKey(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:key", parsed.data);
          }
        }
      });
    });

    socket.on("control:type", (data) => {
      requireAuth(() => {
        const parsed = KeyboardTypeSchema.safeParse(data);
        if (parsed.success) {
          inputAutomation.handleKeyboardType(parsed.data);
          if (!isHost) {
            io.to("host-room").emit("control:type", parsed.data);
          }
        }
      });
    });

    // --- Interactive Terminal Events ---
    socket.on("terminal:spawn", (data) => {
      requireAuth(() => {
        const parsed = TerminalSpawnSchema.safeParse(data || {});
        if (parsed.success) {
          const inst = terminalManager.createSession(parsed.data, socket.id);
          socket.join(`term-${inst.sessionId}`);
          socket.emit("terminal:ready", { sessionId: inst.sessionId, cols: inst.cols, rows: inst.rows });
        }
      });
    });

    socket.on("terminal:input", (data) => {
      requireAuth(() => {
        const parsed = TerminalInputSchema.safeParse(data);
        if (parsed.success) {
          terminalManager.write(parsed.data.sessionId, parsed.data.data, socket.id);
        }
      });
    });

    socket.on("terminal:resize", (data) => {
      requireAuth(() => {
        const parsed = TerminalResizeSchema.safeParse(data);
        if (parsed.success) {
          terminalManager.resize(parsed.data, socket.id);
        }
      });
    });

    socket.on("terminal:kill", (data) => {
      requireAuth(() => {
        const parsed = TerminalKillSchema.safeParse(data);
        if (parsed.success) {
          terminalManager.kill(parsed.data.sessionId, socket.id);
        }
      });
    });

    // --- Voice Command Intent Recognition & Execution ---
    socket.on("voice:parse", (payload: { text: string; language?: string }) => {
      requireAuth(() => {
        if (!payload || typeof payload.text !== "string") return;
        const intent = voiceEngine.parseTranscript(payload.text, payload.language || "auto");
        socket.emit("voice:parsed", intent);
      });
    });

    socket.on("voice:execute", async (payload) => {
      requireAuth(async () => {
        const parsed = VoiceExecutionRequestSchema.safeParse(payload);
        if (!parsed.success || !parsed.data.approved) return;

        // Retrieve or parse intent
        const intent = voiceEngine.parseTranscript(payload.rawTranscript || "", payload.language);
        if (parsed.data.modifiedPayload) {
          intent.payload = { ...intent.payload, ...parsed.data.modifiedPayload };
        }

        const result = await automationExecutor.executeIntent(intent);
        socket.emit("voice:result", result);
        io.to("host-room").emit("voice:executed", { intent, result });
      });
    });

    socket.on("disconnect", () => {
      if (session) {
        screenStreamManager.unregisterViewer(socket.id);
      }
    });
  });
}
