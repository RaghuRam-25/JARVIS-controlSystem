"use client";

import React, { useState, useEffect, useRef } from "react";
import { 
  Camera, 
  Tv, 
  MousePointer, 
  Terminal as TermIcon, 
  Mic, 
  ShieldAlert, 
  LogOut, 
  Send, 
  Play, 
  Square, 
  Check, 
  X, 
  Maximize2, 
  Sliders, 
  Globe, 
  Sparkles, 
  Youtube, 
  Code, 
  FolderOpen,
  Volume2
} from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";
import { getSocket, disconnectSocket } from "../lib/socket";
import { WebRTCStreamer } from "../lib/webrtc";
import { API_ENDPOINTS, apiUrl, resolveHostApiUrl } from "../lib/env";

export function ControllerDeck({ onSwitchToHost }: { onSwitchToHost: () => void }) {
  // Connection & Auth State
  const [isPaired, setIsPaired] = useState<boolean>(false);
  const [isWaitingApproval, setIsWaitingApproval] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string>("");
  const [hostIp, setHostIp] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"screen" | "trackpad" | "terminal" | "voice" | "security">("screen");
  const [manualNonce, setManualNonce] = useState<string>("");
  const [manualChallengeId, setManualChallengeId] = useState<string>("");
  const [scannerActive, setScannerActive] = useState<boolean>(false);

  // Voice State
  const [isListening, setIsListening] = useState<boolean>(false);
  const [voiceLang, setVoiceLang] = useState<"en-US" | "bn-BD">("en-US");
  const [transcript, setTranscript] = useState<string>("");
  const [pendingVoiceIntent, setPendingVoiceIntent] = useState<any>(null);
  const [voiceLog, setVoiceLog] = useState<string[]>([]);

  // Terminal State
  const [termOutput, setTermOutput] = useState<string>("JARVIS Interactive PowerShell Session Ready.\r\n");
  const [termInput, setTermInput] = useState<string>("");
  const [termSessionId, setTermSessionId] = useState<string>("");

  // Refs
  const socketRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const webrtcStreamerRef = useRef<WebRTCStreamer | null>(null);
  const recognitionRef = useRef<any>(null);
  const trackpadRef = useRef<HTMLDivElement | null>(null);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);

  // Restore saved session from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem("jarvis_controller_token");
    const savedHostIp = localStorage.getItem("jarvis_host_ip");
    if (savedToken && savedHostIp) {
      setAuthToken(savedToken);
      setHostIp(savedHostIp);
      connectToHost(savedHostIp, savedToken);
    }
  }, []);

  // Initialize Speech Recognition
  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recog = new SpeechRecognition();
        recog.continuous = false;
        recog.interimResults = true;
        recog.lang = voiceLang;

        recog.onresult = (event: any) => {
          const current = event.resultIndex;
          const text = event.results[current][0].transcript;
          setTranscript(text);
        };

        recog.onend = () => {
          setIsListening(false);
          if (transcript) {
            handleVoiceParse(transcript);
          }
        };

        recog.onerror = () => {
          setIsListening(false);
        };

        recognitionRef.current = recog;
      }
    }
  }, [voiceLang, transcript]);

  const connectToHost = (ip: string, token: string) => {
    const serverUrl = resolveHostApiUrl(ip);
    const socket = getSocket(serverUrl, { token });
    socketRef.current = socket;

    // Approval delivers the signed token on this very socket; connectToHost is
    // then re-invoked with that token so the session can be authenticated.
    socket.on("pairing:approved", (decision: any) => {
      if (!decision?.token) return;
      setIsWaitingApproval(false);
      setIsPaired(true);
      setAuthToken(decision.token);
      connectToHost(ip, decision.token);
    });

    socket.on("connect", () => {
      console.log("Connected to JARVIS host:", ip);
      setIsPaired(true);
      setIsWaitingApproval(false);
      localStorage.setItem("jarvis_controller_token", token);
      localStorage.setItem("jarvis_host_ip", ip);

      // Initialize WebRTC screen viewer
      const streamer = new WebRTCStreamer(socket);
      webrtcStreamerRef.current = streamer;
      streamer.createViewerConnection((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      });

      // Spawn interactive terminal
      socket.emit("terminal:spawn", { shell: "powershell.exe", cols: 80, rows: 24 });
    });

    socket.on("terminal:ready", ({ sessionId }: { sessionId: string }) => {
      setTermSessionId(sessionId);
    });

    socket.on("terminal:data", ({ data }: { data: string }) => {
      setTermOutput((prev) => (prev + data).slice(-5000));
    });

    socket.on("voice:parsed", (intent: any) => {
      setPendingVoiceIntent(intent);
    });

    socket.on("voice:result", (result: any) => {
      setVoiceLog((prev) => [
        `[${new Date().toLocaleTimeString()}] ${result.message}`,
        ...prev.slice(0, 10),
      ]);
    });

    socket.on("auth:error", (err: any) => {
      alert(`Authentication Error: ${err.message}`);
      handleDisconnect();
    });

    socket.on("session:revoked", () => {
      alert("Session was revoked by Host PC.");
      handleDisconnect();
    });
  };

  // QR Scanner Handler
  const startQrScanner = () => {
    setScannerActive(true);
    setTimeout(() => {
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          try {
            html5QrCode.stop();
            setScannerActive(false);
            const payload = JSON.parse(decodedText);
            const targetHost = payload.serverUrl || payload.hostIp;
            await submitPairingRequest(targetHost, payload.challengeId, payload.nonce);
          } catch (err) {
            console.error("Invalid QR payload", err);
          }
        },
        () => {}
      ).catch((err) => {
        console.warn("Camera failed or denied:", err);
      });
    }, 200);
  };

  const submitPairingRequest = async (targetHost: string, challengeId: string, nonce: string) => {
    setIsWaitingApproval(true);
    setHostIp(targetHost);

    try {
      const deviceName = `${navigator.userAgent.includes("Android") ? "Android Phone" : "Mobile Controller"} (${navigator.platform})`;
      const fingerprint = `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const serverUrl = resolveHostApiUrl(targetHost);

      // The socket must exist before the request so the Agent knows where to
      // deliver the signed session token once the Host approves.
      const socket = getSocket(serverUrl);
      socketRef.current = socket;

      const res = await fetch(apiUrl(API_ENDPOINTS.pairingRequest, serverUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId,
          nonce,
          clientName: deviceName,
          clientFingerprint: fingerprint,
          deviceType: "phone",
        }),
      });

      const data = await res.json();
      if (!data.success) {
        alert(data.message || "Pairing rejected");
        setIsWaitingApproval(false);
        return;
      }
    } catch (err: any) {
      alert(`Connection failed: ${err.message}`);
      setIsWaitingApproval(false);
    }
  };

  const handleDisconnect = () => {
    disconnectSocket();
    localStorage.removeItem("jarvis_controller_token");
    localStorage.removeItem("jarvis_host_ip");
    setIsPaired(false);
    setAuthToken("");
    setIsWaitingApproval(false);
    webrtcStreamerRef.current?.stop();
  };

  // Trackpad Touch Handler
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!lastTouchRef.current || !socketRef.current) return;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const deltaX = touch.clientX - lastTouchRef.current.x;
      const deltaY = touch.clientY - lastTouchRef.current.y;
      lastTouchRef.current = { x: touch.clientX, y: touch.clientY };

      socketRef.current.emit("control:mouse_move", {
        deltaX,
        deltaY,
        isRelative: true,
      });
    } else if (e.touches.length === 2) {
      // Two finger scroll
      const deltaY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - lastTouchRef.current.y;
      socketRef.current.emit("control:mouse_scroll", { deltaX: 0, deltaY });
    }
  };

  const sendMouseClick = (button: "left" | "right", double = false) => {
    socketRef.current?.emit("control:mouse_click", { button, double });
  };

  const sendKey = (key: string, modifiers = { ctrl: false, alt: false, shift: false, meta: false }) => {
    socketRef.current?.emit("control:key", { key, action: "press", modifiers });
  };

  // Voice Handler
  const toggleVoice = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      setTranscript("");
      setPendingVoiceIntent(null);
      try {
        if (recognitionRef.current) {
          recognitionRef.current.lang = voiceLang;
          recognitionRef.current.start();
          setIsListening(true);
        } else {
          // Fallback manual prompt
          const text = prompt("Enter speech command (e.g. 'open youtube and play coding beats' or 'ভিএস কোড খোলো'):");
          if (text) {
            setTranscript(text);
            handleVoiceParse(text);
          }
        }
      } catch {
        const text = prompt("Enter voice command:");
        if (text) handleVoiceParse(text);
      }
    }
  };

  const handleVoiceParse = (text: string) => {
    socketRef.current?.emit("voice:parse", { text, language: voiceLang === "bn-BD" ? "bn" : "en" });
  };

  const executeVoiceIntent = (approved: boolean) => {
    if (!pendingVoiceIntent) return;
    if (approved) {
      socketRef.current?.emit("voice:execute", {
        intentId: pendingVoiceIntent.id,
        approved: true,
        rawTranscript: pendingVoiceIntent.rawTranscript,
        language: pendingVoiceIntent.language,
      });
    }
    setPendingVoiceIntent(null);
  };

  // Terminal input send
  const sendTerminalInput = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!termInput || !termSessionId) return;
    socketRef.current?.emit("terminal:input", {
      sessionId: termSessionId,
      data: termInput + "\r\n",
    });
    setTermInput("");
  };

  // 1. Initial Unpaired / Pairing Screen
  if (!isPaired) {
    return (
      <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] p-4 flex flex-col items-center justify-center">
        <div className="w-full max-w-md glass-panel rounded-2xl p-6 flex flex-col items-center text-center gap-6">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center glow-cyan">
            <Camera className="w-6 h-6 text-cyan-400" />
          </div>

          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              JARVIS Controller Deck
            </h1>
            <p className="text-xs text-slate-400 mt-1">Scan host QR code on your Windows PC to pair</p>
          </div>

          {isWaitingApproval ? (
            <div className="py-8 flex flex-col items-center gap-4 animate-pulse">
              <div className="w-14 h-14 rounded-full border-4 border-cyan-500 border-t-transparent animate-spin" />
              <p className="text-sm font-semibold text-cyan-300">Awaiting Host Approval on Windows PC...</p>
              <p className="text-xs text-slate-500">Please click "Approve" on your PC screen</p>
              <button
                onClick={() => setIsWaitingApproval(false)}
                className="text-xs text-red-400 hover:underline mt-2"
              >
                Cancel Request
              </button>
            </div>
          ) : (
            <>
              {/* QR Scanner Viewport */}
              {scannerActive ? (
                <div className="w-full flex flex-col items-center gap-3">
                  <div id="qr-reader" className="w-full max-w-xs rounded-xl overflow-hidden border-2 border-cyan-500/40" />
                  <button
                    onClick={() => setScannerActive(false)}
                    className="text-xs text-slate-400 hover:text-red-400"
                  >
                    Close Camera Scanner
                  </button>
                </div>
              ) : (
                <button
                  onClick={startQrScanner}
                  className="w-full py-3.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2 glow-cyan transition-all"
                >
                  <Camera className="w-5 h-5" />
                  <span>Scan Host QR Code</span>
                </button>
              )}

              {/* Manual Connect Fallback */}
              <div className="w-full pt-4 border-t border-slate-800 flex flex-col gap-3 text-left">
                <p className="text-xs font-semibold text-slate-300">Or Manual Connect (LAN IP):</p>
                <input
                  type="text"
                  placeholder="Host IP (e.g. 192.168.1.50)"
                  value={hostIp}
                  onChange={(e) => setHostIp(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 placeholder-slate-500 font-mono"
                />
                <input
                  type="text"
                  placeholder="Pairing Nonce (from Host PC)"
                  value={manualNonce}
                  onChange={(e) => setManualNonce(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 placeholder-slate-500 font-mono"
                />
                <button
                  onClick={() => submitPairingRequest(hostIp, manualChallengeId || "manual", manualNonce)}
                  disabled={!hostIp || !manualNonce}
                  className="w-full py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-cyan-300 text-xs font-semibold border border-cyan-500/20 transition-all"
                >
                  Connect to Host
                </button>
              </div>

              <button
                onClick={onSwitchToHost}
                className="text-xs text-slate-400 hover:text-cyan-400 transition-colors"
              >
                Switch to Host PC Mode
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // 2. Main Authenticated Controller Workspace
  return (
    <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] flex flex-col">
      {/* Top Controller Header */}
      <header className="px-4 py-3 bg-[#0E1526] border-b border-cyan-500/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <div>
            <h1 className="text-xs font-bold text-slate-100">JARVIS Remote</h1>
            <p className="text-[10px] text-cyan-400/80 font-mono">{hostIp || "Host Connected"}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Bengali / English Language Toggle */}
          <button
            onClick={() => setVoiceLang((prev) => (prev === "en-US" ? "bn-BD" : "en-US"))}
            className="px-2.5 py-1 rounded-lg bg-slate-800 text-[11px] font-medium text-cyan-300 border border-cyan-500/20 flex items-center gap-1"
          >
            <Globe className="w-3 h-3" />
            <span>{voiceLang === "en-US" ? "EN" : "বাং"}</span>
          </button>

          <button
            onClick={handleDisconnect}
            className="p-1.5 rounded-lg bg-red-950/60 text-red-400 hover:bg-red-900 border border-red-500/30 text-xs"
            title="Disconnect"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {/* Tab 1: Screen Mirror */}
        {activeTab === "screen" && (
          <div className="flex-1 bg-black flex flex-col items-center justify-center relative select-none">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-contain cursor-crosshair"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const normalizedX = (e.clientX - rect.left) / rect.width;
                const normalizedY = (e.clientY - rect.top) / rect.height;
                socketRef.current?.emit("control:mouse_click", {
                  normalizedX,
                  normalizedY,
                  button: "left",
                });
              }}
            />
            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
              <span className="px-2.5 py-1 rounded-full bg-black/70 backdrop-blur-md text-[10px] font-mono text-cyan-400 border border-cyan-500/30">
                Tap anywhere to click • Low Latency WebRTC
              </span>
            </div>
          </div>
        )}

        {/* Tab 2: Precision Virtual Trackpad */}
        {activeTab === "trackpad" && (
          <div className="flex-1 flex flex-col p-4 gap-3">
            {/* Keyboard Shortcuts Toolbar */}
            <div className="flex flex-wrap gap-1.5 p-2 rounded-xl bg-slate-900 border border-slate-800">
              {["Ctrl", "Alt", "Shift", "Esc", "Tab", "Enter", "Backspace"].map((k) => (
                <button
                  key={k}
                  onClick={() => sendKey(k)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-cyan-500/20 text-xs font-semibold text-slate-300 hover:text-cyan-300 border border-slate-700 transition-colors"
                >
                  {k}
                </button>
              ))}
            </div>

            {/* Large Trackpad Area */}
            <div
              ref={trackpadRef}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={() => { lastTouchRef.current = null; }}
              className="flex-1 rounded-2xl bg-gradient-to-b from-slate-900 to-[#0A0E17] border-2 border-cyan-500/30 touch-trackpad flex items-center justify-center glow-cyan cursor-crosshair relative"
            >
              <div className="text-center pointer-events-none opacity-40 space-y-1">
                <MousePointer className="w-8 h-8 text-cyan-400 mx-auto" />
                <p className="text-xs font-medium text-slate-300">High-Precision Virtual Trackpad</p>
                <p className="text-[10px] text-slate-500">1-Finger Move • 2-Finger Scroll</p>
              </div>
            </div>

            {/* Click Buttons */}
            <div className="grid grid-cols-2 gap-3 h-16">
              <button
                onClick={() => sendMouseClick("left")}
                className="rounded-xl bg-slate-800 active:bg-cyan-500 active:text-slate-950 font-bold text-xs text-slate-200 border border-slate-700 flex items-center justify-center transition-all"
              >
                Left Click
              </button>
              <button
                onClick={() => sendMouseClick("right")}
                className="rounded-xl bg-slate-800 active:bg-cyan-500 active:text-slate-950 font-bold text-xs text-slate-200 border border-slate-700 flex items-center justify-center transition-all"
              >
                Right Click
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: Interactive Windows Terminal */}
        {activeTab === "terminal" && (
          <div className="flex-1 flex flex-col p-4 gap-3 bg-[#070A13]">
            {/* Quick Macro Buttons */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {[
                { label: "npm run dev", cmd: "npm run dev" },
                { label: "git status", cmd: "git status" },
                { label: "ls / dir", cmd: "dir" },
                { label: "Clear", cmd: "clear" },
              ].map((m) => (
                <button
                  key={m.label}
                  onClick={() => {
                    socketRef.current?.emit("terminal:input", {
                      sessionId: termSessionId,
                      data: m.cmd + "\r\n",
                    });
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono text-cyan-400 whitespace-nowrap"
                >
                  {m.label}
                </button>
              ))}
              <button
                onClick={() => {
                  socketRef.current?.emit("terminal:input", { sessionId: termSessionId, data: "\x03" });
                }}
                className="px-2.5 py-1 rounded-lg bg-red-950/60 text-red-400 border border-red-500/30 text-[11px] font-mono whitespace-nowrap"
              >
                Ctrl+C
              </button>
            </div>

            {/* Terminal Buffer */}
            <pre className="flex-1 p-3 rounded-xl bg-black border border-slate-800 font-mono text-[11px] text-emerald-400 overflow-y-auto whitespace-pre-wrap select-text">
              {termOutput}
            </pre>

            {/* Terminal Input Bar */}
            <form onSubmit={sendTerminalInput} className="flex gap-2">
              <input
                type="text"
                value={termInput}
                onChange={(e) => setTermInput(e.target.value)}
                placeholder="Type PowerShell command..."
                className="flex-1 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-cyan-500 text-slate-950 font-bold text-xs flex items-center justify-center"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}

        {/* Tab 4: Voice Commands & Antigravity Automation */}
        {activeTab === "voice" && (
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto">
            {/* Voice Command Button */}
            <div className="glass-panel rounded-2xl p-6 flex flex-col items-center text-center gap-4">
              <button
                onClick={toggleVoice}
                className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${
                  isListening 
                    ? "bg-red-500 glow-red animate-pulse text-white scale-110" 
                    : "bg-cyan-500/20 text-cyan-400 border-2 border-cyan-500/40 glow-cyan hover:scale-105"
                }`}
              >
                <Mic className="w-8 h-8" />
              </button>

              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-100">
                  {isListening ? "Listening... (Speak Now)" : "Tap Microphone to Speak"}
                </p>
                <p className="text-xs text-slate-400">
                  Language: <span className="font-semibold text-cyan-300">{voiceLang === "en-US" ? "English (US)" : "Bengali (বাংলা)"}</span>
                </p>
              </div>

              {transcript && (
                <div className="w-full p-3 rounded-xl bg-slate-900/80 border border-cyan-500/30 text-xs text-cyan-300 font-medium">
                  "{transcript}"
                </div>
              )}
            </div>

            {/* Sensitive Execution Approval Card */}
            {pendingVoiceIntent && (
              <div className="glass-panel rounded-2xl p-4 border-amber-500/40 bg-amber-950/20 flex flex-col gap-3 animate-pulse">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
                  <ShieldAlert className="w-4 h-4" />
                  <span>Confirmation Required Before Execution</span>
                </div>

                <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1 text-left">
                  <p className="text-xs font-semibold text-slate-200">{pendingVoiceIntent.summary}</p>
                  <p className="text-[10px] text-slate-400 font-mono">
                    Intent: {pendingVoiceIntent.type} • Risk: {pendingVoiceIntent.riskLevel.toUpperCase()}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => executeVoiceIntent(true)}
                    className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1"
                  >
                    <Check className="w-4 h-4" />
                    <span>Approve & Execute</span>
                  </button>
                  <button
                    onClick={() => executeVoiceIntent(false)}
                    className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs flex items-center justify-center gap-1"
                  >
                    <X className="w-4 h-4" />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            )}

            {/* Quick Automation Presets */}
            <div className="glass-panel rounded-2xl p-4 flex flex-col gap-2.5 text-left">
              <p className="text-xs font-semibold text-slate-300">Quick Voice Presets:</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleVoiceParse("open vs code")}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 border border-slate-800 flex items-center gap-2"
                >
                  <Code className="w-4 h-4 text-cyan-400" />
                  <span>Open VS Code</span>
                </button>
                <button
                  onClick={() => handleVoiceParse("launch antigravity")}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 border border-slate-800 flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4 text-purple-400" />
                  <span>Launch Antigravity</span>
                </button>
                <button
                  onClick={() => handleVoiceParse("open youtube and play lo-fi hip hop")}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 border border-slate-800 flex items-center gap-2"
                >
                  <Youtube className="w-4 h-4 text-red-400" />
                  <span>Play YouTube Lo-Fi</span>
                </button>
                <button
                  onClick={() => handleVoiceParse("open project control")}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs text-slate-200 border border-slate-800 flex items-center gap-2"
                >
                  <FolderOpen className="w-4 h-4 text-amber-400" />
                  <span>Open Project</span>
                </button>
              </div>
            </div>

            {/* Voice Activity Log */}
            {voiceLog.length > 0 && (
              <div className="glass-panel rounded-2xl p-4 flex flex-col gap-2 text-left">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Recent Executions</p>
                <div className="space-y-1 font-mono text-[10px] text-slate-300">
                  {voiceLog.map((log, i) => (
                    <p key={i} className="truncate">{log}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 5: Security & Session */}
        {activeTab === "security" && (
          <div className="flex-1 flex flex-col p-4 gap-4">
            <div className="glass-panel rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <ShieldAlert className="w-4 h-4 text-cyan-400" />
                <span>Session Security Details</span>
              </div>
              <p className="text-xs text-slate-400">
                Authenticated session is secured with signed HMAC tokens and restricted to the local Wi-Fi subnet.
              </p>
              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono space-y-1">
                <p><span className="text-slate-500">Host IP:</span> {hostIp}</p>
                <p><span className="text-slate-500">Token:</span> {authToken.slice(0, 16)}...</p>
                <p><span className="text-slate-500">Transport:</span> Encrypted WebSocket</p>
              </div>
            </div>

            <button
              onClick={handleDisconnect}
              className="w-full py-3.5 rounded-xl bg-red-950/60 hover:bg-red-900 text-red-300 font-bold text-xs border border-red-500/40 glow-red transition-all flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              <span>Revoke Token & Disconnect</span>
            </button>
          </div>
        )}
      </main>

      {/* Bottom Mobile Navigation Bar */}
      <nav className="h-16 bg-[#0E1526] border-t border-cyan-500/20 grid grid-cols-5 items-center px-1">
        {[
          { id: "screen", label: "Screen", icon: Tv },
          { id: "trackpad", label: "Trackpad", icon: MousePointer },
          { id: "terminal", label: "Terminal", icon: TermIcon },
          { id: "voice", label: "Voice", icon: Mic },
          { id: "security", label: "Security", icon: ShieldAlert },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex flex-col items-center justify-center gap-1 py-1 transition-colors ${
                isActive ? "text-cyan-400 font-bold" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px]">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
