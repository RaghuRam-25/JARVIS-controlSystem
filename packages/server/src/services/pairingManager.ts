import EventEmitter from "events";
import { 
  PairingChallenge, 
  PairingRequest, 
  AuthSession, 
  createSignedToken, 
  generateRandomHex, 
  generateUUID, 
  verifySignedToken 
} from "@jarvis/shared";
import { CONFIG } from "../config.js";
import { getPrimaryLocalIp } from "./lan.js";

export interface PendingApproval {
  requestId: string;
  challengeId: string;
  clientName: string;
  clientFingerprint: string;
  deviceType: "phone" | "tablet" | "desktop" | "browser";
  clientIp: string;
  requestedAt: number;
  resolve: (value: { approved: boolean; token?: string; sessionId?: string; error?: string }) => void;
}

export class PairingManager extends EventEmitter {
  private activeChallenges = new Map<string, PairingChallenge>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private activeSessions = new Map<string, AuthSession>();
  private revokedSessions = new Set<string>();
  private rateLimits = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    super();
    // Cleanup expired nonces every 15 seconds (unrefed so Node.js exits cleanly in tests)
    const cleanupInterval = setInterval(() => this.cleanupExpired(), 15000);
    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }

  /**
   * Generates a new 60-second one-time pairing challenge
   */
  public createChallenge(): PairingChallenge {
    const challengeId = generateUUID();
    const nonce = generateRandomHex(16);
    const hostIp = getPrimaryLocalIp();
    const now = Date.now();

    const challenge: PairingChallenge = {
      challengeId,
      hostName: CONFIG.HOST_NAME,
      hostIp,
      port: CONFIG.PORT,
      nonce,
      createdAt: now,
      expiresAt: now + CONFIG.PAIRING_NONCE_TTL_MS,
      fingerprint: `${CONFIG.HOST_NAME}@${hostIp}`,
    };

    this.activeChallenges.set(challengeId, challenge);
    return challenge;
  }

  /**
   * Validates pairing challenge and checks rate limits
   */
  public async requestPairing(
    request: PairingRequest, 
    clientIp: string
  ): Promise<{ status: "pending" | "rejected" | "expired" | "rate_limited"; requestId?: string; message?: string }> {
    // 1. Rate limiting check
    if (this.isRateLimited(clientIp)) {
      return { status: "rate_limited", message: "Too many pairing attempts. Please wait 1 minute." };
    }

    // 2. Validate Challenge
    const challenge = this.activeChallenges.get(request.challengeId);
    if (!challenge) {
      return { status: "expired", message: "Pairing challenge not found or already consumed." };
    }

    if (Date.now() > challenge.expiresAt) {
      this.activeChallenges.delete(request.challengeId);
      return { status: "expired", message: "Pairing QR code has expired. Please refresh QR code." };
    }

    if (challenge.nonce !== request.nonce) {
      return { status: "rejected", message: "Invalid pairing nonce challenge." };
    }

    // Consume the challenge (one-time use)
    this.activeChallenges.delete(request.challengeId);

    // 3. Create pending approval request
    const requestId = generateUUID();
    
    return new Promise((resolve) => {
      const pending: PendingApproval = {
        requestId,
        challengeId: request.challengeId,
        clientName: request.clientName,
        clientFingerprint: request.clientFingerprint,
        deviceType: request.deviceType,
        clientIp,
        requestedAt: Date.now(),
        resolve: (result) => {
          this.pendingApprovals.delete(requestId);
          if (result.approved && result.token) {
            resolve({ status: "pending", requestId });
          } else {
            resolve({ status: "rejected", message: result.error || "Host denied pairing request." });
          }
        },
      };

      this.pendingApprovals.set(requestId, pending);

      // Emit event so Host UI / Desktop shell can prompt user for approval
      this.emit("pairing_requested", {
        requestId,
        clientName: request.clientName,
        deviceType: request.deviceType,
        clientIp,
        clientFingerprint: request.clientFingerprint,
        requestedAt: pending.requestedAt,
      });

      // Auto-reject if host doesn't answer within 45 seconds
      const timeout = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          resolve({ status: "rejected", message: "Pairing request timed out awaiting host approval." });
        }
      }, 45000);
      if (timeout.unref) timeout.unref();
    });
  }

  /**
   * Host approves or denies the pending pairing request
   */
  public async handleHostDecision(
    requestId: string, 
    decision: "approve" | "reject"
  ): Promise<{ success: boolean; session?: AuthSession; message?: string }> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return { success: false, message: "Pending request not found or expired." };
    }

    if (decision === "reject") {
      pending.resolve({ approved: false, error: "Host rejected the connection request." });
      this.pendingApprovals.delete(requestId);
      this.emit("pairing_rejected", { requestId });
      return { success: true, message: "Connection rejected." };
    }

    // Approved: Issue signed session token
    const sessionId = generateUUID();
    const now = Date.now();
    const expiresAt = now + CONFIG.SESSION_TTL_MS;

    const sessionPayload = {
      sessionId,
      clientFingerprint: pending.clientFingerprint,
      clientName: pending.clientName,
      deviceType: pending.deviceType,
      issuedAt: now,
      expiresAt,
    };

    const token = await createSignedToken(sessionPayload, CONFIG.SECRET_KEY);

    const session: AuthSession = {
      ...sessionPayload,
      token,
      status: "active",
    };

    this.activeSessions.set(sessionId, session);
    pending.resolve({ approved: true, token, sessionId });
    this.pendingApprovals.delete(requestId);

    this.emit("pairing_approved", {
      requestId,
      sessionId,
      clientName: session.clientName,
      deviceType: session.deviceType,
      clientFingerprint: session.clientFingerprint,
    });

    return { success: true, session };
  }

  /**
   * Validates an authentication token for Socket.IO or REST requests
   */
  public async validateToken(token?: string): Promise<AuthSession | null> {
    if (!token) return null;
    const payload = await verifySignedToken<{ sessionId: string; expiresAt: number }>(token, CONFIG.SECRET_KEY);
    if (!payload || !payload.sessionId) return null;

    if (this.revokedSessions.has(payload.sessionId)) {
      return null;
    }

    const session = this.activeSessions.get(payload.sessionId);
    if (!session || session.status !== "active") {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      this.revokeSession(payload.sessionId, "Session expired");
      return null;
    }

    return session;
  }

  public getPendingApprovals(): Array<Omit<PendingApproval, "resolve">> {
    return Array.from(this.pendingApprovals.values()).map(({ resolve, ...rest }) => rest);
  }

  public getActiveSessions(): AuthSession[] {
    return Array.from(this.activeSessions.values()).filter((s) => s.status === "active");
  }

  public revokeSession(sessionId: string, reason = "User initiated disconnect"): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.status = "revoked";
      this.revokedSessions.add(sessionId);
      this.emit("session_revoked", { sessionId, reason, clientName: session.clientName });
      return true;
    }
    return false;
  }

  public revokeAllSessions(reason = "Emergency disconnect all"): void {
    for (const [id, session] of this.activeSessions.entries()) {
      session.status = "revoked";
      this.revokedSessions.add(id);
    }
    this.emit("all_sessions_revoked", { reason });
  }

  private isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      this.rateLimits.set(ip, { count: 1, resetAt: now + 60000 });
      return false;
    }
    entry.count += 1;
    return entry.count > CONFIG.MAX_PAIRING_ATTEMPTS_PER_MIN;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, challenge] of this.activeChallenges.entries()) {
      if (now > challenge.expiresAt) {
        this.activeChallenges.delete(id);
      }
    }
  }
}

export const pairingManager = new PairingManager();
