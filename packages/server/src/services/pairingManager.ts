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

export type ChallengeState = "created" | "pending_approval" | "approved" | "consumed" | "rejected" | "expired" | "cancelled";

export interface ManagedChallenge extends PairingChallenge {
  state: ChallengeState;
  requestId?: string;
}

export interface PendingApproval {
  requestId: string;
  challengeId: string;
  clientName: string;
  clientFingerprint: string;
  deviceType: "phone" | "tablet" | "desktop" | "browser";
  clientIp: string;
  requestedAt: number;
  /** Socket that is waiting for this request's decision. */
  socketId?: string;
  resolve: (value: { approved: boolean; token?: string; sessionId?: string; error?: string }) => void;
}

export class PairingManager extends EventEmitter {
  private activeChallenges = new Map<string, ManagedChallenge>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingApprovalPromises = new Map<string, Promise<{ status: "pending" | "rejected"; requestId?: string; message?: string }>>();
  private activeSessions = new Map<string, AuthSession>();
  private revokedSessions = new Set<string>();
  private rateLimits = new Map<string, { count: number; resetAt: number }>();
  /** Tokens awaiting delivery to the paired controller socket. */
  private pendingTokens = new Map<string, { token: string; expiresAt: number }>();
  /** Socket awaiting each request's decision, retained after approval. */
  private requestSockets = new Map<string, string>();

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
    const expiresAt = now + CONFIG.PAIRING_NONCE_TTL_MS;

    const publicUrl = CONFIG.PUBLIC_SERVER_URL;

    const challenge: ManagedChallenge = {
      challengeId,
      hostName: CONFIG.HOST_NAME,
      hostIp,
      serverUrl: publicUrl || undefined,
      port: CONFIG.PORT,
      nonce,
      createdAt: now,
      expiresAt,
      fingerprint: `${CONFIG.HOST_NAME}@${publicUrl || hostIp}`,
      state: "created",
    };

    this.activeChallenges.set(challengeId, challenge);
    console.log(`[PAIRING] challenge created: challengeId=${challengeId}, createdAt=${now}, expiresAt=${expiresAt}`);
    return {
      challengeId: challenge.challengeId,
      hostName: challenge.hostName,
      hostIp: challenge.hostIp,
      serverUrl: challenge.serverUrl,
      port: challenge.port,
      nonce: challenge.nonce,
      createdAt: challenge.createdAt,
      expiresAt: challenge.expiresAt,
      fingerprint: challenge.fingerprint,
    };
  }

  /**
   * Validates a pairing challenge and registers a pending approval request.
   *
   * Validation (rate limit, nonce, expiry) completes synchronously so callers
   * can answer the HTTP request immediately; the returned promise settles only
   * when the Host approves or rejects, or after the approval timeout.
   */
  public submitPairing(
    request: PairingRequest,
    clientIp: string,
    socketId?: string
  ): {
    immediate?: { status: "rejected" | "expired" | "rate_limited"; message: string };
    requestId?: string;
    pending?: Promise<{ status: "pending" | "rejected"; requestId?: string; message?: string }>;
  } {
    // 1. Rate limiting check
    if (this.isRateLimited(clientIp)) {
      console.warn(`[PAIRING] challenge rejected: rate limited (clientIp=${clientIp})`);
      return {
        immediate: { status: "rate_limited", message: "Too many pairing attempts. Please wait 1 minute." },
      };
    }

    // 2. Validate Challenge
    const challenge = this.activeChallenges.get(request.challengeId);
    if (!challenge) {
      console.warn(`[PAIRING] challenge rejected: unknown (challengeId=${request.challengeId})`);
      return {
        immediate: { status: "expired", message: "Pairing challenge not found or already consumed." },
      };
    }

    if (challenge.state === "consumed") {
      console.warn(`[PAIRING] challenge rejected: consumed (challengeId=${request.challengeId})`);
      return {
        immediate: { status: "expired", message: "Pairing challenge not found or already consumed." },
      };
    }

    if (challenge.state === "cancelled") {
      console.warn(`[PAIRING] challenge rejected: cancelled (challengeId=${request.challengeId})`);
      return {
        immediate: { status: "expired", message: "Pairing request was cancelled. Please scan a new QR code." },
      };
    }

    if (challenge.state === "rejected") {
      console.warn(`[PAIRING] challenge rejected: denied by host (challengeId=${request.challengeId})`);
      return {
        immediate: { status: "rejected", message: "Pairing request was denied by host. Please refresh QR code." },
      };
    }

    if (challenge.state === "expired" || Date.now() > challenge.expiresAt) {
      challenge.state = "expired";
      this.activeChallenges.delete(request.challengeId);
      console.warn(`[PAIRING] challenge rejected: expired (challengeId=${request.challengeId})`);
      return {
        immediate: { status: "expired", message: "Pairing QR code has expired. Please refresh QR code." },
      };
    }

    if (challenge.nonce !== request.nonce) {
      console.warn(`[PAIRING] challenge rejected: invalid nonce (challengeId=${request.challengeId})`);
      return { immediate: { status: "rejected", message: "Invalid pairing nonce challenge." } };
    }

    // Handle Idempotent submission if already in pending_approval
    if (challenge.state === "pending_approval" && challenge.requestId) {
      const existingPending = this.pendingApprovals.get(challenge.requestId);
      if (existingPending) {
        console.log(`[PAIRING] challenge already pending approval (idempotent submission): challengeId=${request.challengeId}, requestId=${challenge.requestId}`);
        if (socketId) {
          existingPending.socketId = socketId;
          this.requestSockets.set(challenge.requestId, socketId);
        }
        const pendingPromise = this.pendingApprovalPromises.get(challenge.requestId);
        return { requestId: challenge.requestId, pending: pendingPromise };
      }
    }

    // 3. Mark challenge as pending_approval (DO NOT consume until host approval / session creation)
    challenge.state = "pending_approval";
    const requestId = generateUUID();
    challenge.requestId = requestId;

    console.log(`[PAIRING] challenge scanned: challengeId=${request.challengeId}, requestId=${requestId}`);
    console.log(`[PAIRING] approval pending: requestId=${requestId}, clientName=${request.clientName}, deviceType=${request.deviceType}, clientIp=${clientIp}`);

    if (socketId) {
      this.requestSockets.set(requestId, socketId);
    }

    let timeoutHandle: NodeJS.Timeout | null = null;

    const pending = new Promise<{ status: "pending" | "rejected"; requestId?: string; message?: string }>(
      (resolve) => {
        const entry: PendingApproval = {
          requestId,
          challengeId: request.challengeId,
          clientName: request.clientName,
          clientFingerprint: request.clientFingerprint,
          deviceType: request.deviceType,
          clientIp,
          requestedAt: Date.now(),
          ...(socketId ? { socketId } : {}),
          resolve: (result) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            this.pendingApprovals.delete(requestId);
            this.pendingApprovalPromises.delete(requestId);
            if (result.approved && result.token) {
              resolve({ status: "pending", requestId });
            } else {
              resolve({ status: "rejected", message: result.error || "Host denied pairing request." });
            }
          },
        };

        this.pendingApprovals.set(requestId, entry);

        // Emit event so Host UI / Desktop shell can prompt user for approval
        this.emit("pairing_requested", {
          requestId,
          challengeId: request.challengeId,
          clientName: request.clientName,
          deviceType: request.deviceType,
          clientIp,
          clientFingerprint: request.clientFingerprint,
          requestedAt: entry.requestedAt,
        });

        // Auto-reject if host doesn't answer within 45 seconds
        timeoutHandle = setTimeout(() => {
          if (this.pendingApprovals.has(requestId)) {
            console.warn(`[PAIRING] pairing request timed out awaiting host approval: requestId=${requestId}`);
            const ch = this.activeChallenges.get(request.challengeId);
            if (ch && ch.state === "pending_approval") {
              ch.state = "expired";
              this.activeChallenges.delete(request.challengeId);
            }
            this.pendingApprovals.delete(requestId);
            this.pendingApprovalPromises.delete(requestId);
            this.requestSockets.delete(requestId);
            resolve({ status: "rejected", message: "Pairing request timed out awaiting host approval." });
          }
        }, 45000);
        if (timeoutHandle.unref) timeoutHandle.unref();
      }
    );

    this.pendingApprovalPromises.set(requestId, pending);

    return { requestId, pending };
  }

  /**
   * Convenience wrapper that awaits the Host's decision.
   */
  public async requestPairing(
    request: PairingRequest,
    clientIp: string,
    socketId?: string
  ): Promise<{ status: "pending" | "rejected" | "expired" | "rate_limited"; requestId?: string; message?: string }> {
    const { immediate, requestId, pending } = this.submitPairing(request, clientIp, socketId);
    if (immediate) {
      return { status: immediate.status, message: immediate.message };
    }
    const result = await pending!;
    return { ...result, requestId: result.requestId ?? requestId };
  }

  /**
   * Host approves or denies the pending pairing request
   */
  public async handleHostDecision(
    requestId: string, 
    decision: "approve" | "reject",
    hostSocketId?: string
  ): Promise<{ success: boolean; session?: AuthSession; message?: string }> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      console.warn(`[PAIRING] handleHostDecision failed: pending request not found or expired (requestId=${requestId})`);
      return { success: false, message: "Pending request not found or expired." };
    }

    const challenge = this.activeChallenges.get(pending.challengeId);

    if (decision === "reject") {
      console.log(`[PAIRING] host rejected: requestId=${requestId}, challengeId=${pending.challengeId}`);
      if (challenge) {
        challenge.state = "rejected";
        this.activeChallenges.delete(pending.challengeId);
      }
      pending.resolve({ approved: false, error: "Host rejected the connection request." });
      this.pendingApprovals.delete(requestId);
      this.pendingApprovalPromises.delete(requestId);
      this.emit("pairing_rejected", { requestId });
      return { success: true, message: "Connection rejected." };
    }

    // Approved: Consume the challenge exactly once and create new controller session
    if (challenge) {
      challenge.state = "consumed";
      this.activeChallenges.delete(pending.challengeId);
      console.log(`[PAIRING] host approved: requestId=${requestId}`);
      console.log(`[PAIRING] challenge consumed: challengeId=${pending.challengeId}`);
    } else {
      console.log(`[PAIRING] host approved: requestId=${requestId}`);
    }

    // Issue signed session token
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
    console.log(`[PAIRING] session created: sessionId=${sessionId}, clientName=${session.clientName}, deviceType=${session.deviceType}`);

    // The HTTP /api/pairing/request call already returned "pending_approval",
    // so the token must reach the controller over its socket. Store it for
    // single delivery instead of dropping it after the resolved promise.
    this.pendingTokens.set(requestId, { token, expiresAt: Date.now() + 60000 });
    const waitingSocket = pending.socketId || hostSocketId;
    if (waitingSocket) {
      this.requestSockets.set(requestId, waitingSocket);
    }

    pending.resolve({ approved: true, token, sessionId });
    this.pendingApprovals.delete(requestId);
    this.pendingApprovalPromises.delete(requestId);

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
   * Controller explicitly cancels a pending pairing request
   */
  public cancelPairing(requestId: string): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      // Check if any challenge has this requestId
      for (const [chId, ch] of this.activeChallenges.entries()) {
        if (ch.requestId === requestId) {
          ch.state = "cancelled";
          this.activeChallenges.delete(chId);
          console.log(`[PAIRING] pairing request cancelled (via challenge): requestId=${requestId}, challengeId=${chId}`);
          this.emit("pairing_cancelled", { requestId, challengeId: chId });
          return true;
        }
      }
      return false;
    }

    console.log(`[PAIRING] pairing request cancelled: requestId=${requestId}, challengeId=${pending.challengeId}`);
    const challenge = this.activeChallenges.get(pending.challengeId);
    if (challenge) {
      challenge.state = "cancelled";
      this.activeChallenges.delete(pending.challengeId);
    }

    pending.resolve({ approved: false, error: "Pairing request was cancelled by controller." });
    this.pendingApprovals.delete(requestId);
    this.pendingApprovalPromises.delete(requestId);
    this.requestSockets.delete(requestId);
    this.pendingTokens.delete(requestId);

    this.emit("pairing_cancelled", { requestId, challengeId: pending.challengeId });
    return true;
  }

  /**
   * Cancel by challenge ID
   */
  public cancelChallenge(challengeId: string): boolean {
    const challenge = this.activeChallenges.get(challengeId);
    if (!challenge) return false;
    if (challenge.requestId) {
      return this.cancelPairing(challenge.requestId);
    }
    challenge.state = "cancelled";
    this.activeChallenges.delete(challengeId);
    console.log(`[PAIRING] challenge cancelled directly: challengeId=${challengeId}`);
    return true;
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

  /** Socket awaiting the outcome of a pairing request, if it registered one. */
  public getSocketIdForRequest(requestId: string): string | undefined {
    return this.requestSockets.get(requestId) || this.pendingApprovals.get(requestId)?.socketId;
  }

  /**
   * Returns and clears the token issued for a pairing request.
   * Single-use so an approved credential is delivered at most once.
   */
  public consumeTokenForRequest(requestId: string): string | null {
    const entry = this.pendingTokens.get(requestId);
    if (!entry) return null;
    this.pendingTokens.delete(requestId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.token;
  }

  public getActiveSessions(): AuthSession[] {
    return Array.from(this.activeSessions.values()).filter((s) => s.status === "active");
  }

  public revokeSession(sessionId: string, reason = "User initiated disconnect"): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.status = "revoked";
      this.revokedSessions.add(sessionId);
      console.log(`[PAIRING] session revoked: sessionId=${sessionId}, clientName=${session.clientName}, reason="${reason}"`);
      this.emit("session_revoked", { sessionId, reason, clientName: session.clientName });
      return true;
    }
    return false;
  }

  public revokeAllSessions(reason = "Emergency disconnect all"): void {
    console.log(`[PAIRING] all sessions revoked: reason="${reason}"`);
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
        challenge.state = "expired";
        this.activeChallenges.delete(id);
      }
    }
    for (const [id, entry] of this.pendingTokens.entries()) {
      if (now > entry.expiresAt) {
        this.pendingTokens.delete(id);
        this.requestSockets.delete(id);
      }
    }
    for (const [id, session] of this.activeSessions.entries()) {
      if (now > session.expiresAt && session.status === "active") {
        session.status = "expired";
        this.revokedSessions.add(id);
      }
    }
  }
}

export const pairingManager = new PairingManager();

