import { spawn, exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { VoiceCommandIntent, VoiceExecutionResult } from "@jarvis/shared";
import { terminalManager } from "./terminalManager.js";
import { inputAutomation } from "./inputAutomation.js";

export class AutomationExecutor {
  /**
   * Executes an approved voice command intent
   */
  public async executeIntent(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const now = Date.now();

    try {
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

  private async handleOpenApp(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { appName, displayName } = intent.payload;
    
    if (appName === "code") {
      spawn("cmd", ["/c", "start", "code"], { detached: true, stdio: "ignore" });
      return {
        intentId: intent.id,
        success: true,
        message: `Launched ${displayName || "VS Code"} successfully.`,
        timestamp: Date.now(),
      };
    }

    if (appName === "antigravity") {
      // Look for Antigravity executable or launch via command
      spawn("cmd", ["/c", "start", "antigravity"], { detached: true, stdio: "ignore" }).on("error", () => {
        // Fallback to searching user profile
        const localApp = path.join(os.homedir(), "AppData", "Local", "Programs", "antigravity", "Antigravity.exe");
        if (fs.existsSync(localApp)) {
          spawn(localApp, [], { detached: true, stdio: "ignore" });
        }
      });
      return {
        intentId: intent.id,
        success: true,
        message: "Initiated Antigravity launch request.",
        timestamp: Date.now(),
      };
    }

    // Generic Windows launcher
    spawn("cmd", ["/c", "start", appName], { detached: true, stdio: "ignore" });
    return {
      intentId: intent.id,
      success: true,
      message: `Launched ${displayName || appName}.`,
      timestamp: Date.now(),
    };
  }

  private async handleOpenProject(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { projectName } = intent.payload;
    let targetPath = projectName;

    // Search for common directories if not an absolute path
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
        if (fs.existsSync(candidate)) {
          targetPath = candidate;
          break;
        }
      }
    }

    if (fs.existsSync(targetPath)) {
      spawn("cmd", ["/c", "code", `"${targetPath}"`], { detached: true, stdio: "ignore", shell: true });
      return {
        intentId: intent.id,
        success: true,
        message: `Opened project in VS Code: ${targetPath}`,
        output: targetPath,
        timestamp: Date.now(),
      };
    }

    // Try opening as named folder
    spawn("cmd", ["/c", "code", `"${projectName}"`], { detached: true, stdio: "ignore", shell: true });
    return {
      intentId: intent.id,
      success: true,
      message: `Dispatched open request for "${projectName}" to VS Code.`,
      timestamp: Date.now(),
    };
  }

  private async handleRunCommand(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { command, shell } = intent.payload;
    
    // Create interactive terminal session or run directly
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
        if (error) {
          resolve({
            intentId: intent.id,
            success: false,
            message: `Failed to install extension "${extensionId}": ${error.message}`,
            error: stderr || error.message,
            timestamp: Date.now(),
          });
        } else {
          resolve({
            intentId: intent.id,
            success: true,
            message: `Successfully installed VS Code extension: "${extensionId}"`,
            output: stdout,
            timestamp: Date.now(),
          });
        }
      });
    });
  }

  private async handleCodeOperation(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { operation, path: targetPath } = intent.payload;
    const resolved = path.resolve(process.cwd(), targetPath);

    if (operation === "delete") {
      if (!fs.existsSync(resolved)) {
        return {
          intentId: intent.id,
          success: false,
          message: `Target path does not exist: ${resolved}`,
          timestamp: Date.now(),
        };
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }

      return {
        intentId: intent.id,
        success: true,
        message: `Successfully deleted: ${resolved}`,
        timestamp: Date.now(),
      };
    }

    return {
      intentId: intent.id,
      success: false,
      message: `Unsupported code operation: ${operation}`,
      timestamp: Date.now(),
    };
  }

  private async handleAntigravityPrompt(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { prompt } = intent.payload;

    // Desktop UI Automation Warning: Antigravity UI automation can break when its UI changes.
    // We attempt window activation + paste, and provide feedback
    inputAutomation.handleKeyboardType({ text: prompt });
    inputAutomation.handleKeyboardKey({ key: "Enter", action: "press", modifiers: { ctrl: false, alt: false, shift: false, meta: false } });

    return {
      intentId: intent.id,
      success: true,
      message: `Injected prompt into active window: "${prompt}" (Note: UI automation can vary if focus changes).`,
      timestamp: Date.now(),
    };
  }

  private async handleBrowserYouTube(intent: VoiceCommandIntent): Promise<VoiceExecutionResult> {
    const { url } = intent.payload;
    
    // Launch default browser to YouTube search/video
    spawn("cmd", ["/c", "start", `"${url}"`], { detached: true, stdio: "ignore", shell: true });

    return {
      intentId: intent.id,
      success: true,
      message: `Opened YouTube in browser: ${url}`,
      output: url,
      timestamp: Date.now(),
    };
  }
}

export const automationExecutor = new AutomationExecutor();
