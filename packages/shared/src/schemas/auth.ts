import { z } from "zod";

export const DeviceTypeSchema = z.enum(["phone", "tablet", "desktop", "browser"]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const PairingChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  hostName: z.string().min(1),
  hostIp: z.string().min(1),
  serverUrl: z.string().optional(),
  port: z.number().int().positive(),
  nonce: z.string().length(32),
  createdAt: z.number(),
  expiresAt: z.number(),
  fingerprint: z.string(),
});
export type PairingChallenge = z.infer<typeof PairingChallengeSchema>;

export const PairingRequestSchema = z.object({
  challengeId: z.string().uuid(),
  nonce: z.string().length(32),
  clientName: z.string().min(1).max(50),
  clientFingerprint: z.string().min(16),
  deviceType: DeviceTypeSchema,
  userAgent: z.string().optional(),
  socketId: z.string().optional(),
});
export type PairingRequest = z.infer<typeof PairingRequestSchema>;

export const PairingResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["pending_approval", "approved", "rejected", "expired", "rate_limited"]),
  message: z.string().optional(),
  token: z.string().optional(),
  sessionId: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type PairingResponse = z.infer<typeof PairingResponseSchema>;

export const HostApprovalDecisionSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  rememberDevice: z.boolean().default(false),
});
export type HostApprovalDecision = z.infer<typeof HostApprovalDecisionSchema>;

export const AuthSessionSchema = z.object({
  sessionId: z.string().uuid(),
  clientFingerprint: z.string(),
  clientName: z.string(),
  deviceType: DeviceTypeSchema,
  token: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(["active", "revoked", "expired"]),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const RevokeSessionSchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().optional(),
});
export type RevokeSession = z.infer<typeof RevokeSessionSchema>;
