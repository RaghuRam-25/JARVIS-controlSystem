import { Socket } from "socket.io-client";
import { ICE_SERVERS } from "./env";

export class WebRTCStreamer {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private socket: Socket;
  private onRemoteStreamCallback: ((stream: MediaStream) => void) | null = null;
  private candidateQueue: any[] = [];
  private signalListener: ((data: any) => Promise<void>) | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.initSocketListeners();
  }

  private initSocketListeners() {
    this.removeSocketListeners();

    this.signalListener = async (data: any) => {
      if (!data || !data.type) return;

      if (data.type === "offer") {
        console.log(`[JARVIS HOST] WebRTC offer received from viewer: ${data.sender || "unknown"}`);
        await this.handleOffer(data);
      } else if (data.type === "answer") {
        console.log("[JARVIS VIEWER] WebRTC answer received");
        await this.handleAnswer(data);
      } else if (data.type === "candidate") {
        await this.handleCandidate(data);
      } else if (data.type === "ready") {
        console.log("[JARVIS VIEWER] Host screen ready signal received, initiating WebRTC connection...");
        if (this.onRemoteStreamCallback) {
          await this.createViewerConnection(this.onRemoteStreamCallback);
        }
      } else if (data.type === "request_offer") {
        console.log("[JARVIS HOST] Viewer requested screen stream");
        if (this.localStream) {
          console.log("[JARVIS HOST] Screen stream is active, notifying viewer ready");
          this.socket.emit("webrtc:signal", {
            type: "ready",
            target: data.sender,
          });
        }
      } else if (data.type === "screen_stopped") {
        console.log("[JARVIS WEBRTC] Screen stream stopped signal received");
        this.stop();
      }
    };

    this.socket.on("webrtc:signal", this.signalListener);
  }

  private removeSocketListeners() {
    if (this.signalListener) {
      this.socket.off("webrtc:signal", this.signalListener);
      this.signalListener = null;
    }
  }

  /**
   * Host starts screen capture and initializes WebRTC broadcast
   */
  public async startHostCapture(): Promise<MediaStream> {
    try {
      console.log("[JARVIS HOST] Screen capture starting");
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: "always",
          frameRate: { ideal: 30, max: 60 },
        } as any,
        audio: false,
      });

      const videoTracks = this.localStream.getVideoTracks();
      console.log(`[JARVIS HOST] Screen stream acquired with ${videoTracks.length} video track(s)`);
      console.log(`[JARVIS HOST] Screen tracks: video=${videoTracks.length}`);

      // Handle user stopping screen share from the browser UI
      if (videoTracks[0]) {
        videoTracks[0].onended = () => {
          console.log("[JARVIS HOST] Screen capture stopped by user via browser bar");
          this.stop();
        };
      }

      // Broadcast ready signal to all connected viewers
      this.socket.emit("webrtc:signal", {
        type: "ready",
      });

      return this.localStream;
    } catch (err: any) {
      console.error("[JARVIS HOST] Failed to acquire screen capture:", err);
      throw err;
    }
  }

  /**
   * Viewer connects to receive the host's screen stream
   */
  public async createViewerConnection(onRemoteStream: (stream: MediaStream) => void): Promise<RTCPeerConnection> {
    this.onRemoteStreamCallback = onRemoteStream;
    this.candidateQueue = [];

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    console.log("[JARVIS VIEWER] Connecting to screen stream");
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });
    this.peerConnection = pc;
    console.log("[JARVIS VIEWER] PeerConnection created");
    console.log("[JARVIS VIEWER] Waiting for remote track");

    pc.ontrack = (event) => {
      console.log(`[JARVIS VIEWER] Remote track received: kind=${event.track.kind}, id=${event.track.id}`);
      if (event.streams && event.streams[0]) {
        console.log("[JARVIS VIEWER] Remote stream attached");
        onRemoteStream(event.streams[0]);
      } else if (event.track) {
        console.log("[JARVIS VIEWER] Remote single track stream attached");
        const stream = new MediaStream([event.track]);
        onRemoteStream(stream);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[JARVIS VIEWER] ICE candidate sent");
        this.socket.emit("webrtc:signal", {
          type: "candidate",
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[JARVIS WEBRTC] ICE state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        console.log("[JARVIS WEBRTC] ICE state: connected");
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[JARVIS VIEWER] WebRTC connection state: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        console.log("[JARVIS WEBRTC] Connection state: connected");
      }
    };

    // Request video track reception
    pc.addTransceiver("video", { direction: "recvonly" });

    console.log("[JARVIS VIEWER] Creating WebRTC offer");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log("[JARVIS VIEWER] WebRTC offer sent");
    this.socket.emit("webrtc:signal", {
      type: "offer",
      sdp: offer.sdp,
    });

    return pc;
  }

  /**
   * Host answers viewer offer with local screen media tracks
   */
  private async handleOffer(data: any) {
    if (!this.localStream) {
      console.warn("[JARVIS HOST] WebRTC offer received, but host screen stream is not yet active.");
      return;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });
    this.peerConnection = pc;
    this.candidateQueue = [];

    // Add local screen tracks to peer connection
    this.localStream.getTracks().forEach((track) => {
      console.log(`[JARVIS HOST] Adding track to PeerConnection: ${track.kind}`);
      pc.addTrack(track, this.localStream!);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[JARVIS HOST] ICE candidate sent");
        this.socket.emit("webrtc:signal", {
          type: "candidate",
          target: data.sender,
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[JARVIS WEBRTC] Host ICE state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        console.log("[JARVIS WEBRTC] ICE state: connected");
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[JARVIS HOST] WebRTC connection state: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        console.log("[JARVIS WEBRTC] Connection state: connected");
      }
    };

    console.log("[JARVIS HOST] Setting remote description from offer");
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: data.sdp }));
    await this.flushCandidates();

    console.log("[JARVIS HOST] Creating WebRTC answer");
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    console.log(`[JARVIS HOST] WebRTC answer sent to viewer: ${data.sender || "unknown"}`);
    this.socket.emit("webrtc:signal", {
      type: "answer",
      target: data.sender,
      sdp: answer.sdp,
    });
  }

  private async handleAnswer(data: any) {
    if (this.peerConnection && data.sdp) {
      console.log("[JARVIS VIEWER] Setting remote description from answer");
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
      await this.flushCandidates();
    }
  }

  private async handleCandidate(data: any) {
    if (!data.candidate) return;
    console.log("[JARVIS HOST] ICE candidate received");
    if (this.peerConnection && this.peerConnection.remoteDescription) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn("[JARVIS WEBRTC] Error adding ICE candidate:", e);
      }
    } else {
      this.candidateQueue.push(data.candidate);
    }
  }

  private async flushCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    while (this.candidateQueue.length > 0) {
      const candidate = this.candidateQueue.shift();
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("[JARVIS WEBRTC] Error flushing ICE candidate:", e);
      }
    }
  }

  public getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  public stop() {
    this.removeSocketListeners();

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      this.localStream = null;
      this.socket.emit("webrtc:signal", { type: "screen_stopped" });
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.candidateQueue = [];
    this.onRemoteStreamCallback = null;
  }
}
