import React, { useRef, useState } from "react";
import { io } from "socket.io-client";

// Set to your exact Render URL (no trailing slash)
const SIGNALING_URL = "https://timestream-backend.onrender.com";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

export default function App() {
  const [roomId, setRoomId] = useState("room-test");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("Disconnected");

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);

  // Hardware check: handles both phones (with camera) and PC (no camera)
  const startMedia = async () => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        return stream;
      } catch (err) {
        console.warn("Camera/Mic not detected or denied. Using synthetic placeholder...", err);
      }
    }

    // Canvas fallback for PC viewer without webcam
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#161b22";
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "#58a6ff";
    ctx.font = "16px sans-serif";
    ctx.fillText("Desktop Viewer (No Camera)", 40, 120);

    const syntheticStream = canvas.captureStream(10);
    localStreamRef.current = syntheticStream;
    if (localVideoRef.current) localVideoRef.current.srcObject = syntheticStream;
    return syntheticStream;
  };

  const getOrCreatePeerConnection = (stream) => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit("ice-candidate", {
          roomId,
          candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      setStatus(`ICE State: ${pc.iceConnectionState}`);
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const handleJoin = async () => {
    if (!roomId) return;
    setStatus("Initializing stream...");

    const stream = await startMedia();

    setStatus("Connecting to signaling server...");
    const socket = io(SIGNALING_URL, {
      transports: ["polling", "websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus(`Connected to relay (${socket.id}). Joining ${roomId}...`);
      socket.emit("join-room", roomId);
      setJoined(true);
    });

    socket.on("connect_error", (err) => {
      setStatus(`Relay connection failed: ${err.message}`);
    });

    socket.on("user-joined", async () => {
      setStatus("Peer detected. Creating offer...");
      const pc = getOrCreatePeerConnection(stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { roomId, offer });
    });

    socket.on("offer", async ({ offer }) => {
      setStatus("Offer received. Answering...");
      const pc = getOrCreatePeerConnection(stream);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { roomId, answer });
    });

    socket.on("answer", async ({ answer }) => {
      setStatus("Answer received. P2P established!");
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
        );
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate)
          );
        } catch (e) {
          console.error("ICE Candidate Error:", e);
        }
      }
    });
  };

  return (
    <div style={{ minHeight: "100vh", padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>TimeStream P2P Test</h1>
      <p style={{ color: "#8b949e", marginBottom: "1.5rem" }}>
        Status: <strong style={{ color: "#58a6ff" }}>{status}</strong>
      </p>

      {!joined && (
        <div style={{ display: "flex", gap: "10px", marginBottom: "2rem" }}>
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room Name"
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              border: "1px solid #30363d",
              background: "#161b22",
              color: "#fff"
            }}
          />
          <button
            onClick={handleJoin}
            style={{
              padding: "10px 20px",
              borderRadius: "6px",
              background: "#238636",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontWeight: "bold"
            }}
          >
            Enter Call
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", justifyContent: "center" }}>
        <div>
          <h3 style={{ marginBottom: "8px" }}>Local Stream</h3>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "320px", height: "240px", background: "#000", borderRadius: "8px", objectFit: "cover" }}
          />
        </div>
        <div>
          <h3 style={{ marginBottom: "8px" }}>Remote Video (Peer)</h3>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "320px", height: "240px", background: "#000", borderRadius: "8px", objectFit: "cover" }}
          />
        </div>
      </div>
    </div>
  );
}
