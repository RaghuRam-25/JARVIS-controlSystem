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
  allowedHeaders: ["Content-Type", "Authorization", "X-Jarvis-Token", "X-Jarvis-Host-Credential", "X-Socket-Id", "*"],
  credentials: true,
  maxAge: 600,
}));

// Pairing payloads and status updates are small; terminal/video frames travel
// over Socket.IO, not through this parser.
app.use(express.json({ limit: "256kb" }));

// Simple in-process rate limiter for the unauthenticated pairing entry points.
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();
app.use("/api/pairing", (req, res, next) => {
  if (req.method !== "POST") return next();
  const route = req.originalUrl.split("?")[0];
  if (route === "/api/pairing/decision" || route === "/api/pairing/revoke-all" || route === "/api/pairing/revoke") {
    return next();
  }

  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = pairingAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    pairingAttempts.set(key, { count: 1, resetAt: now + 60000 });
    return next();
  }
  entry.count += 1;
  if (entry.count > 30) {
    res.status(429).json({ success: false, message: "Too many requests." });
    return;
  }
  next();
});

// Mount API routes
app.use(apiRouter);

// Socket.IO Server
const io = new SocketIOServer(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  pingTimeout: 20000,
  pingInterval: 10000,
  // Terminal I/O is line-based; 8 MB is ample and blocks oversized-frame DoS.
  maxHttpBufferSize: 8 * 1024 * 1024,
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
