import { contextBridge, ipcRenderer } from "electron";

// Secure context bridge for Host UI inside Windows Electron Shell
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,

  // Host Window Controls
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),

  // Host System Information
  getHostInfo: () => ipcRenderer.invoke("host:get_info"),

  // Desktop Screen Capturer Sources (for WebRTC high-performance display stream)
  getScreenSources: () => ipcRenderer.invoke("host:get_screen_sources"),

  // Security Emergency Kill Switch
  emergencyRevokeAll: () => ipcRenderer.invoke("host:emergency_revoke_all"),

  // Listeners for native push notifications / host approval alerts
  onPairingAlert: (callback: (data: any) => void) => {
    const subscription = (_event: any, value: any) => callback(value);
    ipcRenderer.on("pairing:alert", subscription);
    return () => ipcRenderer.removeListener("pairing:alert", subscription);
  },
});
