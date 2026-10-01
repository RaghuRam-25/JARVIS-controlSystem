import { Router, Request, Response, NextFunction } from "express";
import QRCode from "qrcode";
import os from "os";
import { 
  PairingRequestSchema, 
  HostApprovalDecisionSchema, 
  RevokeSessionSchema,
} from "@jarvis/shared";
import { pairingManager } from "../services/pairingManager.js";
import { inputAutomation } from "../services/inputAutomation.js";
import { voiceEngine } from "../services/voiceEngine.js";
import { automationExecutor } from "../services/automationExecutor.js";
import { getLocalIpAddresses, getPrimaryLocalIp } from "../services/lan.js";
import { getHostCredential, isLoopbackAddress, verifyHostCredential } from "../services/hostAuth.js";
import { CONFIG } from "../config.js";

export const apiRouter = Router();

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const alt = req.headers["x-jarvis-token"];
  return typeof alt === "string" ? alt.trim() : undefined;
}

function extractHostCredential(req: Request): unknown {
  const header = req.headers["x-jarvis-host-credential"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return req.query?.hostCredential;
}

/** Requires a valid Host credential. Used for host-only administration. */
function requireHost(req: Request, res: Response, next: NextFunction) {
  if (!verifyHostCredential(extractHostCredential(req))) {
    res.status(401).json({ success: false, message: "Host credential required." });
    return;
  }
  next();
}

/** Requires a valid paired controller session token. */
function requireSession(req: Request, res: Response, next: NextFunction) {
  pairingManager
    .validateToken(extractBearerToken(req))
    .then((session) => {
      if (!session) {
        res.status(401).json({ success: false, message: "Authentication required." });
        return;
      }
      res.locals.session = session;
      next();
    })
    .catch(() => {
      res.status(500).json({ success: false, message: "Authentication check failed." });
    });
}

/**
 * Accepts either the Host credential or a paired controller token.
 * Used by read-only endpoints that both the Host UI and controllers consume.
 */
function requireHostOrSession(req: Request, res: Response, next: NextFunction) {
  if (verifyHostCredential(extractHostCredential(req))) {
    next();
    return;
  }
  requireSession(req, res, next);
}

// Health Check
apiRouter.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "JARVIS-V1-Host",
    host: CONFIG.HOST_NAME,
    platform: process.platform,
    primaryIp: getPrimaryLocalIp(),
    interfaces: getLocalIpAddresses(),
    port: CONFIG.PORT,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

// Generate Pairing Challenge & QR Payload
apiRouter.get("/api/pairing/challenge", async (req: Request, res: Response) => {
  try {
    const challenge = pairingManager.createChallenge();
    const primaryIp = getPrimaryLocalIp();
    
    // QR Code encodes connection metadata for controller PWA
    const qrPayload = JSON.stringify({
      version: "1.0.0",
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      hostName: challenge.hostName,
      hostIp: primaryIp,
      port: CONFIG.PORT,
      webPort: CONFIG.WEB_PORT,
      expiresAt: challenge.expiresAt,
    });

    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: {
        dark: "#00E5FF",
        light: "#0A0E17",
      },
    });

    res.json({
      success: true,
      challenge,
      qrPayload,
      qrDataUrl,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Controller requests pairing
apiRouter.post("/api/pairing/request", async (req: Request, res: Response) => {
  const parsed = PairingRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.errors });
  }

  // Only the left-most entry of X-Forwarded-For is meaningful, and it is only
  // trustworthy when the deployment actually terminates a proxy. The socket
  // address is used otherwise so rate limiting cannot be bypassed by spoofing.
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp =
    typeof forwarded === "string" && forwarded.length > 0
      ? forwarded.split(",")[0].trim()
      : req.socket.remoteAddress || "unknown";

  // requestPairing resolves only once the Host decides. Awaiting it here would
  // hold the HTTP connection open for up to 45s; the decision is delivered to
  // the controller over its socket, so this responds immediately.
  const { immediate, requestId, pending } = pairingManager.submitPairing(parsed.data, clientIp);
  pending?.catch(() => {
    /* the decision is delivered over the controller socket */
  });

  if (immediate) {
    if (immediate.status === "rate_limited") {
      return res.status(429).json({ success: false, message: immediate.message });
    }
    return res.status(400).json({ success: false, message: immediate.message });
  }

  res.json({
    success: true,
    status: "pending_approval",
    requestId,
    message: "Pairing request sent. Waiting for host approval on Windows PC...",
  });
});

// Host approves/rejects pending pairing request
apiRouter.post("/api/pairing/decision", requireHost, async (req: Request, res: Response) => {
  const parsed = HostApprovalDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.errors });
  }

  const result = await pairingManager.handleHostDecision(parsed.data.requestId, parsed.data.decision);
  res.json(result);
});

// Get pending pairing requests (for Host UI)
apiRouter.get("/api/pairing/pending", requireHost, (req: Request, res: Response) => {
  res.json({
    success: true,
    pending: pairingManager.getPendingApprovals(),
  });
});

// Get active paired sessions (tokens are stripped before leaving the process)
apiRouter.get("/api/pairing/sessions", requireHost, (req: Request, res: Response) => {
  res.json({
    success: true,
    sessions: pairingManager.getActiveSessions().map(({ token, ...rest }) => rest),
  });
});

// Revoke a session
apiRouter.post("/api/pairing/revoke", requireHost, (req: Request, res: Response) => {
  const parsed = RevokeSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.errors });
  }

  const ok = pairingManager.revokeSession(parsed.data.sessionId, parsed.data.reason);
  res.json({ success: ok });
});

// Emergency Revoke All
apiRouter.post("/api/pairing/revoke-all", requireHost, (req: Request, res: Response) => {
  pairingManager.revokeAllSessions("Emergency Kill Switch Activated");
  res.json({ success: true, message: "All sessions revoked." });
});

// System Status & Screen Metrics
apiRouter.get("/api/system/status", requireHostOrSession, (req: Request, res: Response) => {
  const metrics = inputAutomation.getMetrics();
  res.json({
    success: true,
    host: CONFIG.HOST_NAME,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuCount: os.cpus().length,
    totalMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    freeMemoryGB: Math.round(os.freemem() / (1024 * 1024 * 1024)),
    screen: metrics,
    primaryIp: getPrimaryLocalIp(),
  });
});

// Voice Intent Parsing & Execution via REST
apiRouter.post("/api/voice/intent", requireSession, async (req: Request, res: Response) => {
  const { transcript, language, execute, approved } = req.body;
  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ success: false, message: "Transcript text is required." });
  }

  const intent = voiceEngine.parseTranscript(transcript, language || "auto");

  if (!execute) {
    return res.json({ success: true, intent });
  }

  // Approval is a server-side decision derived from the parsed risk level, not
  // a flag the client can simply set to true.
  if (intent.requiresExplicitApproval && approved !== true) {
    return res.json({
      success: false,
      requiresApproval: true,
      intent,
      message: "This sensitive command requires explicit user confirmation before running.",
    });
  }

  const result = await automationExecutor.executeIntent(intent);
  return res.json({ success: result.success, intent, result });
});

// Releases the Host credential to the local Host Deck UI.
// Restricted to loopback callers: the host UI always runs on the Host machine
// (Electron shell or local dev), so a remote client can never bootstrap the
// privileged host role over the network.
apiRouter.get("/api/host/credential", (req: Request, res: Response) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ success: false, message: "Host credential is only available locally." });
  }
  res.json({ success: true, hostCredential: getHostCredential() });
});
