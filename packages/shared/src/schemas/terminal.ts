import { z } from "zod";

export const TerminalSpawnSchema = z.object({
  sessionId: z.string().uuid().optional(),
  shell: z.enum(["powershell.exe", "cmd.exe", "pwsh.exe", "bash"]).default("powershell.exe"),
  cwd: z.string().optional(),
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
  env: z.record(z.string()).optional(),
});
export type TerminalSpawn = z.infer<typeof TerminalSpawnSchema>;

export const TerminalInputSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
});
export type TerminalInput = z.infer<typeof TerminalInputSchema>;

export const TerminalResizeSchema = z.object({
  sessionId: z.string(),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(5).max(200),
});
export type TerminalResize = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  sessionId: z.string(),
  signal: z.string().optional(),
});
export type TerminalKill = z.infer<typeof TerminalKillSchema>;

export const TerminalOutputSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
});
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;
