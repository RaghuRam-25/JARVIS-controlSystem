import { io, Socket } from "socket.io-client";
import { getSocketUrl, resolveHostApiUrl } from "./env";

let socketInstance: Socket | null = null;

export interface SocketAuthOptions {
  isHost?: boolean;
  token?: string;
  /** Required whenever isHost is true; issued by the Host Agent to loopback callers. */
  hostCredential?: string;
}

export function getSocket(serverUrl?: string, options?: SocketAuthOptions, forceReconnect = false): Socket {
  const url = serverUrl ? resolveHostApiUrl(serverUrl) : getSocketUrl();
  const token = options?.token || "";
  const hostCredential = options?.hostCredential || "";
  const isHost = options?.isHost || false;

  const currentAuth = (socketInstance?.auth || {}) as Record<string, unknown>;
  const authMatches =
    currentAuth.token === token &&
    currentAuth.hostCredential === hostCredential &&
    currentAuth.isHost === isHost;

  if (socketInstance && socketInstance.connected && authMatches && !forceReconnect) {
    return socketInstance;
  }

  if (socketInstance) {
    try {
      socketInstance.removeAllListeners();
      socketInstance.disconnect();
    } catch {}
    socketInstance = null;
  }

  socketInstance = io(url, {
    auth: {
      isHost,
      token,
      hostCredential,
    },
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  return socketInstance;
}

export function disconnectSocket() {
  if (socketInstance) {
    try {
      socketInstance.removeAllListeners();
      socketInstance.disconnect();
    } catch {}
    socketInstance = null;
  }
}
