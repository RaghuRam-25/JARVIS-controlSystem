import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import EventEmitter from "events";
import fs from "fs";
import path from "path";
import { generateUUID, TerminalSpawn, TerminalResize } from "@jarvis/shared";

export interface TerminalInstance {
  sessionId: string;
  shell: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  cols: number;
  rows: number;
  createdAt: number;
  /** Socket that owns this session; only it may write/resize/kill. */
  ownerSocketId?: string;
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, TerminalInstance>();

  /**
   * Resolves the working directory for a new shell.
   *
   * A client-supplied cwd is only honoured when it is an existing directory
   * inside the Host Agent's working tree. Anything else (traversal sequences,
   * system directories, missing paths) falls back to the server cwd so a remote
   * session cannot spawn a shell in an arbitrary location.
   */
  private resolveSafeCwd(requested?: string): string {
    const fallback = process.cwd();
    if (!requested) return fallback;

    try {
      const resolved = path.resolve(requested);
      const root = path.resolve(fallback);

      const withinRoot = resolved === root || resolved.startsWith(root + path.sep);
      if (!withinRoot) {
        return fallback;
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return fallback;
      }
      return resolved;
    } catch {
      return fallback;
    }
  }

  /**
   * Spawns an interactive Windows PowerShell / CMD terminal session
   */
  public createSession(options: Partial<TerminalSpawn> = {}, ownerSocketId?: string): TerminalInstance {
    const sessionId = options.sessionId || generateUUID();
    const defaultShell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "bash");
    const shell = options.shell || defaultShell;
    const cwd = this.resolveSafeCwd(options.cwd);
    const cols = options.cols || 100;
    const rows = options.rows || 30;

    // Launch PowerShell with interactive flags and UTF-8 encoding.
    // A single quote inside the path would terminate the PowerShell literal,
    // so it is doubled before interpolation.
    const safeCwd = cwd.replace(/'/g, "''");
    const args = shell.includes("powershell")
      ? ["-NoLogo", "-NoExit", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location '${safeCwd}'; Clear-Host`]
      : [];

    const proc = spawn(shell, args, {
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
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
      ...(ownerSocketId ? { ownerSocketId } : {}),
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
   * Writes user keystrokes/data to terminal stdin.
   * When ownerSocketId is supplied the caller must own the session.
   */
  public write(sessionId: string, data: string, ownerSocketId?: string): boolean {
    const instance = this.sessions.get(sessionId);
    if (!instance) return false;
    if (ownerSocketId !== undefined && instance.ownerSocketId !== ownerSocketId) {
      return false;
    }
    if (instance.process.stdin.destroyed) {
      return false;
    }
    instance.process.stdin.write(data);
    return true;
  }

  /**
   * Resizes terminal dimensions
   */
  public resize(data: TerminalResize, ownerSocketId?: string): boolean {
    const instance = this.sessions.get(data.sessionId);
    if (!instance) return false;
    if (ownerSocketId !== undefined && instance.ownerSocketId !== ownerSocketId) {
      return false;
    }
    instance.cols = data.cols;
    instance.rows = data.rows;
    // On Windows PowerShell, we can adjust buffer width if needed
    if (instance.shell.includes("powershell") && !instance.process.stdin.destroyed) {
      instance.process.stdin.write(`$Host.UI.RawUI.BufferSize = New-Object Management.Automation.Host.Size(${Math.floor(data.cols)}, ${Math.max(Math.floor(data.rows), 300)});\n`);
    }
    return true;
  }

  /**
   * Kills the terminal session and child processes
   */
  public kill(sessionId: string, ownerSocketId?: string): boolean {
    const instance = this.sessions.get(sessionId);
    if (!instance) return false;
    if (ownerSocketId !== undefined && instance.ownerSocketId !== ownerSocketId) {
      return false;
    }

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
