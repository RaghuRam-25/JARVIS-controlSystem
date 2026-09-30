import { z } from "zod";

export const MouseButtonSchema = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

export const MouseMoveSchema = z.object({
  // Normalized coordinates (0.0 to 1.0) relative to screen size
  normalizedX: z.number().min(0).max(1).optional(),
  normalizedY: z.number().min(0).max(1).optional(),
  // Or absolute pixels if already scaled
  absX: z.number().optional(),
  absY: z.number().optional(),
  // Or delta for trackpad relative motion
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  isRelative: z.boolean().default(false),
});
export type MouseMove = z.infer<typeof MouseMoveSchema>;

export const MouseClickSchema = z.object({
  button: MouseButtonSchema.default("left"),
  double: z.boolean().default(false),
  normalizedX: z.number().min(0).max(1).optional(),
  normalizedY: z.number().min(0).max(1).optional(),
});
export type MouseClick = z.infer<typeof MouseClickSchema>;

export const MouseButtonActionSchema = z.object({
  action: z.enum(["down", "up"]),
  button: MouseButtonSchema.default("left"),
  normalizedX: z.number().min(0).max(1).optional(),
  normalizedY: z.number().min(0).max(1).optional(),
});
export type MouseButtonAction = z.infer<typeof MouseButtonActionSchema>;

export const MouseScrollSchema = z.object({
  deltaX: z.number().default(0),
  deltaY: z.number().default(0),
});
export type MouseScroll = z.infer<typeof MouseScrollSchema>;

export const KeyboardKeySchema = z.object({
  key: z.string(),
  code: z.string().optional(),
  action: z.enum(["down", "up", "press"]),
  modifiers: z.object({
    ctrl: z.boolean().default(false),
    alt: z.boolean().default(false),
    shift: z.boolean().default(false),
    meta: z.boolean().default(false),
  }).default({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  }),
});
export type KeyboardKey = z.infer<typeof KeyboardKeySchema>;

export const KeyboardTypeSchema = z.object({
  text: z.string(),
});
export type KeyboardType = z.infer<typeof KeyboardTypeSchema>;

export const ScreenMetricsSchema = z.object({
  width: z.number(),
  height: z.number(),
  scaleFactor: z.number().default(1),
  fps: z.number().default(30),
});
export type ScreenMetrics = z.infer<typeof ScreenMetricsSchema>;
