import { Socket } from "socket.io-client";
import { ICE_SERVERS } from "./env";

export class WebRTCStreamer {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    this.initSocketListeners();
  }

  private initSocketListeners() {
    this.socket.on("webrtc:signal", async (data: any) => {
      if (data.type === "offer") {
        await this.handleOffer(data);
      } else if (data.type === "answer") {
        await this.handleAnswer(data);
      } else if (data.type === "candidate") {
        await this.handleCandidate(data);
      }
    });
  }

  /**
   * Host starts screen capture and initializes WebRTC peer connection
   */
  public async startHostCapture(): Promise<MediaStream> {
    try {
      this.localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: "always",
          frameRate: { ideal: 30, max: 60 },
        } as any,
        audio: false,
      });

      return this.localStream;
    } catch (err: any) {
      console.error("Failed to acquire screen capture:", err);
      throw err;
    }
  }

  /**
   * Viewer connects to receive the host's screen stream
   */
  public async createViewerConnection(onRemoteStream: (stream: MediaStream) => void): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });
    this.peerConnection = pc;

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        onRemoteStream(event.streams[0]);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("webrtc:signal", {
          type: "candidate",
          candidate: event.candidate,
        });
      }
    };

    // Create SDP Offer from Viewer to Host
    pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

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
      // Screen not started yet
      return;
    }

    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });
    this.peerConnection = pc;

    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream!);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("webrtc:signal", {
          type: "candidate",
          target: data.sender,
          candidate: event.candidate,
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: data.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socket.emit("webrtc:signal", {
      type: "answer",
      target: data.sender,
      sdp: answer.sdp,
    });
  }

  private async handleAnswer(data: any) {
    if (this.peerConnection && data.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
    }
  }

  private async handleCandidate(data: any) {
    if (this.peerConnection && data.candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn("Error adding ICE candidate", e);
      }
    }
  }

  public stop() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }
}
