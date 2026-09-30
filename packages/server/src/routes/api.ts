import { Router, Request, Response } from "express";
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
import { CONFIG } from "../config.js";

export const apiRouter = Router();

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

  const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
  const result = await pairingManager.requestPairing(parsed.data, clientIp);

  if (result.status === "rate_limited") {
    return res.status(429).json({ success: false, message: result.message });
  }
  if (result.status === "expired" || result.status === "rejected") {
    return res.status(400).json({ success: false, message: result.message });
  }

  res.json({
    success: true,
    status: "pending_approval",
    requestId: result.requestId,
    message: "Pairing request sent. Waiting for host approval on Windows PC...",
  });
});

// Host approves/rejects pending pairing request
apiRouter.post("/api/pairing/decision", async (req: Request, res: Response) => {
  const parsed = HostApprovalDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.errors });
  }

  const result = await pairingManager.handleHostDecision(parsed.data.requestId, parsed.data.decision);
  res.json(result);
});

// Get pending pairing requests (for Host UI)
apiRouter.get("/api/pairing/pending", (req: Request, res: Response) => {
  res.json({
    success: true,
    pending: pairingManager.getPendingApprovals(),
  });
});

// Get active paired sessions
apiRouter.get("/api/pairing/sessions", (req: Request, res: Response) => {
  res.json({
    success: true,
    sessions: pairingManager.getActiveSessions(),
  });
});

// Revoke a session
apiRouter.post("/api/pairing/revoke", (req: Request, res: Response) => {
  const parsed = RevokeSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.errors });
  }

  const ok = pairingManager.revokeSession(parsed.data.sessionId, parsed.data.reason);
  res.json({ success: ok });
});

// Emergency Revoke All
apiRouter.post("/api/pairing/revoke-all", (req: Request, res: Response) => {
  pairingManager.revokeAllSessions("Emergency Kill Switch Activated");
  res.json({ success: true, message: "All sessions revoked." });
});

// System Status & Screen Metrics
apiRouter.get("/api/system/status", (req: Request, res: Response) => {
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
apiRouter.post("/api/voice/intent", async (req: Request, res: Response) => {
  const { transcript, language, execute, authToken } = req.body;
  if (!transcript) {
    return res.status(400).json({ success: false, message: "Transcript text is required." });
  }

  const intent = voiceEngine.parseTranscript(transcript, language || "auto");

  if (execute) {
    const session = await pairingManager.validateToken(authToken);
    if (!session) {
      return res.status(401).json({ success: false, message: "Authentication required to execute actions." });
    }

    if (intent.requiresExplicitApproval && !req.body.approved) {
      return res.json({
        success: false,
        requiresApproval: true,
        intent,
        message: "This sensitive command requires explicit user confirmation before running.",
      });
    }

    const result = await automationExecutor.executeIntent(intent);
    return res.json({ success: result.success, intent, result });
  }

  res.json({ success: true, intent });
});
