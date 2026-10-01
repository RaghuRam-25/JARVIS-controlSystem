import EventEmitter from "events";
import { WebRTCSignal } from "@jarvis/shared";

export class ScreenStreamManager extends EventEmitter {
  private hostUiSockets = new Set<string>();
  private hostAgentSockets = new Set<string>();
  private viewerSocketIds = new Set<string>();

  public registerHost(socketId: string, isAgent: boolean = false) {
    if (isAgent) {
      this.hostAgentSockets.add(socketId);
    } else {
      this.hostUiSockets.add(socketId);
    }
    this.emit("host_connected", socketId, isAgent);
  }

  public unregisterHost(socketId: string) {
    const wasUi = this.hostUiSockets.delete(socketId);
    const wasAgent = this.hostAgentSockets.delete(socketId);
    if (wasUi || wasAgent) {
      this.emit("host_disconnected", socketId);
    }
  }

  public registerViewer(socketId: string) {
    this.viewerSocketIds.add(socketId);
    this.emit("viewer_connected", socketId);
  }

  public unregisterViewer(socketId: string) {
    this.viewerSocketIds.delete(socketId);
    this.emit("viewer_disconnected", socketId);
  }

  /**
   * Returns the primary Host UI socket ID (the browser screen broadcaster) if available,
   * or a Host Agent socket ID as fallback.
   */
  public getHostSocketId(): string | null {
    if (this.hostUiSockets.size > 0) {
      return Array.from(this.hostUiSockets)[0];
    }
    if (this.hostAgentSockets.size > 0) {
      return Array.from(this.hostAgentSockets)[0];
    }
    return null;
  }

  public getHostUiSockets(): string[] {
    return Array.from(this.hostUiSockets);
  }

  public getViewers(): string[] {
    return Array.from(this.viewerSocketIds);
  }
}

export const screenStreamManager = new ScreenStreamManager();
