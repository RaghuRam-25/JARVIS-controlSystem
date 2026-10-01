import { z } from "zod";

export const VoiceIntentTypeSchema = z.enum([
  "OPEN_APP",
  "OPEN_PROJECT",
  "RUN_COMMAND",
  "INSTALL_EXTENSION",
  "CODE_OPERATION",
  "ANTIGRAVITY_PROMPT",
  "BROWSER_YOUTUBE",
  "SYSTEM_ACTION",
  "MULTI_STEP_PLAN",
  "CLARIFICATION_NEEDED",
  "UNKNOWN"
]);
export type VoiceIntentType = z.infer<typeof VoiceIntentTypeSchema>;

export const ActionStepSchema = z.object({
  action: z.enum([
    "open_or_focus",
    "open_url",
    "search",
    "type",
    "press_key",
    "click",
    "navigate",
    "close_app",
    "command",
    "paste",
    "scroll",
    "switch_tab",
    "new_tab",
    "go_back",
    "go_forward",
  ]),
  target: z.string().optional(),
  query: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  description: z.string(),
});
export type ActionStep = z.infer<typeof ActionStepSchema>;

export const VoiceCommandIntentSchema = z.object({
  id: z.string().uuid(),
  type: VoiceIntentTypeSchema,
  rawTranscript: z.string(),
  language: z.enum(["en", "bn", "auto"]).default("auto"),
  confidence: z.number().min(0).max(1).default(1),
  requiresExplicitApproval: z.boolean().default(false),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
  summary: z.string(),
  payload: z.record(z.any()),
  timestamp: z.number(),
});
export type VoiceCommandIntent = z.infer<typeof VoiceCommandIntentSchema>;

export const VoiceExecutionRequestSchema = z.object({
  intentId: z.string().uuid(),
  approved: z.boolean(),
  modifiedPayload: z.record(z.any()).optional(),
  // For multi-step, carry full steps + context through the relay
  steps: z.array(ActionStepSchema).optional(),
  executionContext: z.record(z.any()).optional(),
});
export type VoiceExecutionRequest = z.infer<typeof VoiceExecutionRequestSchema>;

export const VoiceExecutionResultSchema = z.object({
  intentId: z.string().uuid(),
  success: z.boolean(),
  message: z.string(),
  output: z.string().optional(),
  error: z.string().optional(),
  stepResults: z.array(z.object({
    stepIndex: z.number(),
    action: z.string(),
    success: z.boolean(),
    message: z.string(),
  })).optional(),
  timestamp: z.number(),
});
export type VoiceExecutionResult = z.infer<typeof VoiceExecutionResultSchema>;
