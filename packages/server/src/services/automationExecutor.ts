/**
 * automationExecutor.ts
 *
 * Executes VoiceCommandIntents on the Windows Host Agent.
 * Supports multi-step action plans (MULTI_STEP_PLAN / OPEN_APP / BROWSER_YOUTUBE)
 * with step-by-step progress logging and sequential execution.
 *
 * Flow:
 *   VoiceCommandIntent.payload.steps → executeSteps() → Windows automation
 *
 * Context update after execution so the voice engine can chain follow-up commands.
 */

import { spawn, exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { VoiceCommandIntent, VoiceExecutionResult, ActionStep } from "@jarvis/shared";
import { terminalManager } from "./terminalManager.js";
import { inputAutomation } from "./inputAutomation.js";
import { updateVoiceContext } from "./voiceEngine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execAsync(cmd: string, opts: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: process.cwd(), timeout: opts.timeout || 15000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** Launch a detached process silently */
function launchDetached(cmd: string, args: string[], opts: { shell?: boolean } = {}): void {
  const proc = spawn(cmd, args, { detached: true, stdio: "ignore", shell: opts.shell });
  proc.on("error", () => {});
  proc.unref();
}

// ---------------------------------------------------------------------------
// Application Launcher
// ---------------------------------------------------------------------------

const APP_LAUNCH_MAP: Record<string, () => void> = {
  chrome: () => launchDetached("cmd", ["/c", "start", "chrome"], { shell: true }),
  code: () => launchDetached("cmd", ["/c", "start", "code"], { shell: true }),
  antigravity: () => {
    const localApp = path.join(os.homedir(), "AppData", "Local", "Programs", "antigravity", "Antigravity.exe");
    if (fs.existsSync(localApp)) {
      launchDetached(localApp, []);
    } else {
      launchDetached("cmd", ["/c", "start", "antigravity"], { shell: true });
    }
  },
  powershell: () => launchDetached("cmd", ["/c", "start", "powershell"], { shell: true }),
  notepad: () => launchDetached("cmd", ["/c", "start", "notepad"], { shell: true }),
  explorer: () => launchDetached("cmd", ["/c", "start", "explorer"], { shell: true }),
  edge: () => launchDetached("cmd", ["/c", "start", "msedge"], { shell: true }),
  spotify: () => launchDetached("cmd", ["/c", "start", "spotify"], { shell: true }),
};

function openApp(appId: string): boolean {
  const launcher = APP_LAUNCH_MAP[appId.toLowerCase()];
  if (launcher) {
    launcher();
    return true;
  }
  // Generic fallback
  launchDetached("cmd", ["/c", "start", appId], { shell: true });
  return true;
}

/** Open a URL in the default browser or specific app */
function openUrl(url: string, appId?: string): void {
  if (appId === "chrome") {
    launchDetached("cmd", ["/c", "start", "chrome", url], { shell: true });
  } else if (appId === "edge") {
    launchDetached("cmd", ["/c", "start", "msedge", url], { shell: true });
  } else {
    // Default browser
    launchDetached("cmd", ["/c", "start", "", url], { shell: true });
  }
}

// ---------------------------------------------------------------------------
// Individual Step Executor
// ---------------------------------------------------------------------------

async function executeStep(
  step: ActionStep,
  intentId: string,
  stepIndex: number,
  totalSteps: number,
  currentApp?: string,
): Promise<{ success: boolean; message: string }> {
  console.log(`[JARVIS VOICE] Executing step ${stepIndex + 1}/${totalSteps}: ${step.description}`);

  switch (step.action) {
    case "open_or_focus": {
      const appId = step.target || "chrome";
      openApp(appId);
      // Wait for app to be ready
      await sleep(1200);
      updateVoiceContext({ currentApplication: appId, lastAction: "open_or_focus", lastTarget: appId });
      return { success: true, message: `Opened/focused ${step.target || appId}` };
    }

    case "open_url": {
      const url = step.url || step.target || "";
      if (!url) return { success: false, message: "No URL provided for open_url step" };
      openUrl(url, currentApp);
      await sleep(800);
      updateVoiceContext({ currentUrl: url, lastAction: "open_url", lastTarget: url });
      return { success: true, message: `Navigated to ${step.target || url}` };
    }

    case "search": {
      const searchUrl = step.url || "";
      if (searchUrl) {
        openUrl(searchUrl, currentApp);
        await sleep(600);
        updateVoiceContext({ currentUrl: searchUrl, lastAction: "search", lastTarget: step.query });
        return { success: true, message: `Searched for "${step.query}"` };
      }
      // Fallback: type the query and press Enter
      if (step.query) {
        await sleep(300);
        inputAutomation.handleKeyboardType({ text: step.query });
        await sleep(200);
        inputAutomation.handleKeyboardKey({ key: "Return", action: "press", modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
        updateVoiceContext({ lastAction: "search", lastTarget: step.query });
        return { success: true, message: `Typed and searched: "${step.query}"` };
      }
      return { success: false, message: "No search query provided" };
    }

    case "type": {
      const text = step.text || step.query || "";
      if (!text) return { success: false, message: "No text to type" };
      inputAutomation.handleKeyboardType({ text });
      updateVoiceContext({ lastAction: "type", lastTarget: text });
      return { success: true, message: `Typed: "${text}"` };
    }

    case "press_key": {
      const key = step.key || "Return";
      inputAutomation.handleKeyboardKey({ key, action: "press", modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
      return { success: true, message: `Pressed key: ${key}` };
    }

    case "navigate": {
      const url = step.url || step.target || "";
      if (!url) return { success: false, message: "No URL for navigate step" };
      openUrl(url, currentApp);
      await sleep(600);
      updateVoiceContext({ currentUrl: url, lastAction: "navigate", lastTarget: url });
      return { success: true, message: `Navigated to ${url}` };
    }

    case "command": {
      const cmd = step.text || "";
      if (!cmd) return { success: false, message: "No command to run" };
      try {
        const { stdout } = await execAsync(cmd, { timeout: 15000 });
        return { success: true, message: `Command executed: ${cmd}`, };
      } catch (err: any) {
        return { success: false, message: `Command failed: ${err.message}` };
      }
    }

    case "close_app": {
      const appId = step.target || "";
      try {
        await execAsync(`taskkill /IM ${appId}.exe /F`, { timeout: 5000 });
        updateVoiceContext({ currentApplication: null, lastAction: "close_app", lastTarget: appId });
        return { success: true, message: `Closed ${appId}` };
      } catch {
        return { success: false, message: `Could not close ${appId}` };
      }
    }

    case "paste": {
      inputAutomation.handleKeyboardKey({ key: "v", action: "press", modifiers: { ctrl: true, alt: false, shift: false, meta: false } });
      return { success: true, message: "Pasted from clipboard" };
    }

    case "scroll": {
      inputAutomation.handleMouseScroll({ deltaX: 0, deltaY: 3 });
      return { success: true, message: "Scrolled down" };
    }

    case "new_tab": {
      inputAutomation.handleKeyboardKey({ key: "t", action: "press", modifiers: { ctrl: true, alt: false, shift: false, meta: false } });
      await sleep(300);
      return { success: true, message: "Opened new tab" };
    }

    case "switch_tab": {
      inputAutomation.handleKeyboardKey({ key: "Tab", action: "press", modifiers: { ctrl: true, alt: false, shift: false, meta: false } });
      return { success: true, message: "Switched tab" };
    }

    case "go_back": {
      inputAutomation.handleKeyboardKey({ key: "Left", action: "press", modifiers: { ctrl: false, alt: true, shift: false, meta: false } });
      return { success: true, message: "Went back" };
    }

    case "go_forward": {
      inputAutomation.handleKeyboardKey({ key: "Right", action: "press", modifiers: { ctrl: false, alt: true, shift: false, meta: false } });
      return { success: true, message: "Went forward" };
    }

    default:
      return { success: false, message: `Unknown step action: ${(step as any).action}` };
  }
}

// ---------------------------------------------------------------------------
// Multi-Step Executor
// ---------------------------------------------------------------------------

async function executeSteps(
  intentId: string,
  steps: ActionStep[],
): Promise<VoiceExecutionResult> {
  const stepResults: VoiceExecutionResult["stepResults"] = [];
  let currentApp: string | undefined;
  const totalSteps = steps.length;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Track current app across steps
    if (step.action === "open_or_focus" && step.target) {
      currentApp = step.target;
    }

    const result = await executeStep(step, intentId, i, totalSteps, currentApp);
    stepResults.push({ stepIndex: i, action: step.action, ...result });

    if (!result.success) {
      const failedDescription = step.description;
      const succeededSteps = steps.slice(0, i).map((s) => s.description).join(", ");
      return {
        intentId,
        success: false,
        message: `Step ${i + 1}/${totalSteps} failed: ${result.message}` +
          (succeededSteps ? `. Completed: ${succeededSteps}` : ""),
        stepResults,
        timestamp: Date.now(),
      };
    }

    // Inter-step delay
    if (i < steps.length - 1) {
      await sleep(300);
    }
  }

  const allDescriptions = steps.map((s) => s.description).join(" → ");
  console.log(`[JARVIS VOICE] All ${totalSteps} steps completed successfully.`);

  return {
    intentId,
    success: true,
    message: `Completed: ${allDescriptions}`,
    stepResults,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Main Executor Class
// ---------------------------------------------------------------------------

export class AutomationExecutor {
  /**
   * Executes an approved voice command intent.
   * Supports multi-step plans (payload.steps[]) and legacy single-action intents.
   */
  public async executeIntent(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const now = Date.now();

    try {
      // ── Multi-step plan (new system) ───────────────────────────────────────
      if (Array.isArray(intent.payload?.steps) && intent.payload.steps.length > 0) {
        console.log(`[JARVIS VOICE] Executing ${intent.payload.steps.length}-step plan: ${intent.summary}`);
        return await executeSteps(intent.id, intent.payload.steps as ActionStep[]);
      }

      // ── Legacy single-action handlers ─────────────────────────────────────
      switch (intent.type) {
        case "OPEN_APP":
          return await this.handleOpenApp(intent);

        case "OPEN_PROJECT":
          return await this.handleOpenProject(intent);

        case "RUN_COMMAND":
          return await this.handleRunCommand(intent);

        case "INSTALL_EXTENSION":
          return await this.handleInstallExtension(intent);

        case "CODE_OPERATION":
          return await this.handleCodeOperation(intent);

        case "ANTIGRAVITY_PROMPT":
          return await this.handleAntigravityPrompt(intent);

        case "BROWSER_YOUTUBE":
          return await this.handleBrowserYouTube(intent);

        case "CLARIFICATION_NEEDED":
          return {
            intentId: intent.id,
            success: false,
            message: intent.summary,
            timestamp: now,
          };

        default:
          return {
            intentId: intent.id,
            success: false,
            message: `Unsupported command intent: ${intent.type}`,
            timestamp: now,
          };
      }
    } catch (err: any) {
      return {
        intentId: intent.id,
        success: false,
        message: `Execution failed: ${err.message}`,
        error: err.stack,
        timestamp: now,
      };
    }
  }

  // ── Legacy handlers (kept for backward compatibility) ─────────────────────

  private async handleOpenApp(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { appName, displayName } = intent.payload;
    openApp(appName || "explorer");
    updateVoiceContext({ currentApplication: appName, lastAction: "open_or_focus", lastTarget: appName });
    return {
      intentId: intent.id,
      success: true,
      message: `Launched ${displayName || appName} successfully.`,
      timestamp: Date.now(),
    };
  }

  private async handleOpenProject(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { projectName } = intent.payload;
    let targetPath = projectName;

    if (!path.isAbsolute(targetPath)) {
      const candidates = [
        path.join(process.cwd(), "..", targetPath),
        path.join("E:\\Project\\App", targetPath),
        path.join("E:\\Project", targetPath),
        path.join(os.homedir(), "Projects", targetPath),
        path.join(os.homedir(), "Desktop", targetPath),
        path.join(process.cwd(), targetPath),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { targetPath = candidate; break; }
      }
    }

    launchDetached("cmd", ["/c", "code", `"${targetPath}"`], { shell: true });
    return {
      intentId: intent.id,
      success: true,
      message: `Opened project in VS Code: ${targetPath}`,
      output: targetPath,
      timestamp: Date.now(),
    };
  }

  private async handleRunCommand(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { command } = intent.payload;
    return new Promise((resolve) => {
      exec(command, { cwd: process.cwd(), timeout: 15000 }, (error, stdout, stderr) => {
        resolve({
          intentId: intent.id,
          success: !error,
          message: error ? `Command failed: ${error.message}` : `Executed: ${command}`,
          output: stdout || stderr,
          error: error?.message,
          timestamp: Date.now(),
        });
      });
    });
  }

  private async handleInstallExtension(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { extensionId } = intent.payload;
    return new Promise((resolve) => {
      exec(`code --install-extension ${extensionId}`, { timeout: 30000 }, (error, stdout, stderr) => {
        resolve({
          intentId: intent.id,
          success: !error,
          message: error
            ? `Failed to install extension "${extensionId}": ${error.message}`
            : `Installed VS Code extension: "${extensionId}"`,
          output: stdout,
          error: error?.message || stderr,
          timestamp: Date.now(),
        });
      });
    });
  }

  private async handleCodeOperation(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { operation, path: targetPath } = intent.payload;
    const resolved = path.resolve(process.cwd(), targetPath);

    if (operation === "delete") {
      if (!fs.existsSync(resolved)) {
        return { intentId: intent.id, success: false, message: `Path not found: ${resolved}`, timestamp: Date.now() };
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      return { intentId: intent.id, success: true, message: `Deleted: ${resolved}`, timestamp: Date.now() };
    }

    return { intentId: intent.id, success: false, message: `Unsupported operation: ${operation}`, timestamp: Date.now() };
  }

  private async handleAntigravityPrompt(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { prompt } = intent.payload;
    inputAutomation.handleKeyboardType({ text: prompt });
    inputAutomation.handleKeyboardKey({ key: "Return", action: "press", modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
    return {
      intentId: intent.id,
      success: true,
      message: `Injected prompt: "${prompt}"`,
      timestamp: Date.now(),
    };
  }

  private async handleBrowserYouTube(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { url } = intent.payload;
    if (!url) {
      return { intentId: intent.id, success: false, message: "No URL for YouTube intent", timestamp: Date.now() };
    }
    openUrl(url, "chrome");
    updateVoiceContext({ currentApplication: "chrome", currentUrl: url, lastAction: "open_url", lastTarget: url });
    return {
      intentId: intent.id,
      success: true,
      message: `Opened YouTube: ${url}`,
      output: url,
      timestamp: Date.now(),
    };
  }
}

export const automationExecutor = new AutomationExecutor();
