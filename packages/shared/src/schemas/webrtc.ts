import { z } from "zod";

export const WebRTCSignalSchema = z.object({
  target: z.string().optional(),
  sender: z.string().optional(),
  type: z.enum(["offer", "answer", "candidate", "ready", "screen_stopped"]),
  sdp: z.string().optional(),
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  }).optional(),
});
export type WebRTCSignal = z.infer<typeof WebRTCSignalSchema>;
