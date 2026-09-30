# JARVIS V1 — Autonomous AI Workspace Companion & PC Control Deck

A secure, local-first monorepo that unites **Windows PC Host** hardware automation with an **Android Mobile Controller PWA** using a single responsive Next.js App Router UI, Node.js/Express backend, Electron desktop shell, Socket.IO signaling, WebRTC low-latency screen streaming, and interactive Windows PTY terminals.

---

## 🏗️ Architecture & Monorepo Structure

```
control/
├── package.json               # Root npm workspaces configuration
├── .npmrc                     # React 19 / legacy peer deps configuration
├── .env.example               # Environment template
│
├── packages/
│   ├── shared/                # @jarvis/shared
│   │   ├── src/schemas/       # Zod schemas (Auth, Control, Terminal, Voice, WebRTC)
│   │   ├── src/crypto/        # One-time nonce generators & HMAC SHA-256 token verification
│   │   └── src/index.ts       # Shared TypeScript exports
│   │
│   ├── server/                # @jarvis/server (Node.js + Express + Socket.IO + Win32 Automation)
│   │   ├── src/services/
│   │   │   ├── lan.ts                 # Local Wi-Fi IPv4 discovery
│   │   │   ├── pairingManager.ts      # 60s expiring nonces, rate limiter & approval state machine
│   │   │   ├── inputAutomation.ts     # User32.dll SendInput runtime with coordinate scaling
│   │   │   ├── terminalManager.ts     # Windows PowerShell/CMD ConPTY interactive session stream
│   │   │   ├── voiceEngine.ts         # English & Bengali intent parser with risk scoring
│   │   │   ├── automationExecutor.ts  # Deterministic VS Code, Antigravity, Browser & File runner
│   │   │   └── screenStreamManager.ts # WebRTC signaling coordinator
│   │   ├── src/socket/socketHandler.ts# Zod-validated, authenticated Socket.IO gateway
│   │   ├── src/routes/api.ts          # REST endpoints (Health, Pairing, Sessions, System)
│   │   ├── src/tests/security.test.ts # Cryptographic & approval gate test suite
│   │   ├── src/tests/e2e.test.ts      # Full E2E lifecycle test suite
│   │   └── src/server.ts              # Express + Socket.IO server startup
│   │
│   ├── web/                   # @jarvis/web (Next.js 16 App Router PWA)
│   │   ├── public/
│   │   │   ├── manifest.json          # Android PWA standalone manifest
│   │   │   └── icon.svg               # Vector app icon
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── layout.tsx         # Mobile viewport & PWA meta
│   │   │   │   ├── globals.css        # Cyberpunk dark theme with glassmorphism & touch rules
│   │   │   │   └── page.tsx           # Launch screen: "Show QR Code" vs "Scan QR Code"
│   │   │   ├── components/
│   │   │   │   ├── HostDeck.tsx       # Windows Host dashboard, QR generator & Host Approval modal
│   │   │   │   └── ControllerDeck.tsx # Android PWA controller (Screen, Trackpad, Terminal, Voice, Security)
│   │   │   └── lib/
│   │   │       ├── socket.ts          # Client Socket.IO manager
│   │   │       └── webrtc.ts          # WebRTC P2P low-latency screen streaming
│   │
│   └── desktop/               # @jarvis/desktop (Windows Electron Shell)
│       ├── src/
│       │   ├── main.ts                # Electron main process (contextIsolation: true, sandbox: false)
│       │   └── preload.ts             # Secure contextBridge API for Host UI & desktopCapturer
│       └── package.json               # Electron builder config for NSIS installer & portable EXE
```

---

## 🔒 Security Architecture

1. **Host-Approved Pairing Handshake**:
   - One-time QR codes contain an expiring 60-second cryptographic nonce (`nonce`).
   - Scanners submit a pairing challenge request with client device fingerprint.
   - **Host approval is mandatory**: The Windows host PC displays a prominent prompt with device details (IP, OS, Name) and countdown timer.
   - Access is granted **ONLY** upon explicit user approval on the PC.
   - Session tokens are signed using HMAC SHA-256 with expiration checks.
2. **Untrusted Spoken Input & Safety Confirmation Gates**:
   - Voice transcripts (English & Bengali) are treated as untrusted input.
   - Destructive operations (`delete file`, `install extension`, `run dangerous shell command`) require explicit interactive user confirmation before execution.
3. **Restricted Electron Boundaries**:
   - `contextIsolation: true`, `nodeIntegration: false`.
   - Strictly typed preload bridge without exposing raw Node.js internals or shell execution.
4. **Emergency Kill-Switch**:
   - Single-click **"Revoke All Sessions / Kill Switch"** immediately invalidates all active tokens, disconnects WebRTC video streams, and terminates child terminal processes.

---

## 🚀 Quickstart & Running Instructions

### 1. Prerequisites
- **Node.js**: v18+ (tested on Node.js v24 LTS)
- **Windows OS**: Windows 10/11 for Host PC
- **Android Device**: Chrome / Android Browser connected to the **same Wi-Fi network**.

### 2. Install Dependencies
```bash
npm install --legacy-peer-deps
```

### 3. Build All Workspaces
```bash
npm run build:shared
npm run build:server
npm run build:desktop
npm run build:web
```

### 4. Run Automated Tests
```bash
# Run Cryptographic Security & Voice Intent Tests
npm run test:security

# Run Full End-to-End Handshake & Control Lifecycle Tests
npm run test:e2e
```

### 5. Launch the System
In separate terminal tabs:

**Tab 1 — Start Backend Server & Automation Agent:**
```bash
npm run dev:server
```
*(Starts on `http://0.0.0.0:4000`)*

**Tab 2 — Start Web & PWA Interface:**
```bash
npm run dev:web
```
*(Starts on `http://0.0.0.0:3000`)*

**Tab 3 (Optional) — Launch Windows Electron Desktop Shell:**
```bash
npm run dev:desktop
```

---

## 📱 Android PWA Pairing Instructions

1. Open your browser or launch the Electron host app on your Windows PC and select **"Show QR Code"**.
2. On your Android phone or tablet (connected to the same Wi-Fi), open Chrome and navigate to:
   ```
   http://<YOUR_WINDOWS_PC_LAN_IP>:3000/?mode=controller
   ```
3. Tap the browser menu `⋮` and select **"Add to Home Screen"** or **"Install App"** to install the JARVIS standalone PWA.
4. Tap **"Scan Host QR Code"** and scan the QR code displayed on your Windows PC monitor.
5. On your Windows PC, an approval alert will pop up. Click **"Approve"**.
6. Your Android device will immediately connect, launching the low-latency screen mirror, virtual trackpad, live PowerShell terminal, and voice control deck!

---

## 🎙️ Supported Voice Commands (Bilingual)

| Voice Command (English) | Voice Command (Bengali / বাংলা) | Action & Safety Level |
| :--- | :--- | :--- |
| `open vs code` | `ভিএস কোড খোলো` | Launches VS Code editor |
| `launch antigravity` | `অ্যান্টিগ্র্যাভিটি খোলো` | Launches Antigravity IDE |
| `open project <name>` | `প্রজেক্ট খোলো <name>` | Opens workspace directory in editor |
| `open youtube and play <query>` | `ইউটিউবে গান চালাও <query>` | Opens YouTube in browser & plays query |
| `run command <cmd>` | `কমান্ড চালাও <cmd>` | Terminal execution (*Requires Confirmation*) |
| `install extension <id>` | `এক্সটেনশন ইন্সটল করো <id>` | VS Code Extension (*Requires Approval*) |
| `delete file <path>` | `ফাইল ডিলিট করো <path>` | File Deletion (*Critical Risk Approval*) |
| `antigravity prompt <text>` | `অ্যান্টিগ্র্যাভিটিতে প্রম্পট দাও <text>` | Injects prompt to active Antigravity session |

---

## 📦 Windows Installer Packaging

To compile a native Windows installer (`.exe`) or portable executable:
```bash
npm run dist --workspace=@jarvis/desktop
```
Outputs installer artifacts to `packages/desktop/dist/`.
