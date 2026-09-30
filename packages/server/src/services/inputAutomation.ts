import { spawn, execSync } from "child_process";
import { MouseMove, MouseClick, MouseButtonAction, MouseScroll, KeyboardKey, KeyboardType } from "@jarvis/shared";

export interface DisplayMetrics {
  width: number;
  height: number;
  scaleFactor: number;
}

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

      const setupScript = `
        Add-Type -TypeDefinition @"
        ${csharpCode}
        "@
        Write-Output "READY"
      \n`;

      this.psProcess.stdin.write(setupScript);
      this.psProcess.stdin.uncork();
    } catch (err) {
      console.warn("Failed to spawn persistent input process:", err);
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
    const btn = data.button || "left";
    this.sendCommand(`[WinInput]::Click('${btn}', $${isDouble ? "true" : "false"})`);
  }

  /**
   * Remote Mouse Down / Up (Drag & Drop)
   */
  public handleMouseButtonAction(data: MouseButtonAction) {
    if (data.normalizedX !== undefined && data.normalizedY !== undefined) {
      this.handleMouseMove({ normalizedX: data.normalizedX, normalizedY: data.normalizedY, isRelative: false });
    }
    this.sendCommand(`[WinInput]::Button('${data.button}', '${data.action}')`);
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
    // Escape special chars for PowerShell SendKeys
    const escaped = data.text
      .replace(/[\{\}\(\)\+\^\%\[\]\~]/g, "{$&}")
      .replace(/"/g, '`"');
    this.sendCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped}")`);
  }

  /**
   * Remote Key Action (Special keys like Enter, Backspace, Esc, Shortcuts)
   */
  public handleKeyboardKey(data: KeyboardKey) {
    const keyMap: Record<string, string> = {
      Enter: "{ENTER}",
      Backspace: "{BACKSPACE}",
      Tab: "{TAB}",
      Escape: "{ESC}",
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

    let sendKeyStr = keyMap[data.key] || data.key;
    if (data.modifiers) {
      let prefix = "";
      if (data.modifiers.ctrl) prefix += "^";
      if (data.modifiers.shift) prefix += "+";
      if (data.modifiers.alt) prefix += "%";
      sendKeyStr = prefix + sendKeyStr;
    }

    if (data.action === "press" || data.action === "down") {
      this.sendCommand(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${sendKeyStr}")`);
    }
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
