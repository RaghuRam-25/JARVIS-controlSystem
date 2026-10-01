import { z } from "zod";

export const WebRTCSignalSchema = z.object({
  target: z.string().optional(),
  sender: z.string().optional(),
  type: z.enum(["offer", "answer", "candidate", "ready", "screen_stopped", "request_offer"]),
  sdp: z.string().optional(),
  candidate: z.any().optional(),
});
export type WebRTCSignal = z.infer<typeof WebRTCSignalSchema>;
