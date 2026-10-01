import { io, Socket } from "socket.io-client";
import { getSocketUrl, resolveHostApiUrl } from "./env";

let socketInstance: Socket | null = null;

export interface SocketAuthOptions {
  isHost?: boolean;
  token?: string;
  /** Required whenever isHost is true; issued by the Host Agent to loopback callers. */
  hostCredential?: string;
}

export function getSocket(serverUrl?: string, options?: SocketAuthOptions): Socket {
  if (socketInstance && socketInstance.connected) {
    return socketInstance;
  }

  const url = serverUrl ? resolveHostApiUrl(serverUrl) : getSocketUrl();

  if (socketInstance) {
    socketInstance.disconnect();
  }

  socketInstance = io(url, {
    auth: {
      isHost: options?.isHost || false,
      token: options?.token || "",
      hostCredential: options?.hostCredential || "",
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
    socketInstance.disconnect();
    socketInstance = null;
  }
}
