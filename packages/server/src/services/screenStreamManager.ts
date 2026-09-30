import EventEmitter from "events";
import { WebRTCSignal } from "@jarvis/shared";

export class ScreenStreamManager extends EventEmitter {
  private hostSocketId: string | null = null;
  private viewerSocketIds = new Set<string>();

  public registerHost(socketId: string) {
    this.hostSocketId = socketId;
    this.emit("host_connected", socketId);
  }

  public unregisterHost(socketId: string) {
    if (this.hostSocketId === socketId) {
      this.hostSocketId = null;
      this.emit("host_disconnected");
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

  public getHostSocketId(): string | null {
    return this.hostSocketId;
  }

  public getViewers(): string[] {
    return Array.from(this.viewerSocketIds);
  }
}

export const screenStreamManager = new ScreenStreamManager();
