import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import EventEmitter from "events";
import { generateUUID, TerminalSpawn, TerminalResize } from "@jarvis/shared";

export interface TerminalInstance {
  sessionId: string;
  shell: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  cols: number;
  rows: number;
  createdAt: number;
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, TerminalInstance>();

  /**
   * Spawns an interactive Windows PowerShell / CMD terminal session
   */
  public createSession(options: Partial<TerminalSpawn> = {}): TerminalInstance {
    const sessionId = options.sessionId || generateUUID();
    const shell = options.shell || "powershell.exe";
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 100;
    const rows = options.rows || 30;

    // Launch PowerShell with interactive flags and UTF-8 encoding
    const args = shell.includes("powershell") 
      ? ["-NoLogo", "-NoExit", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location '${cwd}'; Clear-Host`]
      : [];

    const proc = spawn(shell, args, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
        ...(options.env || {}),
      },
    });

    const instance: TerminalInstance = {
      sessionId,
      shell,
      cwd,
      process: proc,
      cols,
      rows,
      createdAt: Date.now(),
    };

    proc.stdout.on("data", (data: Buffer) => {
      this.emit("data", { sessionId, data: data.toString("utf-8") });
    });

    proc.stderr.on("data", (data: Buffer) => {
      this.emit("data", { sessionId, data: data.toString("utf-8") });
    });

    proc.on("exit", (code, signal) => {
      this.emit("exit", { sessionId, code, signal });
      this.sessions.delete(sessionId);
    });

    proc.on("error", (err) => {
      this.emit("error", { sessionId, error: err.message });
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, instance);
    return instance;
  }

  /**
   * Writes user keystrokes/data to terminal stdin
   */
  public write(sessionId: string, data: string): boolean {
    const instance = this.sessions.get(sessionId);
    if (!instance || instance.process.stdin.destroyed) {
      return false;
    }
    instance.process.stdin.write(data);
    return true;
  }

  /**
   * Resizes terminal dimensions
   */
  public resize(data: TerminalResize): boolean {
    const instance = this.sessions.get(data.sessionId);
    if (!instance) return false;
    instance.cols = data.cols;
    instance.rows = data.rows;
    // On Windows PowerShell, we can adjust buffer width if needed
    if (instance.shell.includes("powershell") && !instance.process.stdin.destroyed) {
      instance.process.stdin.write(`$Host.UI.RawUI.BufferSize = New-Object Management.Automation.Host.Size(${data.cols}, ${Math.max(data.rows, 300)});\n`);
    }
    return true;
  }

  /**
   * Kills the terminal session and child processes
   */
  public kill(sessionId: string): boolean {
    const instance = this.sessions.get(sessionId);
    if (!instance) return false;

    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", instance.process.pid?.toString() || "", "/f", "/t"]);
      } else {
        instance.process.kill("SIGKILL");
      }
    } catch {}

    this.sessions.delete(sessionId);
    return true;
  }

  public killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }
}

export const terminalManager = new TerminalManager();
