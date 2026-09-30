import http from "http";
import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import { CONFIG } from "./config.js";
import { apiRouter } from "./routes/api.js";
import { setupSocketHandlers } from "./socket/socketHandler.js";
import { getPrimaryLocalIp, getLocalIpAddresses } from "./services/lan.js";

const app = express();
const server = http.createServer(app);

// Dynamic CORS configuration for local Wi-Fi, PWA, and Cloud deployment
const corsOrigins = CONFIG.CORS_ORIGIN === "*" 
  ? "*" 
  : CONFIG.CORS_ORIGIN.split(",").map((s) => s.trim());

app.use(cors({
  origin: corsOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// Mount API routes
app.use(apiRouter);

// Socket.IO Server
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
  },
  pingTimeout: 10000,
  pingInterval: 5000,
  maxHttpBufferSize: 1e8, // 100MB for media/terminal chunks
});

setupSocketHandlers(io);

// Start server
server.listen(CONFIG.PORT, CONFIG.HOST_BIND_ADDRESS, () => {
  const primaryIp = getPrimaryLocalIp();
  const allIps = getLocalIpAddresses();

  console.log("=================================================");
  console.log("  JARVIS V1 HOST AGENT STARTED SUCCESSFULLY      ");
  console.log("=================================================");
  console.log(`  Host Name   : ${CONFIG.HOST_NAME}`);
  console.log(`  Environment : ${CONFIG.NODE_ENV}`);
  console.log(`  Local IP    : ${primaryIp}`);
  console.log(`  API Server  : http://${primaryIp}:${CONFIG.PORT}`);
  console.log(`  Health Check: http://${primaryIp}:${CONFIG.PORT}/health`);
  console.log(`  Available Interfaces:`);
  allIps.forEach((iface) => {
    console.log(`    - ${iface.name}: ${iface.address} (${iface.isWireless ? "Wi-Fi" : "Ethernet"})`);
  });
  console.log("=================================================");
});

export { app, server, io };
