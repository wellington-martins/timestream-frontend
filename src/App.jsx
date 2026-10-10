import React, { useRef, useState, useEffect } from "react";
import { io } from "socket.io-client";

// Backend URL on Render
const SIGNALING_URL = "https://timestream-backend.onrender.com";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// Arbitrum One Network Details
const ARBITRUM_CHAIN_ID = "0xa4b1"; // 42161 in decimal
const ARBITRUM_PARAMS = {
  chainId: ARBITRUM_CHAIN_ID,
  chainName: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://arb1.arbitrum.io/rpc"],
  blockExplorerUrls: ["https://arbiscan.io/"]
};

export default function App() {
  const [walletAddress, setWalletAddress] = useState(null);
  const [networkError, setNetworkError] = useState("");
  const [roomId, setRoomId] = useState("room-test");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  
  // Media controls
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);

  // Metering & call duration
  const [callDuration, setCallDuration] = useState(0);
  const [isCallActive, setIsCallActive] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const timerRef = useRef(null);

  // Timer engine for metering
  useEffect(() => {
    if (isCallActive) {
      timerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [isCallActive]);

  // Arbitrum / MetaMask connection
  const connectWallet = async () => {
    if (!window.ethereum) {
      alert("MetaMask not found! Please install MetaMask or open inside MetaMask mobile browser.");
      return;
    }

    try {
      setNetworkError("");
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts"
      });

      // Check / Switch to Arbitrum One
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ARBITRUM_CHAIN_ID }]
        });
      } catch (switchError) {
        // Error 4902: chain has not been added to MetaMask
        if (switchError.code === 4902) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [ARBITRUM_PARAMS]
          });
        } else {
          throw switchError;
        }
      }

      setWalletAddress(accounts[0]);
    } catch (err) {
      console.error(err);
      setNetworkError(err.message || "Failed to connect wallet");
    }
  };

  // Hardware check / Canvas fallback for headless desktop
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
      if (pc.iceConnectionState === "connected") {
        setIsCallActive(true);
      } else if (["disconnected", "failed", "closed"].includes(pc.iceConnectionState)) {
        setIsCallActive(false);
      }
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

  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoMuted(!videoTrack.enabled);
      }
    }
  };

  const handleEndCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    setIsCallActive(false);
    setJoined(false);
    setStatus("Call Ended");
  };

  const formatTimer = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div style={{ minHeight: "100vh", padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", background: "#0d1117", color: "#c9d1d9", fontFamily: "sans-serif" }}>
      <h1 style={{ marginBottom: "0.5rem", color: "#fff" }}>TimeStream P2P + Arbitrum</h1>

      {/* Web3 Wallet Header */}
      <div style={{ marginBottom: "1.5rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
        {walletAddress ? (
          <div style={{ padding: "8px 16px", background: "#161b22", borderRadius: "20px", border: "1px solid #30363d", display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ height: "10px", width: "10px", borderRadius: "50%", background: "#28a745" }}></span>
            <span style={{ fontSize: "14px", color: "#58a6ff" }}>Arbitrum: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
          </div>
        ) : (
          <button
            onClick={connectWallet}
            style={{ padding: "10px 18px", borderRadius: "6px", background: "#28a745", color: "#fff", border: "none", cursor: "pointer", fontWeight: "bold" }}
          >
            Connect Arbitrum Wallet
          </button>
        )}
        {networkError && <p style={{ color: "#f85149", fontSize: "13px" }}>{networkError}</p>}
      </div>

      {/* Metering Bar */}
      {isCallActive && (
        <div style={{ marginBottom: "1rem", padding: "8px 20px", background: "#21262d", borderRadius: "6px", border: "1px solid #388bfd" }}>
          Active Call Duration: <strong style={{ color: "#388bfd", fontSize: "18px" }}>{formatTimer(callDuration)}</strong>
        </div>
      )}

      <p style={{ color: "#8b949e", marginBottom: "1.5rem" }}>
        Status: <strong style={{ color: "#58a6ff" }}>{status}</strong>
      </p>

      {!joined ? (
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
              background: "#1f6feb",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontWeight: "bold"
            }}
          >
            Enter Call
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "10px", marginBottom: "2rem" }}>
          <button onClick={toggleAudio} style={{ padding: "8px 16px", borderRadius: "6px", background: isAudioMuted ? "#da3633" : "#21262d", color: "#fff", border: "1px solid #30363d", cursor: "pointer" }}>
            {isAudioMuted ? "Unmute Mic" : "Mute Mic"}
          </button>
          <button onClick={toggleVideo} style={{ padding: "8px 16px", borderRadius: "6px", background: isVideoMuted ? "#da3633" : "#21262d", color: "#fff", border: "1px solid #30363d", cursor: "pointer" }}>
            {isVideoMuted ? "Enable Video" : "Disable Video"}
          </button>
          <button onClick={handleEndCall} style={{ padding: "8px 16px", borderRadius: "6px", background: "#da3633", color: "#fff", border: "none", cursor: "pointer", fontWeight: "bold" }}>
            End Call
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", justifyContent: "center" }}>
        <div>
          <h3 style={{ marginBottom: "8px", fontSize: "14px" }}>Local Stream</h3>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "320px", height: "240px", background: "#000", borderRadius: "8px", objectFit: "cover" }}
          />
        </div>
        <div>
          <h3 style={{ marginBottom: "8px", fontSize: "14px" }}>Remote Video (Peer)</h3>
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
