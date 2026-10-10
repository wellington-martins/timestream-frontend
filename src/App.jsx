import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

// Update this to your live Render backend URL or 'https://signal.timestream.me' once DNS is live
const SIGNALING_URL = "https://timestream-signal.onrender.com";

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

  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error("Error accessing camera/mic:", err);
      setStatus("Camera/Mic permission denied");
      throw err;
    }
  };

  const createPeerConnection = (stream) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local tracks so the remote peer receives video and audio
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    // Handle incoming remote media stream
    pc.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Forward local network routing candidates to peer via relay
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit("ice-candidate", {
          roomId,
          candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      setStatus(`ICE Connection: ${pc.iceConnectionState}`);
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const handleJoin = async () => {
    if (!roomId) return;
    setStatus("Requesting camera and microphone...");

    const stream = await startMedia();

    // Establish WebSocket handshake with signaling relay
    const socket = io(SIGNALING_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus(`Connected to relay (${socket.id}). Joining room...`);
      socket.emit("join-room", roomId);
      setJoined(true);
    });

    // When another device enters room, initiate WebRTC offer
    socket.on("user-joined", async () => {
      setStatus("Remote peer detected. Generating offer...");
      const pc = createPeerConnection(stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { roomId, offer });
    });

    // When receiving an offer from another device, return an answer
    socket.on("offer", async ({ offer }) => {
      setStatus("Offer received. Creating answer...");
      const pc = createPeerConnection(stream);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { roomId, answer });
    });

    // When answer arrives back, finalize P2P negotiation
    socket.on("answer", async ({ answer }) => {
      setStatus("Answer received. P2P link active.");
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
        );
      }
    });

    // Add incoming ICE candidate routes
    socket.on("ice-candidate", async ({ candidate }) => {
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(candidate)
          );
        } catch (e) {
          console.error("Failed adding ICE candidate:", e);
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
          <h3 style={{ marginBottom: "8px" }}>Local Video (You)</h3>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "320px", height: "240px", background: "#000", borderRadius: "8px", transform: "scaleX(-1)" }}
          />
        </div>
        <div>
          <h3 style={{ marginBottom: "8px" }}>Remote Video (Peer)</h3>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            style={{ width: "320px", height: "240px", background: "#000", borderRadius: "8px" }}
          />
        </div>
      </div>
    </div>
  );
}
