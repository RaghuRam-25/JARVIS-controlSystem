"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  Camera, 
  Tv, 
  Mic, 
  ShieldAlert, 
  LogOut, 
  Send, 
  Check, 
  X, 
  Globe, 
  Sparkles, 
  Youtube, 
  Code, 
  FolderOpen,
  Keyboard as KeyboardIcon,
  MousePointer,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Move
} from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";
import { getSocket, disconnectSocket } from "../lib/socket";
import { WebRTCStreamer } from "../lib/webrtc";
import { API_ENDPOINTS, apiUrl, resolveHostApiUrl } from "../lib/env";

type StreamStatus = "DISCONNECTED" | "CONNECTING" | "WAITING_FOR_SCREEN" | "STREAMING_LIVE" | "ERROR";

export function ControllerDeck({ onSwitchToHost }: { onSwitchToHost: () => void }) {
  // Connection & Auth State
  const [isPaired, setIsPaired] = useState<boolean>(false);
  const [isWaitingApproval, setIsWaitingApproval] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string>("");
  const [hostIp, setHostIp] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"screen" | "voice" | "security">("screen");
  const [manualNonce, setManualNonce] = useState<string>("");
  const [manualChallengeId, setManualChallengeId] = useState<string>("");
  const [scannerActive, setScannerActive] = useState<boolean>(false);

  // Stream & Interactive Screen State
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("DISCONNECTED");
  const [isKeyboardOpen, setIsKeyboardOpen] = useState<boolean>(false);
  const [keyboardText, setKeyboardText] = useState<string>("");
  const [isDragMode, setIsDragMode] = useState<boolean>(false);
  const [touchIndicator, setTouchIndicator] = useState<{ x: number; y: number; visible: boolean; isRightClick?: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });

  // Voice State
  const [isListening, setIsListening] = useState<boolean>(false);
  const [voiceLang, setVoiceLang] = useState<"en-US" | "bn-BD">("en-US");
  const [transcript, setTranscript] = useState<string>("");
  const [pendingVoiceIntent, setPendingVoiceIntent] = useState<any>(null);
  const [voiceLog, setVoiceLog] = useState<string[]>([]);

  // Refs
  const socketRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const webrtcStreamerRef = useRef<WebRTCStreamer | null>(null);
  const recognitionRef = useRef<any>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const longPressFiredRef = useRef<boolean>(false);
  const multiTouchDistRef = useRef<number | null>(null);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);

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

  const initWebRTCViewer = useCallback((socket: any) => {
    setStreamStatus("WAITING_FOR_SCREEN");
    if (webrtcStreamerRef.current) {
      webrtcStreamerRef.current.stop();
    }

    const streamer = new WebRTCStreamer(socket);
    webrtcStreamerRef.current = streamer;

    streamer.createViewerConnection((stream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current
          .play()
          .then(() => {
            setStreamStatus("STREAMING_LIVE");
          })
          .catch((err) => {
            console.warn("Autoplay notice, waiting for interaction:", err);
            setStreamStatus("STREAMING_LIVE");
          });
      }
    });
  }, []);

  const connectToHost = useCallback((ip: string, token: string) => {
    setStreamStatus("CONNECTING");
    const serverUrl = resolveHostApiUrl(ip);
    const socket = getSocket(serverUrl, { token }, true);
    socketRef.current = socket;

    // Immediately authenticate
    socket.emit("auth:authenticate", { token });

    const initConnection = () => {
      console.log("Connected and authenticated with JARVIS host:", ip);
      setIsPaired(true);
      setIsWaitingApproval(false);
      localStorage.setItem("jarvis_controller_token", token);
      localStorage.setItem("jarvis_host_ip", ip);

      // Initialize WebRTC screen viewer
      initWebRTCViewer(socket);
    };

    socket.off("auth:success");
    socket.on("auth:success", () => {
      initConnection();
    });

    socket.off("connect");
    socket.on("connect", () => {
      socket.emit("auth:authenticate", { token });
      initConnection();
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

    socket.on("session:revoked", () => {
      alert("Session was revoked by Host PC.");
      handleDisconnect();
    });
  }, [initWebRTCViewer]);

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
      const socket = getSocket(serverUrl);
      socketRef.current = socket;

      // Listen for approval on this socket
      socket.off("pairing:approved");
      socket.on("pairing:approved", (decision: any) => {
        if (!decision?.token) return;
        setIsWaitingApproval(false);
        setIsPaired(true);
        setAuthToken(decision.token);
        connectToHost(targetHost, decision.token);
      });

      socket.off("pairing:rejected");
      socket.on("pairing:rejected", (payload: any) => {
        alert(payload?.message || "Pairing rejected by host.");
        setIsWaitingApproval(false);
      });

      // Wait briefly for socket connection to obtain socket.id if not already connected
      let socketId = socket.id;
      if (!socketId && !socket.connected) {
        socketId = await new Promise<string | undefined>((resolve) => {
          socket.once("connect", () => resolve(socket.id));
          setTimeout(() => resolve(socket.id), 1500);
        });
      }

      const pairingPayload = {
        challengeId,
        nonce,
        clientName: deviceName,
        clientFingerprint: fingerprint,
        deviceType: "phone" as const,
        socketId: socketId || undefined,
      };

      // Also emit via socket for real-time delivery
      socket.emit("pairing:request", pairingPayload);

      const res = await fetch(apiUrl(API_ENDPOINTS.pairingRequest, serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(socketId ? { "X-Socket-Id": socketId } : {}),
        },
        body: JSON.stringify(pairingPayload),
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
    setStreamStatus("DISCONNECTED");
    webrtcStreamerRef.current?.stop();
  };

  // ==========================================
  // MATHEMATICAL COORDINATE PROJECTION LOGIC
  // Accounts for aspect ratio, letterboxing, pillarboxing & object-fit: contain
  // ==========================================
  const calculateNormalizedCoords = (clientX: number, clientY: number): { normalizedX: number; normalizedY: number } | null => {
    const video = videoRef.current;
    if (!video) return null;

    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const videoWidth = video.videoWidth || 1920;
    const videoHeight = video.videoHeight || 1080;

    const containerRatio = rect.width / rect.height;
    const videoRatio = videoWidth / videoHeight;

    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let renderedLeft = 0;
    let renderedTop = 0;

    if (containerRatio > videoRatio) {
      // Pillarbox (black bars on left/right)
      renderedHeight = rect.height;
      renderedWidth = rect.height * videoRatio;
      renderedLeft = (rect.width - renderedWidth) / 2;
      renderedTop = 0;
    } else {
      // Letterbox (black bars on top/bottom)
      renderedWidth = rect.width;
      renderedHeight = rect.width / videoRatio;
      renderedLeft = 0;
      renderedTop = (rect.height - renderedHeight) / 2;
    }

    const offsetX = clientX - rect.left - renderedLeft;
    const offsetY = clientY - rect.top - renderedTop;

    const normalizedX = Math.max(0, Math.min(1, offsetX / renderedWidth));
    const normalizedY = Math.max(0, Math.min(1, offsetY / renderedHeight));

    return { normalizedX, normalizedY };
  };

  // ==========================================
  // TOUCH-TO-CONTROL EVENT HANDLERS
  // ==========================================
  const handlePointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (e.pointerType === "touch" && !e.isPrimary) return;
    
    // Ensure video is playing on mobile touch
    if (videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    }

    const coords = calculateNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

    pointerDownPosRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
    longPressFiredRef.current = false;
    isDraggingRef.current = false;

    // Show visual ripple
    setTouchIndicator({ x: e.clientX, y: e.clientY, visible: true, isRightClick: false });

    // Long press timer (500ms for Right Click)
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      if (navigator.vibrate) navigator.vibrate(50);
      setTouchIndicator({ x: e.clientX, y: e.clientY, visible: true, isRightClick: true });

      socketRef.current?.emit("control:mouse_click", {
        normalizedX: coords.normalizedX,
        normalizedY: coords.normalizedY,
        button: "right",
      });

      setTimeout(() => {
        setTouchIndicator((prev) => ({ ...prev, visible: false }));
      }, 400);
    }, 500);

    // If explicit drag mode is toggled, trigger mouseDown immediately
    if (isDragMode) {
      isDraggingRef.current = true;
      socketRef.current?.emit("control:mouse_button", {
        action: "down",
        normalizedX: coords.normalizedX,
        normalizedY: coords.normalizedY,
        button: "left",
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!pointerDownPosRef.current) return;

    const dx = Math.abs(e.clientX - pointerDownPosRef.current.x);
    const dy = Math.abs(e.clientY - pointerDownPosRef.current.y);

    // If moved beyond 10px, cancel long-press right click
    if (dx > 10 || dy > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    const coords = calculateNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

    // If moved significantly and not already dragging, start dragging
    if ((dx > 15 || dy > 15) && !isDraggingRef.current && !longPressFiredRef.current) {
      isDraggingRef.current = true;
      socketRef.current?.emit("control:mouse_button", {
        action: "down",
        normalizedX: coords.normalizedX,
        normalizedY: coords.normalizedY,
        button: "left",
      });
    }

    if (isDraggingRef.current) {
      socketRef.current?.emit("control:mouse_move", {
        normalizedX: coords.normalizedX,
        normalizedY: coords.normalizedY,
        isRelative: false,
      });
      setTouchIndicator({ x: e.clientX, y: e.clientY, visible: true, isRightClick: false });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    const coords = calculateNormalizedCoords(e.clientX, e.clientY);

    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (coords) {
        socketRef.current?.emit("control:mouse_button", {
          action: "up",
          normalizedX: coords.normalizedX,
          normalizedY: coords.normalizedY,
          button: "left",
        });
      }
    } else if (!longPressFiredRef.current && pointerDownPosRef.current && coords) {
      // Normal single tap -> Left Click
      socketRef.current?.emit("control:mouse_click", {
        normalizedX: coords.normalizedX,
        normalizedY: coords.normalizedY,
        button: "left",
      });
    }

    pointerDownPosRef.current = null;
    setTimeout(() => {
      setTouchIndicator((prev) => ({ ...prev, visible: false }));
    }, 200);
  };

  // Two-Finger Gesture Scroll on Touch Devices
  const handleTouchStart = (e: React.TouchEvent<HTMLVideoElement>) => {
    if (e.touches.length === 2) {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      lastTouchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
      multiTouchDistRef.current = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLVideoElement>) => {
    if (e.touches.length === 2 && lastTouchCenterRef.current) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const currentY = (touch1.clientY + touch2.clientY) / 2;
      const deltaY = lastTouchCenterRef.current.y - currentY;
      lastTouchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: currentY,
      };

      if (Math.abs(deltaY) > 2) {
        socketRef.current?.emit("control:mouse_scroll", { deltaX: 0, deltaY });
      }
    }
  };

  const handleTouchEnd = () => {
    lastTouchCenterRef.current = null;
    multiTouchDistRef.current = null;
  };

  // Keyboard Helpers
  const sendKey = (key: string, modifiers = { ctrl: false, alt: false, shift: false, meta: false }) => {
    socketRef.current?.emit("control:key", { key, action: "press", modifiers });
  };

  const sendTypedText = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!keyboardText) return;
    socketRef.current?.emit("control:type", { text: keyboardText });
    setKeyboardText("");
  };

  // Voice Helpers
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
          const text = prompt("Enter speech command (e.g. 'open vs code' or 'ক্রোম খোলো'):");
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

  // ==========================================
  // UNPAIRED / PAIRING SCREEN
  // ==========================================
  if (!isPaired) {
    return (
      <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] p-4 flex flex-col items-center justify-center">
        <div className="w-full max-w-md glass-panel rounded-2xl p-6 flex flex-col items-center text-center gap-6">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center glow-cyan">
            <Camera className="w-6 h-6 text-cyan-400" />
          </div>

          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              JARVIS Touch Controller
            </h1>
            <p className="text-xs text-slate-400 mt-1">Scan host QR code on your Windows PC to pair & control</p>
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
                <p className="text-xs font-semibold text-slate-300">Or Manual Connect (LAN IP / URL):</p>
                <input
                  type="text"
                  placeholder="Host IP or URL"
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

  // ==========================================
  // AUTHENTICATED CONTROLLER WORKSPACE
  // ==========================================
  return (
    <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] flex flex-col select-none overflow-hidden touch-none">
      {/* Top Header */}
      <header className="px-3 py-2 bg-[#0E1526] border-b border-cyan-500/20 flex items-center justify-between z-20">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${streamStatus === "STREAMING_LIVE" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
          <div>
            <h1 className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
              <span>JARVIS Live Desktop</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-500/30">
                {streamStatus === "STREAMING_LIVE" ? "LIVE" : streamStatus.replace(/_/g, " ")}
              </span>
            </h1>
            <p className="text-[9px] text-slate-400 font-mono truncate max-w-[140px]">{hostIp || "Host Connected"}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Quick Drag / Select Mode Toggle */}
          <button
            onClick={() => setIsDragMode((prev) => !prev)}
            className={`px-2 py-1 rounded-lg text-[11px] font-semibold border transition-all flex items-center gap-1 ${
              isDragMode 
                ? "bg-amber-500/20 text-amber-300 border-amber-500/50 glow-amber" 
                : "bg-slate-800 text-slate-300 border-slate-700"
            }`}
            title="Toggle Drag/Select Mode"
          >
            <Move className="w-3 h-3" />
            <span>{isDragMode ? "Drag ON" : "Tap"}</span>
          </button>

          {/* Virtual Keyboard Toggle */}
          <button
            onClick={() => setIsKeyboardOpen((prev) => !prev)}
            className={`p-1.5 rounded-lg border text-xs transition-colors ${
              isKeyboardOpen 
                ? "bg-cyan-500 text-slate-950 border-cyan-400" 
                : "bg-slate-800 text-cyan-300 border-cyan-500/30 hover:bg-slate-700"
            }`}
            title="Toggle Virtual Keyboard"
          >
            <KeyboardIcon className="w-4 h-4" />
          </button>

          {/* Reconnect WebRTC Stream */}
          <button
            onClick={() => {
              if (socketRef.current) initWebRTCViewer(socketRef.current);
            }}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-cyan-400 border border-slate-700 text-xs"
            title="Refresh Stream"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          {/* Bengali / English Language Toggle */}
          <button
            onClick={() => setVoiceLang((prev) => (prev === "en-US" ? "bn-BD" : "en-US"))}
            className="px-2 py-1 rounded-lg bg-slate-800 text-[11px] font-medium text-cyan-300 border border-cyan-500/20 flex items-center gap-1"
          >
            <Globe className="w-3 h-3" />
            <span>{voiceLang === "en-US" ? "EN" : "বাং"}</span>
          </button>

          {/* Disconnect */}
          <button
            onClick={handleDisconnect}
            className="p-1.5 rounded-lg bg-red-950/60 text-red-400 hover:bg-red-900 border border-red-500/30 text-xs"
            title="Disconnect"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Surface Area */}
      <main className="flex-1 flex flex-col overflow-hidden relative bg-black">
        {/* ========================================= */}
        {/* TAB 1: DOMINANT TOUCH-TO-CONTROL LIVE SCREEN */}
        {/* ========================================= */}
        {activeTab === "screen" && (
          <div className="flex-1 w-full h-full bg-black flex flex-col items-center justify-center relative overflow-hidden">
            {/* Visual Touch Ripple */}
            {touchIndicator.visible && (
              <div
                className={`absolute w-8 h-8 -ml-4 -mt-4 rounded-full pointer-events-none z-50 animate-ping ${
                  touchIndicator.isRightClick ? "bg-amber-400 border-2 border-amber-200" : "bg-cyan-400 border-2 border-white"
                }`}
                style={{ left: touchIndicator.x, top: touchIndicator.y }}
              />
            )}

            {/* Waiting for stream placeholder if not live */}
            {streamStatus !== "STREAMING_LIVE" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center z-10 bg-[#070a13]/90">
                <div className="w-10 h-10 rounded-full border-3 border-cyan-500 border-t-transparent animate-spin" />
                <p className="text-sm font-semibold text-cyan-300">
                  {streamStatus === "WAITING_FOR_SCREEN" ? "Waiting for Windows Screen Capture..." : "Connecting to Stream..."}
                </p>
                <p className="text-xs text-slate-400 max-w-xs">
                  Make sure screen streaming is enabled on your Windows Host PC dashboard.
                </p>
                <button
                  onClick={() => {
                    if (socketRef.current) initWebRTCViewer(socketRef.current);
                  }}
                  className="mt-2 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-xs font-semibold"
                >
                  Retry Stream Connection
                </button>
              </div>
            )}

            {/* Live Interactive Video Surface */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              className="w-full h-full object-contain cursor-crosshair touch-none select-none"
            />

            {/* Floating Top/Bottom On-Screen Keyboard Drawer */}
            {isKeyboardOpen && (
              <div className="absolute bottom-12 left-2 right-2 p-2.5 rounded-2xl bg-[#0e1526]/95 border border-cyan-500/40 backdrop-blur-md z-30 shadow-2xl flex flex-col gap-2 animate-in slide-in-from-bottom-5">
                <div className="flex items-center justify-between pb-1 border-b border-slate-800">
                  <span className="text-[11px] font-bold text-cyan-400 flex items-center gap-1.5">
                    <KeyboardIcon className="w-3.5 h-3.5" />
                    <span>Windows Remote Keyboard</span>
                  </span>
                  <button
                    onClick={() => setIsKeyboardOpen(false)}
                    className="p-1 rounded text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Modifier & Special Action Keys */}
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "Ctrl", key: "Ctrl" },
                    { label: "Alt", key: "Alt" },
                    { label: "Shift", key: "Shift" },
                    { label: "Esc", key: "Escape" },
                    { label: "Tab", key: "Tab" },
                    { label: "Win", key: "Win" },
                    { label: "Enter", key: "Enter" },
                    { label: "⌫", key: "Backspace" },
                    { label: "Space", key: "Space" },
                    { label: "↑", key: "ArrowUp" },
                    { label: "↓", key: "ArrowDown" },
                    { label: "←", key: "ArrowLeft" },
                    { label: "→", key: "ArrowRight" },
                  ].map((k) => (
                    <button
                      key={k.label}
                      onClick={() => sendKey(k.key)}
                      className="px-2 py-1 rounded bg-slate-800 active:bg-cyan-500 active:text-slate-950 hover:bg-slate-700 text-[11px] font-mono font-semibold text-slate-200 border border-slate-700 transition-colors"
                    >
                      {k.label}
                    </button>
                  ))}
                </div>

                {/* Direct Text Input & Send */}
                <form onSubmit={sendTypedText} className="flex gap-1.5">
                  <input
                    type="text"
                    value={keyboardText}
                    onChange={(e) => setKeyboardText(e.target.value)}
                    placeholder="Type words/URLs to send to Windows..."
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-1"
                  >
                    <Send className="w-3 h-3" />
                    <span>Send</span>
                  </button>
                </form>
              </div>
            )}

            {/* Gesture Guide Overlay */}
            <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between pointer-events-none opacity-60">
              <span className="px-2 py-0.5 rounded-full bg-black/80 backdrop-blur-sm text-[9px] font-mono text-cyan-400 border border-cyan-500/30">
                Tap: Click • Hold: Right Click • 2-Finger: Scroll
              </span>
            </div>
          </div>
        )}

        {/* ========================================= */}
        {/* TAB 2: VOICE AUTOMATION & INTENTS */}
        {/* ========================================= */}
        {activeTab === "voice" && (
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto bg-[#070A13]">
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
                    Intent: {pendingVoiceIntent.type} • Risk: {pendingVoiceIntent.riskLevel?.toUpperCase()}
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
              <p className="text-xs font-semibold text-slate-300">Quick Voice Automation Presets:</p>
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

        {/* ========================================= */}
        {/* TAB 3: SECURITY & SESSION CONTROL */}
        {/* ========================================= */}
        {activeTab === "security" && (
          <div className="flex-1 flex flex-col p-4 gap-4 bg-[#070A13]">
            <div className="glass-panel rounded-2xl p-5 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                <ShieldAlert className="w-4 h-4 text-cyan-400" />
                <span>Active Session Security</span>
              </div>
              <p className="text-xs text-slate-400">
                Authenticated session is secured with signed HMAC tokens, paired with your Windows Host PC.
              </p>
              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono space-y-1">
                <p><span className="text-slate-500">Host IP:</span> {hostIp}</p>
                <p><span className="text-slate-500">Session Token:</span> {authToken.slice(0, 16)}...</p>
                <p><span className="text-slate-500">Transport:</span> Encrypted WebSockets & WebRTC</p>
                <p><span className="text-slate-500">Stream Status:</span> {streamStatus}</p>
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

      {/* Streamlined Bottom Navigation Bar: Screen, Voice, Security */}
      <nav className="h-14 bg-[#0E1526] border-t border-cyan-500/20 grid grid-cols-3 items-center px-4 z-20">
        {[
          { id: "screen", label: "Live Desktop", icon: Tv },
          { id: "voice", label: "Voice Automation", icon: Mic },
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
