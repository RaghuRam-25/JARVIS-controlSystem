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
  RefreshCw,
  Move,
  Clipboard,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  AlertCircle
} from "lucide-react";
import { Html5Qrcode } from "html5-qrcode";
import { getSocket, disconnectSocket } from "../lib/socket";
import { WebRTCStreamer } from "../lib/webrtc";
import { API_ENDPOINTS, apiUrl, resolveHostApiUrl } from "../lib/env";

type StreamStatus = "DISCONNECTED" | "CONNECTING" | "WAITING_FOR_SCREEN" | "STREAMING_LIVE" | "ERROR";
type VoiceStatus = "IDLE" | "LISTENING" | "PROCESSING" | "SUCCESS" | "ERROR";

const ZOOM_LEVELS = [75, 80, 90, 100, 110, 125, 150];

export function ControllerDeck({ onSwitchToHost }: { onSwitchToHost: () => void }) {
  // Connection & Auth State
  const [isPaired, setIsPaired] = useState<boolean>(false);
  const [isWaitingApproval, setIsWaitingApproval] = useState<boolean>(false);
  const [authToken, setAuthToken] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [hostIp, setHostIp] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"screen" | "voice" | "security">("screen");
  const [manualNonce, setManualNonce] = useState<string>("");
  const [manualChallengeId, setManualChallengeId] = useState<string>("");
  const [scannerActive, setScannerActive] = useState<boolean>(false);

  // Stream & Interactive Screen State
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("DISCONNECTED");
  const [keyboardText, setKeyboardText] = useState<string>("");
  const [isDragMode, setIsDragMode] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [touchIndicator, setTouchIndicator] = useState<{ x: number; y: number; visible: boolean; isRightClick?: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });

  // Keyboard Modifier States
  const [modifiers, setModifiers] = useState<{
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    win: boolean;
    caps: boolean;
  }>({
    ctrl: false,
    alt: false,
    shift: false,
    win: false,
    caps: false,
  });

  // Voice State
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("IDLE");
  const [voiceLang, setVoiceLang] = useState<"en-US" | "bn-BD">("en-US");
  const [transcript, setTranscript] = useState<string>("");
  const [voiceErrorMsg, setVoiceErrorMsg] = useState<string | null>(null);
  const [pendingVoiceIntent, setPendingVoiceIntent] = useState<any>(null);
  const [voiceLog, setVoiceLog] = useState<string[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Refs
  const socketRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const webrtcStreamerRef = useRef<WebRTCStreamer | null>(null);
  const recognitionRef = useRef<any>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const longPressFiredRef = useRef<boolean>(false);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);

  // Pairing & Scanner Refs
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const isScanningRef = useRef<boolean>(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeChallengeIdRef = useRef<string | null>(null);
  const lastScannedChallengeRef = useRef<{ challengeId: string; timestamp: number } | null>(null);
  const sessionIdRef = useRef<string>("");
  const authTokenRef = useRef<string>("");
  const hostIpRef = useRef<string>("");

  useEffect(() => {
    sessionIdRef.current = sessionId;
    authTokenRef.current = authToken;
    hostIpRef.current = hostIp;
  }, [sessionId, authToken, hostIp]);

  // Load saved zoom level
  useEffect(() => {
    const savedZoom = localStorage.getItem("jarvis_zoom_level");
    if (savedZoom) {
      const parsed = parseInt(savedZoom, 10);
      if (ZOOM_LEVELS.includes(parsed)) setZoomLevel(parsed);
    }
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleZoom = (delta: number) => {
    const currentIndex = ZOOM_LEVELS.indexOf(zoomLevel);
    let newIndex = currentIndex !== -1 ? currentIndex + delta : 3;
    newIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, newIndex));
    const newZoom = ZOOM_LEVELS[newIndex];
    setZoomLevel(newZoom);
    localStorage.setItem("jarvis_zoom_level", String(newZoom));
    showToast(`Zoom: ${newZoom}%`);
  };

  const resetZoom = () => {
    setZoomLevel(100);
    localStorage.setItem("jarvis_zoom_level", "100");
    showToast("Zoom: 100%");
  };

  const stopQrScanner = useCallback(() => {
    if (html5QrCodeRef.current) {
      try {
        html5QrCodeRef.current.stop().catch(() => {});
      } catch {}
      html5QrCodeRef.current = null;
    }
    setScannerActive(false);
  }, []);

  const handleDisconnect = useCallback(() => {
    const currentSessionId = sessionIdRef.current || localStorage.getItem("jarvis_session_id");
    const currentToken = authTokenRef.current || localStorage.getItem("jarvis_controller_token");
    const currentHost = hostIpRef.current || localStorage.getItem("jarvis_host_ip");

    if (currentSessionId && currentHost && currentToken) {
      const serverUrl = resolveHostApiUrl(currentHost);
      fetch(apiUrl(API_ENDPOINTS.pairingRevoke, serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify({ sessionId: currentSessionId, reason: "Controller disconnected" }),
      }).catch(() => {});

      if (socketRef.current) {
        socketRef.current.emit("session:revoke", {
          sessionId: currentSessionId,
          reason: "Controller disconnected",
        });
      }
    }

    if (webrtcStreamerRef.current) {
      webrtcStreamerRef.current.stop();
      webrtcStreamerRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (socketRef.current) {
      try {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
      } catch {}
      socketRef.current = null;
    }
    disconnectSocket();

    stopQrScanner();

    localStorage.removeItem("jarvis_controller_token");
    localStorage.removeItem("jarvis_session_id");
    localStorage.removeItem("jarvis_host_ip");

    setIsPaired(false);
    setAuthToken("");
    setSessionId("");
    setIsWaitingApproval(false);
    setStreamStatus("DISCONNECTED");
    setScannerActive(false);
    setManualNonce("");
    setManualChallengeId("");
    setIsDragMode(false);
    setPendingVoiceIntent(null);
    setTranscript("");
    setVoiceStatus("IDLE");

    activeRequestIdRef.current = null;
    activeChallengeIdRef.current = null;
    isScanningRef.current = false;
    lastScannedChallengeRef.current = null;
    pointerDownPosRef.current = null;
    isDraggingRef.current = false;
    longPressFiredRef.current = false;
    lastTouchCenterRef.current = null;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, [stopQrScanner]);

  const handleCancelRequest = useCallback(() => {
    const reqId = activeRequestIdRef.current;
    const chId = activeChallengeIdRef.current;
    const currentHost = hostIpRef.current;

    if (currentHost && (reqId || chId)) {
      const serverUrl = resolveHostApiUrl(currentHost);
      fetch(apiUrl(API_ENDPOINTS.pairingCancel, serverUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: reqId || undefined, challengeId: chId || undefined }),
      }).catch(() => {});

      if (socketRef.current) {
        socketRef.current.emit("pairing:cancel", { requestId: reqId, challengeId: chId });
      }
    }

    if (socketRef.current) {
      try {
        socketRef.current.off("pairing:approved");
        socketRef.current.off("pairing:rejected");
        socketRef.current.off("pairing:status");
      } catch {}
    }

    activeRequestIdRef.current = null;
    activeChallengeIdRef.current = null;
    isScanningRef.current = false;
    lastScannedChallengeRef.current = null;
    setIsWaitingApproval(false);
    setManualNonce("");
    setManualChallengeId("");
    stopQrScanner();
  }, [stopQrScanner]);

  const initWebRTCViewer = useCallback((socket: any) => {
    setStreamStatus("WAITING_FOR_SCREEN");
    if (webrtcStreamerRef.current) {
      webrtcStreamerRef.current.stop();
      webrtcStreamerRef.current = null;
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

  const connectToHost = useCallback((ip: string, token: string, newSessionId?: string) => {
    setStreamStatus("CONNECTING");
    const serverUrl = resolveHostApiUrl(ip);
    const socket = getSocket(serverUrl, { token }, true);
    socketRef.current = socket;

    socket.emit("auth:authenticate", { token });

    const initConnection = () => {
      console.log("[PAIRING] Connected and authenticated with JARVIS host:", ip);
      setIsPaired(true);
      setIsWaitingApproval(false);
      localStorage.setItem("jarvis_controller_token", token);
      localStorage.setItem("jarvis_host_ip", ip);
      if (newSessionId) {
        setSessionId(newSessionId);
        localStorage.setItem("jarvis_session_id", newSessionId);
      }

      initWebRTCViewer(socket);
    };

    socket.off("auth:success");
    socket.on("auth:success", (payload?: any) => {
      if (payload?.session?.sessionId) {
        setSessionId(payload.session.sessionId);
        localStorage.setItem("jarvis_session_id", payload.session.sessionId);
      }
      initConnection();
    });

    socket.off("auth:error");
    socket.on("auth:error", ({ message }: { message: string }) => {
      console.warn("Auth error from host:", message);
      handleDisconnect();
    });

    socket.off("connect");
    socket.on("connect", () => {
      socket.emit("auth:authenticate", { token });
      initConnection();
    });

    socket.off("voice:parsed");
    socket.on("voice:parsed", (intent: any) => {
      console.log("[JARVIS VOICE] Command acknowledged", intent);
      if (intent.requiresExplicitApproval) {
        setPendingVoiceIntent(intent);
        setVoiceStatus("IDLE");
      } else {
        // Auto-execute safe commands
        console.log("[JARVIS VOICE] Sending command (auto-exec)");
        socket.emit("voice:execute", {
          intentId: intent.id,
          approved: true,
          rawTranscript: intent.rawTranscript,
          language: intent.language,
        });
      }
    });

    socket.off("voice:result");
    socket.on("voice:result", (result: any) => {
      console.log("[JARVIS VOICE] Execution completed", result);
      setVoiceStatus(result.success ? "SUCCESS" : "ERROR");
      setVoiceLog((prev) => [
        `[${new Date().toLocaleTimeString()}] ${result.message}`,
        ...prev.slice(0, 10),
      ]);
      setTimeout(() => setVoiceStatus("IDLE"), 2500);
    });

    socket.off("session:revoked");
    socket.on("session:revoked", () => {
      alert("Session was revoked by Host PC.");
      handleDisconnect();
    });

    socket.off("host:offline");
    socket.on("host:offline", ({ event, message }: { event: string; message: string }) => {
      console.warn(`[JARVIS] HOST_OFFLINE for event "${event}": ${message}`);
      setVoiceLog((prev) => [
        `[${new Date().toLocaleTimeString()}] ⚠ HOST OFFLINE: ${message}`,
        ...prev.slice(0, 10),
      ]);
    });

    socket.off("host:status");
    socket.on("host:status", ({ online }: { online: boolean }) => {
      console.log(`[JARVIS] Windows Host Agent status: ${online ? "ONLINE" : "OFFLINE"}`);
      if (!online) {
        setVoiceLog((prev) => [
          `[${new Date().toLocaleTimeString()}] ⚠ Windows Host Agent disconnected`,
          ...prev.slice(0, 10),
        ]);
      }
    });
  }, [initWebRTCViewer, handleDisconnect]);

  // Restore saved session from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem("jarvis_controller_token");
    const savedHostIp = localStorage.getItem("jarvis_host_ip");
    const savedSessionId = localStorage.getItem("jarvis_session_id");
    if (savedToken && savedHostIp) {
      setAuthToken(savedToken);
      setHostIp(savedHostIp);
      if (savedSessionId) setSessionId(savedSessionId);
      connectToHost(savedHostIp, savedToken, savedSessionId || undefined);
    }
  }, [connectToHost]);

  // Initialize Speech Recognition
  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recog = new SpeechRecognition();
        recog.continuous = false;
        recog.interimResults = true;
        recog.lang = voiceLang;

        recog.onstart = () => {
          console.log("[JARVIS VOICE] Listening started");
          setVoiceStatus("LISTENING");
          setVoiceErrorMsg(null);
        };

        recog.onresult = (event: any) => {
          const current = event.resultIndex;
          const text = event.results[current][0].transcript;
          console.log("[JARVIS VOICE] Transcript: " + text);
          setTranscript(text);
        };

        recog.onend = () => {
          if (transcript) {
            console.log("[JARVIS VOICE] Final command: " + transcript);
            setVoiceStatus("PROCESSING");
            handleVoiceParse(transcript);
          } else {
            setVoiceStatus("IDLE");
          }
        };

        recog.onerror = (event: any) => {
          console.warn("[JARVIS VOICE] Recognition error:", event.error);
          setVoiceStatus("ERROR");
          if (event.error === "not-allowed") {
            setVoiceErrorMsg("Microphone permission denied. Please allow microphone access in your browser.");
          } else if (event.error === "no-speech") {
            setVoiceErrorMsg("No speech detected. Please speak clearly.");
          } else {
            setVoiceErrorMsg(`Voice recognition error: ${event.error}`);
          }
          setTimeout(() => {
            if (voiceStatus === "ERROR") setVoiceStatus("IDLE");
          }, 3500);
        };

        recognitionRef.current = recog;
      }
    }
  }, [voiceLang, transcript]);

  // QR Scanner Handler
  const startQrScanner = () => {
    setScannerActive(true);
    isScanningRef.current = false;
    setTimeout(() => {
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCodeRef.current = html5QrCode;
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          const now = Date.now();
          if (isScanningRef.current) return;

          try {
            const payload = JSON.parse(decodedText);
            if (!payload.challengeId || !payload.nonce) {
              console.warn("Invalid QR code payload: missing challengeId or nonce");
              return;
            }

            if (
              lastScannedChallengeRef.current &&
              lastScannedChallengeRef.current.challengeId === payload.challengeId &&
              now - lastScannedChallengeRef.current.timestamp < 3000
            ) {
              return;
            }

            isScanningRef.current = true;
            lastScannedChallengeRef.current = { challengeId: payload.challengeId, timestamp: now };

            stopQrScanner();

            const targetHost = payload.serverUrl || payload.hostIp;
            await submitPairingRequest(targetHost, payload.challengeId, payload.nonce);
          } catch (err) {
            console.error("Invalid QR payload format:", err);
          }
        },
        () => {}
      ).catch((err) => {
        console.warn("Camera failed or permission denied:", err);
      });
    }, 200);
  };

  const submitPairingRequest = async (targetHost: string, challengeId: string, nonce: string) => {
    if (!targetHost || !challengeId || !nonce) {
      alert("Missing pairing details. Please scan a valid QR code.");
      isScanningRef.current = false;
      return;
    }

    setIsWaitingApproval(true);
    setHostIp(targetHost);
    activeChallengeIdRef.current = challengeId;

    try {
      const deviceName = `${navigator.userAgent.includes("Android") ? "Android Phone" : "Mobile Controller"} (${navigator.platform || "Touch"})`;
      const fingerprint = `client-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const serverUrl = resolveHostApiUrl(targetHost);
      const socket = getSocket(serverUrl, undefined, true);
      socketRef.current = socket;

      socket.off("pairing:approved");
      socket.on("pairing:approved", (decision: any) => {
        if (!decision?.token) return;
        console.log("[PAIRING] Host approved connection request. Authenticating session...");
        setIsWaitingApproval(false);
        setIsPaired(true);
        setAuthToken(decision.token);
        if (decision.sessionId) setSessionId(decision.sessionId);
        connectToHost(targetHost, decision.token, decision.sessionId);
      });

      socket.off("pairing:rejected");
      socket.on("pairing:rejected", (payload: any) => {
        alert(payload?.message || "Pairing rejected by host.");
        isScanningRef.current = false;
        lastScannedChallengeRef.current = null;
        setIsWaitingApproval(false);
      });

      let socketId = socket.id;
      if (!socketId && !socket.connected) {
        socketId = await new Promise<string | undefined>((resolve) => {
          socket.once("connect", () => resolve(socket.id));
          setTimeout(() => resolve(socket.id), 2000);
        });
      }

      const pairingPayload = {
        challengeId,
        nonce,
        clientName: deviceName,
        clientFingerprint: fingerprint,
        deviceType: "phone" as const,
        socketId: socket.id || socketId || undefined,
      };

      const res = await fetch(apiUrl(API_ENDPOINTS.pairingRequest, serverUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(pairingPayload.socketId ? { "X-Socket-Id": pairingPayload.socketId } : {}),
        },
        body: JSON.stringify(pairingPayload),
      });

      const data = await res.json();
      if (!data.success) {
        isScanningRef.current = false;
        lastScannedChallengeRef.current = null;
        setIsWaitingApproval(false);

        if (data.message?.includes("expired") || data.message?.includes("consumed")) {
          alert("PAIRING EXPIRED or ALREADY CONSUMED.\nPlease scan the NEW QR from the Host PC.");
        } else {
          alert(data.message || "Pairing request rejected by server.");
        }
        return;
      }

      activeRequestIdRef.current = data.requestId || null;
    } catch (err: any) {
      isScanningRef.current = false;
      lastScannedChallengeRef.current = null;
      alert(`Connection failed: ${err.message}`);
      setIsWaitingApproval(false);
    }
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
    
    if (videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    }

    const coords = calculateNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

    pointerDownPosRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
    longPressFiredRef.current = false;
    isDraggingRef.current = false;

    setTouchIndicator({ x: e.clientX, y: e.clientY, visible: true, isRightClick: false });

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

    if (dx > 10 || dy > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    const coords = calculateNormalizedCoords(e.clientX, e.clientY);
    if (!coords) return;

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
  };

  // Keyboard Helpers
  const sendKey = (key: string) => {
    if (navigator.vibrate) navigator.vibrate(10);

    // Toggle modifiers
    if (key === "Ctrl") {
      setModifiers((prev) => ({ ...prev, ctrl: !prev.ctrl }));
      return;
    }
    if (key === "Alt") {
      setModifiers((prev) => ({ ...prev, alt: !prev.alt }));
      return;
    }
    if (key === "Shift") {
      setModifiers((prev) => ({ ...prev, shift: !prev.shift }));
      return;
    }
    if (key === "Win") {
      setModifiers((prev) => ({ ...prev, win: !prev.win }));
      return;
    }
    if (key === "Caps") {
      setModifiers((prev) => ({ ...prev, caps: !prev.caps }));
      return;
    }

    const effectiveModifiers = {
      ctrl: modifiers.ctrl,
      alt: modifiers.alt,
      shift: modifiers.shift,
      meta: modifiers.win,
    };

    socketRef.current?.emit("control:key", {
      key,
      action: "press",
      modifiers: effectiveModifiers,
    });

    // Auto-release non-caps modifiers after keypress
    if (modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.win) {
      setModifiers((prev) => ({ ...prev, shift: false, ctrl: false, alt: false, win: false }));
    }
  };

  const sendTypedText = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!keyboardText) return;
    socketRef.current?.emit("control:type", { text: keyboardText });
    showToast(`Sent: "${keyboardText}"`);
    setKeyboardText("");
  };

  const handlePaste = async () => {
    try {
      let text = "";
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
      if (!text) {
        text = prompt("Paste text to send to Windows:") || "";
      }
      if (text) {
        socketRef.current?.emit("control:type", { text });
        showToast(`Pasted ${text.length} characters`);
      }
    } catch {
      const text = prompt("Paste text to send to Windows:");
      if (text) {
        socketRef.current?.emit("control:type", { text });
        showToast(`Pasted ${text.length} characters`);
      }
    }
  };

  // Voice Helpers
  const toggleVoice = () => {
    setVoiceErrorMsg(null);
    if (voiceStatus === "LISTENING") {
      recognitionRef.current?.stop();
      setVoiceStatus("IDLE");
    } else {
      setTranscript("");
      setPendingVoiceIntent(null);
      try {
        if (recognitionRef.current) {
          recognitionRef.current.lang = voiceLang;
          recognitionRef.current.start();
        } else {
          const text = prompt("Enter speech command (e.g. 'open vs code' or 'ক্রোম খোলো'):");
          if (text) {
            setTranscript(text);
            handleVoiceParse(text);
          }
        }
      } catch (err: any) {
        const text = prompt("Enter voice command:");
        if (text) handleVoiceParse(text);
      }
    }
  };

  const handleVoiceParse = (text: string) => {
    console.log("[JARVIS VOICE] Sending voice:parse for transcript: " + text);
    socketRef.current?.emit("voice:parse", { text, language: voiceLang === "bn-BD" ? "bn" : "en" });
  };

  const executeVoiceIntent = (approved: boolean) => {
    if (!pendingVoiceIntent) return;
    if (approved) {
      console.log("[JARVIS VOICE] Sending approved voice:execute command");
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
      <div className="h-[100dvh] max-h-[100dvh] w-full bg-[#070a13] text-[#f0f6fc] p-4 flex flex-col items-center justify-center overflow-y-auto">
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
                onClick={handleCancelRequest}
                className="px-3 py-1.5 rounded-lg bg-red-950/50 hover:bg-red-900 text-xs text-red-400 border border-red-500/30 transition-colors mt-2"
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
                    onClick={stopQrScanner}
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

  // Determine uppercase state
  const isShifted = modifiers.shift || modifiers.caps;

  // ==========================================
  // AUTHENTICATED CONTROLLER WORKSPACE
  // ==========================================
  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full bg-[#070a13] text-[#f0f6fc] flex flex-col select-none overflow-hidden touch-none fixed inset-0">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-full bg-cyan-950/90 text-cyan-300 text-xs border border-cyan-500/50 shadow-lg backdrop-blur-md animate-fade-in pointer-events-none">
          {toastMessage}
        </div>
      )}

      {/* Top Header Bar */}
      <header className="h-11 flex-shrink-0 px-3 bg-[#0e1526] border-b border-cyan-500/20 flex items-center justify-between z-30">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${streamStatus === "STREAMING_LIVE" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
          <div>
            <h1 className="text-xs font-bold text-slate-100 flex items-center gap-1.5">
              <span>JARVIS</span>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-500/30">
                {streamStatus === "STREAMING_LIVE" ? "LIVE" : streamStatus.replace(/_/g, " ")}
              </span>
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Zoom Controls */}
          <div className="flex items-center bg-slate-900 rounded-lg border border-slate-700/80 p-0.5">
            <button
              onClick={() => handleZoom(-1)}
              className="p-1 rounded text-slate-400 hover:text-cyan-300 active:bg-slate-800"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={resetZoom}
              className="px-1.5 text-[10px] font-mono text-cyan-300 font-semibold"
              title="Reset Zoom to 100%"
            >
              {zoomLevel}%
            </button>
            <button
              onClick={() => handleZoom(1)}
              className="p-1 rounded text-slate-400 hover:text-cyan-300 active:bg-slate-800"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Drag Mode Toggle */}
          <button
            onClick={() => setIsDragMode((prev) => !prev)}
            className={`px-2 py-1 rounded-lg text-[10px] font-semibold border transition-all flex items-center gap-1 ${
              isDragMode 
                ? "bg-amber-500/20 text-amber-300 border-amber-500/50 glow-amber" 
                : "bg-slate-800 text-slate-300 border-slate-700"
            }`}
            title="Toggle Drag/Select Mode"
          >
            <Move className="w-3 h-3" />
            <span>{isDragMode ? "Drag" : "Tap"}</span>
          </button>

          {/* Reconnect WebRTC Stream */}
          <button
            onClick={() => {
              if (socketRef.current) initWebRTCViewer(socketRef.current);
            }}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-cyan-400 border border-slate-700 text-xs"
            title="Refresh Stream"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          {/* Bengali / English Language Toggle */}
          <button
            onClick={() => setVoiceLang((prev) => (prev === "en-US" ? "bn-BD" : "en-US"))}
            className="px-2 py-1 rounded-lg bg-slate-800 text-[10px] font-medium text-cyan-300 border border-cyan-500/20 flex items-center gap-0.5"
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
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Workspace Area (No Document Scrolling) */}
      <main className="flex-1 flex flex-col overflow-hidden relative min-h-0 bg-[#070a13]">
        {/* ======================================================== */}
        {/* TAB 1: REMOTE SCREEN AT TOP + KEYBOARD/CONTROLS BELOW     */}
        {/* ======================================================== */}
        {activeTab === "screen" && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Top Section: Remote Laptop Screen */}
            <div 
              className="w-full bg-black relative flex items-center justify-center overflow-hidden flex-shrink-0"
              style={{
                height: "40vh",
                maxHeight: "42vh",
              }}
            >
              {/* Visual Touch Ripple */}
              {touchIndicator.visible && (
                <div
                  className={`absolute w-8 h-8 -ml-4 -mt-4 rounded-full pointer-events-none z-50 animate-ping ${
                    touchIndicator.isRightClick ? "bg-amber-400 border-2 border-amber-200" : "bg-cyan-400 border-2 border-white"
                  }`}
                  style={{ left: touchIndicator.x, top: touchIndicator.y }}
                />
              )}

              {/* Stream Placeholder / Waiting state */}
              {streamStatus !== "STREAMING_LIVE" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center z-10 bg-[#070a13]/90">
                  <div className="w-8 h-8 rounded-full border-3 border-cyan-500 border-t-transparent animate-spin" />
                  <p className="text-xs font-semibold text-cyan-300">
                    {streamStatus === "WAITING_FOR_SCREEN" ? "Waiting for Screen Stream from Host PC..." : "Connecting..."}
                  </p>
                  <button
                    onClick={() => {
                      if (socketRef.current) initWebRTCViewer(socketRef.current);
                    }}
                    className="mt-1 px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-[11px] font-semibold"
                  >
                    Retry Stream
                  </button>
                </div>
              )}

              {/* Live Interactive Video Surface */}
              <div 
                className="w-full h-full flex items-center justify-center transition-transform duration-100"
                style={{
                  transform: zoomLevel !== 100 ? `scale(${zoomLevel / 100})` : undefined,
                  transformOrigin: "center center",
                }}
              >
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
              </div>
            </div>

            {/* Bottom Section: Typing Bar + Full Realistic Keyboard Area (BELOW SCREEN) */}
            <div className="flex-1 flex flex-col bg-[#070a13] p-1.5 gap-1.5 overflow-y-auto min-h-0 border-t border-slate-800/80">
              {/* Direct Text Typing & Mobile Paste Box */}
              <div className="flex gap-1.5 flex-shrink-0">
                <form onSubmit={sendTypedText} className="flex-1 flex gap-1">
                  <input
                    type="text"
                    value={keyboardText}
                    onChange={(e) => setKeyboardText(e.target.value)}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (text) {
                        socketRef.current?.emit("control:type", { text });
                        showToast(`Pasted ${text.length} characters`);
                      }
                    }}
                    placeholder="Type words or paste text to send to Windows..."
                    className="flex-1 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1 glow-cyan"
                  >
                    <Send className="w-3 h-3" />
                    <span>Send</span>
                  </button>
                </form>

                {/* Mobile Paste Button */}
                <button
                  type="button"
                  onClick={handlePaste}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold text-xs border border-cyan-500/30 flex items-center gap-1"
                  title="Paste Clipboard Text"
                >
                  <Clipboard className="w-3.5 h-3.5" />
                  <span>Paste</span>
                </button>
              </div>

              {/* Realistic Full Virtual Keyboard (Grid of Keys) */}
              <div className="flex-1 flex flex-col gap-1 select-none overflow-y-auto min-h-0">
                {/* Row 1: Esc, Function Keys, Delete */}
                <div className="flex gap-0.5 w-full">
                  {[
                    { label: "Esc", key: "Escape" },
                    { label: "F1", key: "F1" },
                    { label: "F2", key: "F2" },
                    { label: "F3", key: "F3" },
                    { label: "F4", key: "F4" },
                    { label: "F5", key: "F5" },
                    { label: "F6", key: "F6" },
                    { label: "F7", key: "F7" },
                    { label: "F8", key: "F8" },
                    { label: "F9", key: "F9" },
                    { label: "F10", key: "F10" },
                    { label: "F11", key: "F11" },
                    { label: "F12", key: "F12" },
                    { label: "Del", key: "Delete" },
                  ].map((k) => (
                    <button
                      key={k.label}
                      onClick={() => sendKey(k.key)}
                      className="flex-1 py-1 text-[9px] font-mono font-semibold rounded key-cap text-slate-300"
                    >
                      {k.label}
                    </button>
                  ))}
                </div>

                {/* Row 2: Numbers & Symbols Row */}
                <div className="flex gap-0.5 w-full">
                  {[
                    { normal: "`", shifted: "~", key: isShifted ? "~" : "`" },
                    { normal: "1", shifted: "!", key: isShifted ? "!" : "1" },
                    { normal: "2", shifted: "@", key: isShifted ? "@" : "2" },
                    { normal: "3", shifted: "#", key: isShifted ? "#" : "3" },
                    { normal: "4", shifted: "$", key: isShifted ? "$" : "4" },
                    { normal: "5", shifted: "%", key: isShifted ? "%" : "5" },
                    { normal: "6", shifted: "^", key: isShifted ? "^" : "6" },
                    { normal: "7", shifted: "&", key: isShifted ? "&" : "7" },
                    { normal: "8", shifted: "*", key: isShifted ? "*" : "8" },
                    { normal: "9", shifted: "(", key: isShifted ? "(" : "9" },
                    { normal: "0", shifted: ")", key: isShifted ? ")" : "0" },
                    { normal: "-", shifted: "_", key: isShifted ? "_" : "-" },
                    { normal: "=", shifted: "+", key: isShifted ? "+" : "=" },
                    { normal: "⌫", shifted: "⌫", key: "Backspace", width: "w-10" },
                  ].map((k) => (
                    <button
                      key={k.normal}
                      onClick={() => sendKey(k.key)}
                      className={`${k.width || "flex-1"} py-1.5 text-[11px] font-mono font-semibold rounded key-cap text-slate-200`}
                    >
                      {k.key}
                    </button>
                  ))}
                </div>

                {/* Row 3: Tab + QWERTY */}
                <div className="flex gap-0.5 w-full">
                  <button
                    onClick={() => sendKey("Tab")}
                    className="w-9 py-1.5 text-[10px] font-mono font-semibold rounded key-cap key-cap-modifier text-slate-400"
                  >
                    Tab
                  </button>
                  {["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]", "\\"].map((char) => {
                    const displayChar = isShifted ? char.toUpperCase() : char;
                    return (
                      <button
                        key={char}
                        onClick={() => sendKey(displayChar)}
                        className="flex-1 py-1.5 text-[11px] font-mono font-semibold rounded key-cap text-slate-100"
                      >
                        {displayChar}
                      </button>
                    );
                  })}
                </div>

                {/* Row 4: Caps + Home Row + Enter */}
                <div className="flex gap-0.5 w-full">
                  <button
                    onClick={() => sendKey("Caps")}
                    className={`w-10 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.caps ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Caps
                  </button>
                  {["a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'"].map((char) => {
                    const displayChar = isShifted ? char.toUpperCase() : char;
                    return (
                      <button
                        key={char}
                        onClick={() => sendKey(displayChar)}
                        className="flex-1 py-1.5 text-[11px] font-mono font-semibold rounded key-cap text-slate-100"
                      >
                        {displayChar}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => sendKey("Enter")}
                    className="w-11 py-1.5 text-[10px] font-mono font-semibold rounded key-cap bg-cyan-900/60 text-cyan-300 border-cyan-500/40"
                  >
                    Enter
                  </button>
                </div>

                {/* Row 5: Shift + Bottom Row + Up Arrow + Shift */}
                <div className="flex gap-0.5 w-full">
                  <button
                    onClick={() => sendKey("Shift")}
                    className={`w-11 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.shift ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Shift
                  </button>
                  {["z", "x", "c", "v", "b", "n", "m", ",", ".", "/"].map((char) => {
                    const displayChar = isShifted ? char.toUpperCase() : char;
                    return (
                      <button
                        key={char}
                        onClick={() => sendKey(displayChar)}
                        className="flex-1 py-1.5 text-[11px] font-mono font-semibold rounded key-cap text-slate-100"
                      >
                        {displayChar}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => sendKey("ArrowUp")}
                    className="w-8 py-1.5 text-[11px] font-mono font-bold rounded key-cap text-cyan-300"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => sendKey("Shift")}
                    className={`w-9 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.shift ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Shift
                  </button>
                </div>

                {/* Row 6: Modifiers, Spacebar & Navigation */}
                <div className="flex gap-0.5 w-full">
                  <button
                    onClick={() => sendKey("Ctrl")}
                    className={`w-9 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.ctrl ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Ctrl
                  </button>
                  <button
                    onClick={() => sendKey("Win")}
                    className={`w-8 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.win ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Win
                  </button>
                  <button
                    onClick={() => sendKey("Alt")}
                    className={`w-8 py-1.5 text-[10px] font-mono font-semibold rounded key-cap ${modifiers.alt ? "key-cap-active" : "key-cap-modifier text-slate-400"}`}
                  >
                    Alt
                  </button>
                  <button
                    onClick={() => sendKey("Space")}
                    className="flex-1 py-1.5 text-[10px] font-mono font-semibold rounded key-cap text-slate-300"
                  >
                    Space
                  </button>
                  <button
                    onClick={() => sendKey("ArrowLeft")}
                    className="w-8 py-1.5 text-[11px] font-mono font-bold rounded key-cap text-cyan-300"
                  >
                    ←
                  </button>
                  <button
                    onClick={() => sendKey("ArrowDown")}
                    className="w-8 py-1.5 text-[11px] font-mono font-bold rounded key-cap text-cyan-300"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => sendKey("ArrowRight")}
                    className="w-8 py-1.5 text-[11px] font-mono font-bold rounded key-cap text-cyan-300"
                  >
                    →
                  </button>
                  <button
                    onClick={() => sendKey("Home")}
                    className="w-9 py-1.5 text-[9px] font-mono font-semibold rounded key-cap text-slate-400"
                  >
                    Home
                  </button>
                  <button
                    onClick={() => sendKey("End")}
                    className="w-9 py-1.5 text-[9px] font-mono font-semibold rounded key-cap text-slate-400"
                  >
                    End
                  </button>
                  <button
                    onClick={() => sendKey("PageUp")}
                    className="w-9 py-1.5 text-[9px] font-mono font-semibold rounded key-cap text-slate-400"
                  >
                    PgUp
                  </button>
                  <button
                    onClick={() => sendKey("PageDown")}
                    className="w-9 py-1.5 text-[9px] font-mono font-semibold rounded key-cap text-slate-400"
                  >
                    PgDn
                  </button>
                </div>
              </div>

              {/* Gesture Hint Bar */}
              <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 px-1 pt-0.5 border-t border-slate-800 flex-shrink-0">
                <span>Tap: Click • Hold: Right Click • 2-Finger: Scroll</span>
                <span className="text-cyan-400">{isDragMode ? "● DRAG ON" : "○ TAP MODE"}</span>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 2: VOICE AUTOMATION & SPEECH ENGINE                   */}
        {/* ======================================================== */}
        {activeTab === "voice" && (
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto bg-[#070A13]">
            {/* Main Microphone Action Card */}
            <div className="glass-panel rounded-2xl p-6 flex flex-col items-center text-center gap-4">
              <button
                onClick={toggleVoice}
                className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${
                  voiceStatus === "LISTENING"
                    ? "bg-red-500 glow-red animate-pulse text-white scale-110"
                    : voiceStatus === "PROCESSING"
                    ? "bg-amber-500 glow-amber text-slate-950 animate-spin scale-105"
                    : voiceStatus === "SUCCESS"
                    ? "bg-emerald-500 glow-emerald text-white"
                    : "bg-cyan-500/20 text-cyan-400 border-2 border-cyan-500/40 glow-cyan hover:scale-105"
                }`}
              >
                <Mic className="w-8 h-8" />
              </button>

              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-100 flex items-center justify-center gap-1.5">
                  <span>
                    {voiceStatus === "LISTENING"
                      ? "Listening... (Speak Now)"
                      : voiceStatus === "PROCESSING"
                      ? "Processing intent..."
                      : voiceStatus === "SUCCESS"
                      ? "Command Dispatched!"
                      : "Tap Microphone to Speak"}
                  </span>
                </p>
                <p className="text-xs text-slate-400">
                  Engine: <span className="font-semibold text-cyan-300">{voiceLang === "en-US" ? "English (US)" : "Bengali (বাংলা)"}</span>
                </p>
              </div>

              {/* Error Message if Permission Denied */}
              {voiceErrorMsg && (
                <div className="w-full p-3 rounded-xl bg-red-950/80 border border-red-500/40 text-xs text-red-300 flex items-center gap-2 text-left">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                  <span className="flex-1">{voiceErrorMsg}</span>
                  <button
                    onClick={toggleVoice}
                    className="px-2 py-1 rounded bg-red-800 text-[10px] text-white font-semibold"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Real-time Transcript */}
              {transcript && (
                <div className="w-full p-3 rounded-xl bg-slate-900/80 border border-cyan-500/30 text-xs text-cyan-300 font-medium">
                  "{transcript}"
                </div>
              )}
            </div>

            {/* Confirmation Gate for High-Risk Intents */}
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

            {/* Quick Presets */}
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

            {/* Execution History */}
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

        {/* ======================================================== */}
        {/* TAB 3: SECURITY & SESSION CONTROL                         */}
        {/* ======================================================== */}
        {activeTab === "security" && (
          <div className="flex-1 flex flex-col p-4 gap-4 bg-[#070A13] overflow-y-auto">
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
                <p><span className="text-slate-500">Zoom Level:</span> {zoomLevel}%</p>
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

      {/* ======================================================== */}
      {/* FIXED FOOTER NAVIGATION (ALWAYS VISIBLE, NO SCROLL)      */}
      {/* ======================================================== */}
      <nav 
        className="h-14 bg-[#0E1526] border-t border-cyan-500/20 grid grid-cols-3 items-center px-4 z-30 flex-shrink-0"
        style={{
          paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)",
        }}
      >
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
              className={`flex flex-col items-center justify-center gap-0.5 py-1 transition-colors ${
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
