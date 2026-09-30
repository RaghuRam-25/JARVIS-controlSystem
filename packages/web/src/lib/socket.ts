import { io, Socket } from "socket.io-client";
import { getSocketUrl, resolveHostApiUrl } from "./env";

let socketInstance: Socket | null = null;

export function getSocket(serverUrl?: string, options?: { isHost?: boolean; token?: string }): Socket {
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
    },
    transports: ["websocket", "polling"],
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
