import { app, BrowserWindow, ipcMain, desktopCapturer } from "electron";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawn, ChildProcess } from "child_process";
import dotenv from "dotenv";

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

const IS_PACKAGED = app.isPackaged;

/** Walks up from the given dir looking for the monorepo root `.env`. */
function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envFile = findEnvFile(__dirname);
if (envFile) {
  dotenv.config({ path: envFile, override: false });
}

const API_PORT = parseInt(process.env.PORT || "4000", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "3000", 10);
const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;

/** Host UI URL: WEB_URL wins, otherwise built from WEB_PORT. */
const HOST_UI_URL = process.env.WEB_URL || `http://localhost:${WEB_PORT}/?mode=host`;

/**
 * Resolves the path to the server entry point.
 * In development: ../../server/dist/server.js (relative to desktop/dist/)
 * In production:  process.resourcesPath/server/dist/server.js (extraResources)
 */
function getServerEntryPath(): string {
  if (IS_PACKAGED) {
    return path.join(process.resourcesPath, "server", "dist", "server.js");
  }
  return path.join(__dirname, "..", "..", "server", "dist", "server.js");
}

// Checks if local backend is running on the configured API port
function checkBackendHealth(port: number = API_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${API_BASE_URL}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureBackendServer() {
  const isRunning = await checkBackendHealth();
  if (!isRunning) {
    console.log("[JARVIS Host] Starting local backend server process...");
    const serverEntry = getServerEntryPath();
    console.log("[JARVIS Host] Server entry path:", serverEntry);

    try {
      serverProcess = spawn("node", [serverEntry], {
        detached: false,
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: String(API_PORT),
          HOST_NAME: process.env.HOST_NAME || os.hostname(),
          NODE_ENV: process.env.NODE_ENV || (IS_PACKAGED ? "production" : "development"),
        },
      });

      serverProcess.on("error", (err) => {
        console.warn("[JARVIS Host] Could not spawn local server script:", err.message);
      });

      serverProcess.on("exit", (code, signal) => {
        console.log(`[JARVIS Host] Server process exited with code ${code}, signal ${signal}`);
        serverProcess = null;
      });

      // Wait briefly for server to initialize
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (e) {
      console.warn("[JARVIS Host] Failed to auto-launch backend server:", e);
    }
  } else {
    console.log(`[JARVIS Host] Local backend server is already active on port ${API_PORT}.`);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 640,
    title: "JARVIS — Windows Host PC",
    icon: iconPath,
    backgroundColor: "#070a13",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for desktopCapturer preload access
      webSecurity: true,
    },
  });

  let retryCount = 0;
  const maxRetries = 10;

  const loadHostPage = () => {
    mainWindow?.loadURL(HOST_UI_URL).catch(() => {
      retryCount++;
      if (retryCount <= maxRetries) {
        console.log(`[JARVIS Host] Web UI not ready, retrying (${retryCount}/${maxRetries})...`);
        mainWindow?.loadURL(
          `data:text/html,<html><body style='background:%23070a13;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;'>` +
          `<h2 style='color:%2300e5ff'>JARVIS Host PC Shell</h2>` +
          `<p style='color:%238b949e'>Connecting to local UI on port ${WEB_PORT}... (Attempt ${retryCount}/${maxRetries})</p>` +
          `<script>setTimeout(()=>window.location.reload(), 2000)</script></body></html>`
        );
      } else {
        mainWindow?.loadURL(
          `data:text/html,<html><body style='background:%23070a13;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;'>` +
          `<h2 style='color:%23ff5252'>Connection Failed</h2>` +
          `<p style='color:%238b949e'>Could not connect to JARVIS Web UI. Make sure the web server is running on port ${WEB_PORT}.</p>` +
          `<button onclick='window.location.reload()' style='margin-top:16px;padding:12px 24px;background:%2300e5ff;color:%23070a13;border:none;border-radius:8px;font-weight:bold;cursor:pointer;font-size:14px;'>Retry</button></body></html>`
        );
      }
    });
  };

  loadHostPage();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC Handlers
ipcMain.handle("host:get_info", () => {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: os.arch(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    cpus: os.cpus().length,
    isPackaged: IS_PACKAGED,
    version: app.getVersion(),
  };
});

ipcMain.handle("host:get_screen_sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle("host:emergency_revoke_all", async () => {
  // Forward emergency kill to server via HTTP
  try {
    const res = await fetch(`${API_BASE_URL}/api/pairing/revoke-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return { success: res.ok };
  } catch {
    return { success: false, error: "Server unreachable" };
  }
});

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:maximize", () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on("window:close", () => mainWindow?.close());

app.whenReady().then(async () => {
  await ensureBackendServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Ensure clean shutdown
app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {}
  }
});