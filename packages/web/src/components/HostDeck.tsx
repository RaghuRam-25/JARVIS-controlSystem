"use client";

import React, { useState, useEffect, useRef } from "react";
import { 
  ShieldCheck, 
  QrCode, 
  Monitor, 
  Smartphone, 
  AlertTriangle, 
  RefreshCw, 
  Trash2, 
  PowerOff, 
  Radio, 
  Cpu, 
  HardDrive, 
  CheckCircle, 
  XCircle,
  Wifi,
  ExternalLink
} from "lucide-react";
import { getSocket } from "../lib/socket";
import { WebRTCStreamer } from "../lib/webrtc";
import { API_ENDPOINTS, API_PORT, apiUrl, fetchHostCredential, getApiBaseUrl } from "../lib/env";

interface PendingRequest {
  requestId: string;
  clientName: string;
  deviceType: string;
  clientIp: string;
  clientFingerprint: string;
  requestedAt: number;
}

interface ActiveSession {
  sessionId: string;
  clientName: string;
  deviceType: string;
  clientFingerprint: string;
  issuedAt: number;
  expiresAt: number;
  status: string;
}

interface SystemStatus {
  host: string;
  os: string;
  cpuCount: number;
  totalMemoryGB: number;
  freeMemoryGB: number;
  screen: { width: number; height: number };
  primaryIp: string;
}

export function HostDeck({ onSwitchToController }: { onSwitchToController: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [qrSecondsLeft, setQrSecondsLeft] = useState<number>(60);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isScreenStreaming, setIsScreenStreaming] = useState<boolean>(false);
  const [serverUrl, setServerUrl] = useState<string>(getApiBaseUrl());
  const [hostCredential, setHostCredential] = useState<string | null>(null);

  const hostCredentialRef = useRef<string | null>(null);
  const socketRef = useRef<any>(null);
  const webrtcStreamerRef = useRef<WebRTCStreamer | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);

  const hostAuthHeaders = (cred?: string | null): Record<string, string> => {
    const key = cred !== undefined ? cred : (hostCredentialRef.current || hostCredential);
    return key ? { "X-Jarvis-Host-Credential": key } : {};
  };

  // Initialize socket and fetch data
  useEffect(() => {
    const apiBase = getApiBaseUrl();
    setServerUrl(apiBase);

    // The host role requires a credential from the Agent.
    fetchHostCredential(apiBase).then((credential) => {
      setHostCredential(credential);
      hostCredentialRef.current = credential;

      const socket = getSocket(apiBase, { isHost: true, hostCredential: credential || undefined });
      socketRef.current = socket;
      webrtcStreamerRef.current = new WebRTCStreamer(socket);

      socket.on("connect", () => {
        console.log("Host connected to control socket:", socket.id);
      });

      socket.on("auth:error", ({ message }: { message: string }) => {
        console.error("Host socket rejected:", message);
      });

      socket.on("pairing:requested", (req: PendingRequest) => {
        setPendingRequests((prev) => [...prev.filter((p) => p.requestId !== req.requestId), req]);
      });

      socket.on("pairing:approved", () => {
        fetchSessions(apiBase, hostCredentialRef.current);
        fetchChallenge(apiBase);
      });

      socket.on("pairing:rejected", ({ requestId }: { requestId: string }) => {
        setPendingRequests((prev) => prev.filter((p) => p.requestId !== requestId));
      });

      socket.on("pairing:cancelled", ({ requestId }: { requestId: string }) => {
        setPendingRequests((prev) => prev.filter((p) => p.requestId !== requestId));
      });

      socket.on("session:revoked", () => {
        fetchSessions(apiBase, hostCredentialRef.current);
      });

      socket.on("session:revoked_all", () => {
        setActiveSessions([]);
      });

      fetchSessions(apiBase, credential);
      fetchSystemStatus(apiBase, credential);
    });

    fetchChallenge(apiBase);

    // Refresh system status every 10 seconds with current credential
    const statusInterval = setInterval(() => {
      if (hostCredentialRef.current) {
        fetchSystemStatus(apiBase, hostCredentialRef.current);
      }
    }, 10000);

    return () => {
      clearInterval(statusInterval);
      webrtcStreamerRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 60-second QR Countdown timer
  useEffect(() => {
    const timer = setInterval(() => {
      setQrSecondsLeft((prev) => {
        if (prev <= 1) {
          fetchChallenge(serverUrl);
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [serverUrl]);

  const fetchChallenge = async (apiBase = serverUrl) => {
    try {
      const challengeUrl = `${apiUrl(API_ENDPOINTS.pairingChallenge, apiBase)}?_t=${Date.now()}`;
      const res = await fetch(challengeUrl, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const data = await res.json();
      if (data.success) {
        setQrDataUrl(data.qrDataUrl);
        setQrSecondsLeft(60);
      }
    } catch (err) {
      console.error("Failed to fetch pairing challenge:", err);
    }
  };

  const fetchSessions = async (apiBase = serverUrl, cred = hostCredential) => {
    try {
      const res = await fetch(apiUrl(API_ENDPOINTS.pairingSessions, apiBase), {
        headers: hostAuthHeaders(cred),
      });
      const data = await res.json();
      if (data.success) {
        setActiveSessions(data.sessions || []);
      }
    } catch {}
  };

  const fetchSystemStatus = async (apiBase = serverUrl, cred = hostCredential) => {
    try {
      const res = await fetch(apiUrl(API_ENDPOINTS.systemStatus, apiBase), {
        headers: hostAuthHeaders(cred),
      });
      const data = await res.json();
      if (data.success) {
        setSystemStatus(data);
      }
    } catch {}
  };

  const handleDecision = async (requestId: string, decision: "approve" | "reject") => {
    try {
      await fetch(apiUrl(API_ENDPOINTS.pairingDecision, serverUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...hostAuthHeaders() },
        body: JSON.stringify({ requestId, decision }),
      });
      setPendingRequests((prev) => prev.filter((p) => p.requestId !== requestId));
      fetchSessions();
    } catch (err) {
      console.error("Failed to send pairing decision:", err);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      await fetch(apiUrl(API_ENDPOINTS.pairingRevoke, serverUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...hostAuthHeaders() },
        body: JSON.stringify({ sessionId, reason: "Revoked by Host PC" }),
      });
      fetchSessions();
    } catch (err) {
      console.error("Failed to revoke session:", err);
    }
  };

  const handleEmergencyRevokeAll = async () => {
    if (confirm("EMERGENCY KILL SWITCH: Revoke all active paired controllers immediately?")) {
      try {
        await fetch(apiUrl(API_ENDPOINTS.pairingRevokeAll, serverUrl), {
          method: "POST",
          headers: hostAuthHeaders(),
        });
        setActiveSessions([]);
      } catch (err) {
        console.error("Kill switch failed:", err);
      }
    }
  };

  const toggleScreenStream = async () => {
    if (isScreenStreaming) {
      webrtcStreamerRef.current?.stop();
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
      setIsScreenStreaming(false);
    } else {
      try {
        const stream = await webrtcStreamerRef.current?.startHostCapture();
        if (stream && screenVideoRef.current) {
          screenVideoRef.current.srcObject = stream;
        }
        setIsScreenStreaming(true);
      } catch {
        alert("Screen capture was canceled or not allowed.");
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] p-4 md:p-8 flex flex-col items-center">
      {/* Top Banner */}
      <header className="w-full max-w-6xl flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-cyan-500/20 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center glow-cyan">
            <Monitor className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight bg-gradient-to-r from-cyan-400 via-teal-300 to-blue-500 bg-clip-text text-transparent">
              JARVIS V1 — Host PC Shell
            </h1>
            <p className="text-xs text-slate-400">Windows Desktop Host & Real-Time Gateway</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onSwitchToController}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-cyan-300 border border-cyan-500/20 transition-colors"
          >
            <Smartphone className="w-4 h-4" />
            <span>Switch to Controller Mode</span>
          </button>

          <button
            onClick={handleEmergencyRevokeAll}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900 text-xs font-semibold text-red-300 border border-red-500/40 glow-red transition-all"
          >
            <PowerOff className="w-4 h-4 text-red-400" />
            <span>Kill Switch</span>
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: QR Code & Pairing Challenge */}
        <section className="lg:col-span-5 flex flex-col gap-6">
          <div className="glass-panel rounded-2xl p-6 flex flex-col items-center text-center">
            <div className="flex items-center justify-between w-full mb-4">
              <div className="flex items-center gap-2 text-cyan-400 font-semibold text-sm">
                <QrCode className="w-4 h-4" />
                <span>Pairing Challenge</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 font-mono">
                <RefreshCw className={`w-3 h-3 ${qrSecondsLeft <= 5 ? "animate-spin text-amber-400" : ""}`} />
                <span>Expires in {qrSecondsLeft}s</span>
              </div>
            </div>

            {/* QR Code Container */}
            <div className="p-4 bg-[#0A0E17] rounded-2xl border-2 border-cyan-500/40 glow-cyan relative group">
              {qrDataUrl ? (
                <img 
                  src={qrDataUrl} 
                  alt="Pairing QR Code" 
                  className="w-56 h-56 md:w-64 md:h-64 object-contain rounded-lg"
                />
              ) : (
                <div className="w-56 h-56 flex items-center justify-center text-slate-500 text-xs">
                  Generating secure challenge...
                </div>
              )}
            </div>

            <div className="mt-4 text-xs text-slate-400 space-y-1">
              <p className="font-medium text-slate-200">Scan with your Android phone/tablet PWA</p>
              <p className="text-[11px] text-cyan-400/80 font-mono">
                {serverUrl && !serverUrl.includes("localhost") && !serverUrl.includes("127.0.0.1")
                  ? `Server: ${serverUrl}`
                  : `Local Wi-Fi IP: ${systemStatus?.primaryIp || "127.0.0.1"} : ${API_PORT}`}
              </p>
            </div>

            <button
              onClick={() => fetchChallenge()}
              className="mt-4 flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Regenerate QR Challenge Now</span>
            </button>
          </div>
        </section>

        {/* Right Column: Active Devices, Pending Approvals, System Specs, Screen Broadcaster */}
        <section className="lg:col-span-7 flex flex-col gap-6">
          {/* Host Pending Approval Modal / Banner */}
          {pendingRequests.length > 0 && (
            <div className="glass-panel rounded-2xl p-5 border-amber-500/40 bg-amber-950/20 flex flex-col gap-4 glow-cyan animate-pulse">
              <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                <span>Controller Pairing Request Awaiting Approval</span>
              </div>

              {pendingRequests.map((req) => (
                <div key={req.requestId} className="bg-[#0A0E17] p-4 rounded-xl border border-amber-500/30 flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 font-semibold text-slate-100 text-sm">
                      <Smartphone className="w-4 h-4 text-cyan-400" />
                      <span>{req.clientName}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 uppercase">
                        {req.deviceType}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      IP Address: <span className="font-mono text-cyan-300">{req.clientIp}</span>
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono truncate max-w-xs">
                      ID: {req.clientFingerprint}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDecision(req.requestId, "approve")}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs shadow-lg transition-colors"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Approve</span>
                    </button>
                    <button
                      onClick={() => handleDecision(req.requestId, "reject")}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-red-900 text-red-300 font-medium text-xs border border-red-500/30 transition-colors"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Deny</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Active Paired Devices */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Authorized Paired Devices ({activeSessions.length})</span>
              </div>
              <button
                onClick={() => fetchSessions()}
                className="text-xs text-slate-400 hover:text-cyan-400 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Refresh</span>
              </button>
            </div>

            {activeSessions.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
                <Smartphone className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No active remote controllers connected</p>
                <p className="text-[11px] text-slate-600">Scan the QR code to pair your Android device</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {activeSessions.map((session) => (
                  <div key={session.sessionId} className="p-3.5 rounded-xl bg-slate-900/60 border border-cyan-500/20 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="font-semibold text-xs text-slate-200">{session.clientName}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300">
                          {session.deviceType}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 font-mono">
                        Session: {session.sessionId.slice(0, 8)}... | Paired: {new Date(session.issuedAt).toLocaleTimeString()}
                      </p>
                    </div>

                    <button
                      onClick={() => handleRevokeSession(session.sessionId)}
                      className="p-2 rounded-lg bg-red-950/40 hover:bg-red-900 text-red-400 border border-red-500/20 text-xs flex items-center gap-1 transition-colors"
                      title="Revoke Device Access"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Revoke</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Host PC System Status */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <span>Host PC Specifications</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">Device</p>
                <p className="text-xs font-semibold text-slate-200 mt-1 truncate">{systemStatus?.host || "Windows PC"}</p>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">Display</p>
                <p className="text-xs font-semibold text-cyan-300 mt-1">
                  {systemStatus?.screen ? `${systemStatus.screen.width} × ${systemStatus.screen.height}` : "1920 × 1080"}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">CPU Cores</p>
                <p className="text-xs font-semibold text-slate-200 mt-1">{systemStatus?.cpuCount || "8"} Cores</p>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">RAM Available</p>
                <p className="text-xs font-semibold text-emerald-300 mt-1">
                  {systemStatus?.freeMemoryGB || 0} / {systemStatus?.totalMemoryGB || 16} GB
                </p>
              </div>
            </div>
          </div>

          {/* WebRTC Screen Broadcaster Control (Moved to lower-right area) */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <Radio className="w-4 h-4 text-cyan-400" />
                <span>WebRTC Screen Broadcaster</span>
              </div>
              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${isScreenStreaming ? "bg-emerald-950 text-emerald-300 border border-emerald-500/30" : "bg-slate-800 text-slate-400"}`}>
                {isScreenStreaming ? "LIVE ON LAN" : "INACTIVE"}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Low-latency hardware screen capture streamed via WebRTC to authenticated mobile controllers.
            </p>
            
            <button
              onClick={toggleScreenStream}
              className={`w-full py-2.5 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-all ${
                isScreenStreaming 
                  ? "bg-red-950/60 text-red-300 border border-red-500/40 hover:bg-red-900" 
                  : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 glow-cyan"
              }`}
            >
              <Monitor className="w-4 h-4" />
              <span>{isScreenStreaming ? "Stop Screen Stream" : "Start Live Screen Share"}</span>
            </button>

            {isScreenStreaming && (
              <div className="mt-2 rounded-lg overflow-hidden border border-cyan-500/20 bg-black aspect-video flex items-center justify-center">
                <video ref={screenVideoRef} autoPlay playsInline muted className="w-full h-full object-contain" />
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
