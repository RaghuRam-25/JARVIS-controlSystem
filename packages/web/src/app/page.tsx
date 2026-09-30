"use client";

import React, { useState, useEffect } from "react";
import { HostDeck } from "../components/HostDeck";
import { ControllerDeck } from "../components/ControllerDeck";
import { Monitor, Smartphone, Shield, Zap, Sparkles } from "lucide-react";

export default function HomePage() {
  const [mode, setMode] = useState<"select" | "host" | "controller">("select");

  useEffect(() => {
    // Check URL query parameters or screen context
    const params = new URLSearchParams(window.location.search);
    const queryMode = params.get("mode");
    if (queryMode === "host") {
      setMode("host");
    } else if (queryMode === "controller") {
      setMode("controller");
    } else if (localStorage.getItem("jarvis_controller_token")) {
      // Auto-resume paired controller
      setMode("controller");
    }
  }, []);

  if (mode === "host") {
    return <HostDeck onSwitchToController={() => setMode("controller")} />;
  }

  if (mode === "controller") {
    return <ControllerDeck onSwitchToHost={() => setMode("host")} />;
  }

  return (
    <div className="min-h-screen bg-[#070a13] text-[#f0f6fc] flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 -translate-x-1/2 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-xl z-10 flex flex-col items-center text-center gap-8">
        {/* Header Branding */}
        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 text-xs font-medium glow-cyan">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span>JARVIS V1 — Autonomous Companion & Remote Control</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-cyan-400 via-teal-300 to-blue-500 bg-clip-text text-transparent">
            Choose Your Device Role
          </h1>
          <p className="text-sm text-slate-400 max-w-md mx-auto">
            Zero-latency Wi-Fi pairing with cryptographic one-time challenges and hardware-accelerated remote control.
          </p>
        </div>

        {/* Two Launch Mode Options */}
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Host Option */}
          <button
            onClick={() => setMode("host")}
            className="glass-panel glass-panel-hover rounded-2xl p-6 flex flex-col items-center text-center gap-4 transition-all text-left group cursor-pointer border border-cyan-500/20"
          >
            <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center glow-cyan group-hover:scale-105 transition-transform">
              <Monitor className="w-7 h-7 text-cyan-400" />
            </div>
            <div className="space-y-1">
              <h2 className="font-bold text-base text-slate-100 group-hover:text-cyan-300 transition-colors">
                Show QR Code
              </h2>
              <p className="text-xs text-slate-400">
                Host Mode for Windows PC. Broadcasts screen, manages pairing requests, and runs terminal & automation services.
              </p>
            </div>
            <span className="mt-2 text-xs font-semibold text-cyan-400 flex items-center gap-1 group-hover:underline">
              Launch Host Shell →
            </span>
          </button>

          {/* Controller Option */}
          <button
            onClick={() => setMode("controller")}
            className="glass-panel glass-panel-hover rounded-2xl p-6 flex flex-col items-center text-center gap-4 transition-all text-left group cursor-pointer border border-cyan-500/20"
          >
            <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center glow-cyan group-hover:scale-105 transition-transform">
              <Smartphone className="w-7 h-7 text-blue-400" />
            </div>
            <div className="space-y-1">
              <h2 className="font-bold text-base text-slate-100 group-hover:text-blue-300 transition-colors">
                Scan QR Code
              </h2>
              <p className="text-xs text-slate-400">
                Controller Mode for Android Phone/Tablet. Touch trackpad, low-latency screen mirror, terminal & voice commands.
              </p>
            </div>
            <span className="mt-2 text-xs font-semibold text-blue-400 flex items-center gap-1 group-hover:underline">
              Launch Controller Deck →
            </span>
          </button>
        </div>

        {/* Security and Feature Badges */}
        <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-500 pt-4 border-t border-slate-800/80">
          <div className="flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>Host-Approved Handshake</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-amber-400" />
            <span>Sub-50ms WebRTC Mirroring</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span>Bilingual Voice Engine</span>
          </div>
        </div>
      </div>
    </div>
  );
}
