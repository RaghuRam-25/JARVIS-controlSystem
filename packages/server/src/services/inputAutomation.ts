import { spawn, execSync } from "child_process";
import { MouseMove, MouseClick, MouseButtonAction, MouseScroll, KeyboardKey, KeyboardType } from "@jarvis/shared";

export interface DisplayMetrics {
  width: number;
  height: number;
  scaleFactor: number;
}

const ALLOWED_MOUSE_BUTTONS = new Set(["left", "right", "middle"]);

export class InputAutomationService {
  private displayMetrics: DisplayMetrics = { width: 1920, height: 1080, scaleFactor: 1 };
  private psProcess: any = null;
  private currentMouseX = 960;
  private currentMouseY = 540;

  constructor() {
    this.detectScreenMetrics();
    this.initFastInputProcess();
  }

  /**
   * Detects Windows primary screen resolution
   */
  public detectScreenMetrics(): DisplayMetrics {
    if (process.platform !== "win32") {
      this.displayMetrics = { width: 1920, height: 1080, scaleFactor: 1 };
      this.currentMouseX = 960;
      this.currentMouseY = 540;
      return this.displayMetrics;
    }
    try {
      const output = execSync(
        `powershell -NoProfile -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \\"$($s.Width),$($s.Height)\\""`,
        { encoding: "utf-8", timeout: 3000 }
      );
      const parts = output.trim().split(",");
      if (parts.length === 2) {
        const width = parseInt(parts[0], 10);
        const height = parseInt(parts[1], 10);
        if (width > 0 && height > 0) {
          this.displayMetrics = { width, height, scaleFactor: 1 };
          this.currentMouseX = Math.floor(width / 2);
          this.currentMouseY = Math.floor(height / 2);
        }
      }
    } catch {
      // Default fallback
      this.displayMetrics = { width: 1920, height: 1080, scaleFactor: 1 };
    }
    return this.displayMetrics;
  }

  public getMetrics(): DisplayMetrics {
    return this.displayMetrics;
  }

  /**
   * Persistent PowerShell session compiled with User32.dll SendInput for instant 0ms latency
   */
  private initFastInputProcess() {
    if (process.platform !== "win32") {
      return;
    }

    const csharpCode = `
      using System;
      using System.Runtime.InteropServices;

      public class WinInput {
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const int MOUSEEVENTF_LEFTUP = 0x0004;
        public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const int MOUSEEVENTF_RIGHTUP = 0x0010;
        public const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const int MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const int MOUSEEVENTF_WHEEL = 0x0800;
        public const int KEYEVENTF_KEYUP = 0x0002;

        public static void Move(int x, int y) {
          SetCursorPos(x, y);
        }

        public static void Click(string btn, bool isDouble) {
          int down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
          if (btn == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
          else if (btn == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
          
          mouse_event(down, 0, 0, 0, 0);
          mouse_event(up, 0, 0, 0, 0);
          if (isDouble) {
            System.Threading.Thread.Sleep(50);
            mouse_event(down, 0, 0, 0, 0);
            mouse_event(up, 0, 0, 0, 0);
          }
        }

        public static void Button(string btn, string action) {
          int flag = 0;
          if (btn == "left") flag = action == "down" ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
          else if (btn == "right") flag = action == "down" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
          else if (btn == "middle") flag = action == "down" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
          if (flag != 0) mouse_event(flag, 0, 0, 0, 0);
        }

        public static void Scroll(int dy) {
          mouse_event(MOUSEEVENTF_WHEEL, 0, 0, dy, 0);
        }
      }
    `;

    try {
      this.psProcess = spawn("powershell", ["-NoProfile", "-Command", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.psProcess.on("error", (err: any) => {
        console.warn("PowerShell input process notice:", err.message);
        this.psProcess = null;
      });

      const setupScript = `
        Add-Type -TypeDefinition @"
        ${csharpCode}
        "@
        Write-Output "READY"
      \n`;

      if (this.psProcess.stdin && !this.psProcess.stdin.destroyed) {
        this.psProcess.stdin.write(setupScript);
        this.psProcess.stdin.uncork();
      }
    } catch (err) {
      console.warn("Failed to spawn persistent input process:", err);
      this.psProcess = null;
    }
  }

  private sendCommand(cmd: string) {
    if (this.psProcess && this.psProcess.stdin && !this.psProcess.stdin.destroyed) {
      try {
        this.psProcess.stdin.write(cmd + "\n");
      } catch {
        this.initFastInputProcess();
      }
    }
  }

  /**
   * Remote Mouse Move (Scales normalized 0..1 coordinates to display pixels or applies trackpad deltas)
   */
  public handleMouseMove(data: Partial<MouseMove>) {
    let targetX = this.currentMouseX;
    let targetY = this.currentMouseY;

    if (data.isRelative && data.deltaX !== undefined && data.deltaY !== undefined) {
      // Trackpad mode
      const sensitivity = 1.25;
      targetX = Math.max(0, Math.min(this.displayMetrics.width, this.currentMouseX + data.deltaX * sensitivity));
      targetY = Math.max(0, Math.min(this.displayMetrics.height, this.currentMouseY + data.deltaY * sensitivity));
    } else if (data.normalizedX !== undefined && data.normalizedY !== undefined) {
      // Screen tap / touch mirror mode (scaling coordinate)
      targetX = Math.round(data.normalizedX * this.displayMetrics.width);
      targetY = Math.round(data.normalizedY * this.displayMetrics.height);
    } else if (data.absX !== undefined && data.absY !== undefined) {
      targetX = data.absX;
      targetY = data.absY;
    }

    this.currentMouseX = targetX;
    this.currentMouseY = targetY;

    this.sendCommand(`[WinInput]::Move(${Math.round(targetX)}, ${Math.round(targetY)})`);
  }

  /**
   * Remote Mouse Click
   */
  public handleMouseClick(data: MouseClick) {
    if (data.normalizedX !== undefined && data.normalizedY !== undefined) {
      this.handleMouseMove({ normalizedX: data.normalizedX, normalizedY: data.normalizedY, isRelative: false });
    }
    const isDouble = Boolean(data.double);
    const btn = ALLOWED_MOUSE_BUTTONS.has(data.button) ? data.button : "left";
    this.sendCommand(`[WinInput]::Click('${btn}', ${isDouble ? "$true" : "$false"})`);
  }

  /**
   * Remote Mouse Down / Up (Drag & Drop)
   */
  public handleMouseButtonAction(data: MouseButtonAction) {
    if (data.normalizedX !== undefined && data.normalizedY !== undefined) {
      this.handleMouseMove({ normalizedX: data.normalizedX, normalizedY: data.normalizedY, isRelative: false });
    }
    const btn = ALLOWED_MOUSE_BUTTONS.has(data.button) ? data.button : "left";
    const action = data.action === "down" ? "down" : "up";
    this.sendCommand(`[WinInput]::Button('${btn}', '${action}')`);
  }

  /**
   * Remote Mouse Wheel Scroll
   */
  public handleMouseScroll(data: MouseScroll) {
    const scrollAmount = -Math.round(data.deltaY * 3);
    this.sendCommand(`[WinInput]::Scroll(${scrollAmount})`);
  }

  /**
   * Remote Keyboard Type text
   */
  public handleKeyboardType(data: KeyboardType) {
    if (!data.text) return;
    // SendKeys escaping: braces are token syntax and quotes/backticks terminate
    // the PowerShell string literal, so all of them must be neutralized.
    const escaped = this.escapeForSendKeys(data.text);
    this.sendCommand(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`
    );
  }

  /**
   * Escapes untrusted text for embedding inside a single-quoted PowerShell
   * literal that is then passed to SendKeys.
   *
   * Order matters: PowerShell escapes the quote first, then SendKeys braces.
   */
  private escapeForSendKeys(text: string): string {
    return text
      .replace(/'/g, "''")
      .replace(/[{}\[\]()+^%~]/g, (match) => `{${match}}`)
      .replace(/\r/g, "{ENTER}")
      .replace(/\n/g, "{ENTER}")
      .replace(/\t/g, "{TAB}");
  }

  /**
   * Remote Key Action (Special keys like Enter, Backspace, Esc, Shortcuts)
   *
   * Only keys in the allow-list below can be emitted. The incoming `key` value
   * is attacker-controlled, and it is written into a PowerShell command line, so
   * accepting arbitrary text would allow arbitrary command execution.
   */
  public handleKeyboardKey(data: KeyboardKey) {
    const keyMap: Record<string, string> = {
      Enter: "{ENTER}",
      Backspace: "{BACKSPACE}",
      Tab: "{TAB}",
      Escape: "{ESC}",
      Esc: "{ESC}",
      ArrowUp: "{UP}",
      ArrowDown: "{DOWN}",
      ArrowLeft: "{LEFT}",
      ArrowRight: "{RIGHT}",
      Delete: "{DELETE}",
      Home: "{HOME}",
      End: "{END}",
      PageUp: "{PGUP}",
      PageDown: "{PGDN}",
      Space: " ",
    };

    const modifierMap: Record<string, string> = {
      Ctrl: "^",
      Control: "^",
      Alt: "%",
      Shift: "+",
      Meta: "%",
      Win: "^",
    };

    const sendKeyStr = keyMap[data.key] || modifierMap[data.key];
    if (!sendKeyStr) {
      return;
    }

    let prefix = "";
    if (data.modifiers) {
      if (data.modifiers.ctrl) prefix += "^";
      if (data.modifiers.shift) prefix += "+";
      if (data.modifiers.alt) prefix += "%";
    }

    this.sendCommand(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${sendKeyStr}')`
    );
  }

  public cleanup() {
    if (this.psProcess) {
      try {
        this.psProcess.stdin.end();
        this.psProcess.kill();
      } catch {}
    }
  }
}

export const inputAutomation = new InputAutomationService();
