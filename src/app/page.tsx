"use client";

import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import Image from "next/image";
import { startStreamingMic, type StreamingMicHandle } from "./utils/audioUtils";

type FlowState = "idle" | "auth" | "payment" | "active";
type CallPhase = "connecting" | "listening" | "speaking";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://localhost:8000/ws/audio";

const CREATOR = {
  name: "Sreemukhi",
  image: "/sreemukhi-face.jpg",
  role: "Actor & Anchor",
};

const TIME_OPTIONS = [
  { minutes: 0.5, price: 49, label: "30 sec" },
  { minutes: 15, price: 299, label: "15 min" },
  { minutes: 20, price: 399, label: "20 min" },
  { minutes: 30, price: 599, label: "30 min" },
  { minutes: 60, price: 999, label: "60 min" },
];

export default function Home() {
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isWsConnected, setIsWsConnected] = useState(false);
  const [callPhase, setCallPhase] = useState<CallPhase>("connecting");
  const [isVisible, setIsVisible] = useState(false);

  const mousePosRef = useRef({ x: 0, y: 0 });
  const mouseTargetRef = useRef({ x: 0, y: 0 });
  const avatarRefs = useRef<(HTMLDivElement | null)[]>([]);

  /* ── Audio streaming refs ── */
  const wsRef = useRef<WebSocket | null>(null);
  const micControllerRef = useRef<StreamingMicHandle | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playHeadRef = useRef(0);
  const sourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const sourceEndPromisesRef = useRef<Promise<void>[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsActiveRef = useRef(false);

  /* ── Entrance animation + mouse-follow parallax ── */
  useEffect(() => {
    const timeout = setTimeout(() => setIsVisible(true), 100);

    const handleMouseMove = (e: MouseEvent) => {
      mouseTargetRef.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 20,
        y: (e.clientY / window.innerHeight - 0.5) * 20,
      };
    };

    let frameId: number;
    const animate = () => {
      mousePosRef.current.x +=
        (mouseTargetRef.current.x - mousePosRef.current.x) * 0.1;
      mousePosRef.current.y +=
        (mouseTargetRef.current.y - mousePosRef.current.y) * 0.1;

      avatarRefs.current.forEach((el, i) => {
        if (!el) return;
        const m = i === 0 ? 0.5 : -1;
        el.style.transform = `translate3d(${mousePosRef.current.x * m}px, ${mousePosRef.current.y * m}px, 0)`;
      });

      frameId = requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", handleMouseMove);
    animate();

    return () => {
      clearTimeout(timeout);
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(frameId);
    };
  }, []);

  /* ── Audio context helpers ── */
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextCtor();
      playHeadRef.current = audioContextRef.current.currentTime;
      sourceEndPromisesRef.current = [];
    }
    return audioContextRef.current;
  }, []);

  const scheduleBuffer = useCallback(
    (buffer: AudioBuffer) => {
      const audioCtx = getAudioContext();
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);

      const endPromise = new Promise<void>((resolve) => {
        src.onended = () => {
          sourceNodesRef.current = sourceNodesRef.current.filter((node) => node !== src);
          resolve();
        };
      });
      sourceEndPromisesRef.current.push(endPromise);
      sourceNodesRef.current.push(src);

      if (playHeadRef.current < audioCtx.currentTime) {
        playHeadRef.current = audioCtx.currentTime;
      }

      src.start(playHeadRef.current);
      playHeadRef.current += buffer.duration;
    },
    [getAudioContext],
  );

  const stopPlaybackImmediately = useCallback(() => {
    sourceNodesRef.current.forEach((node) => {
      try {
        node.stop(0);
      } catch {
        // ignore nodes already ended/stopped
      }
    });
    sourceNodesRef.current = [];
    sourceEndPromisesRef.current = [];

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    playHeadRef.current = 0;
  }, []);

  const processBinaryChunk = useCallback(
    (arrayBuffer: ArrayBuffer) => {
      // Backend sends PCM16 (Int16)
      const int16 = new Int16Array(arrayBuffer);

      // Convert Int16 → Float32 for Web Audio API
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const sampleRate = 16000; // Must match backend TTS
      const audioCtx = getAudioContext();
      const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0, 0);

      scheduleBuffer(buffer);
    },
    [getAudioContext, scheduleBuffer],
  );

  /* ── WebSocket audio streaming when active ── */
  useEffect(() => {
    if (flowState !== "active") return;

    setIsWsConnected(false);
    setIsSpeaking(false);
    setCallPhase("connecting");

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      setIsWsConnected(true);
      setCallPhase("listening");
      ttsActiveRef.current = false;
      try {
        const controller = await startStreamingMic(ws, (level) => {
          // Audio level only drives the visual indicator when not in TTS playback
        }, {
          energyThreshold: 0.01,
          silenceMs: 600,
          onSpeechStart: () => {
            // Only update when model is NOT speaking (prevents echo triggering)
            if (!ttsActiveRef.current) {
              setCallPhase("listening");
            }
          },
          onSpeechEnd: () => {
            // User stopped speaking; stay on "listening" until model responds
            // Only update when model is NOT speaking (prevents echo triggering)
            if (!ttsActiveRef.current) {
              setCallPhase("listening");
            }
          },
        });
        micControllerRef.current = controller;
      } catch (err) {
        // mic start failed
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        ttsActiveRef.current = true;
        setIsSpeaking(true);
        setCallPhase("speaking");
        processBinaryChunk(event.data);
      } else {
        // JSON control messages (tts_start, tts_end, etc.)
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "tts_start") {
            ttsActiveRef.current = true;
            setIsSpeaking(true);
            setCallPhase("speaking");
          }
          if (msg.type === "tts_end") {
            // Wait for all scheduled audio buffers to finish playing
            // before transitioning back to listening
            const pendingPromises = [...sourceEndPromisesRef.current];
            if (pendingPromises.length > 0) {
              Promise.all(pendingPromises).then(() => {
                ttsActiveRef.current = false;
                setIsSpeaking(false);
                setCallPhase("listening");
              });
            } else {
              ttsActiveRef.current = false;
              setIsSpeaking(false);
              setCallPhase("listening");
            }
          }
        } catch {
          /* ignore non-JSON */
        }
      }
    };

    ws.onerror = () => {
      setIsWsConnected(false);
      setCallPhase("connecting");
    };

    ws.onclose = () => {
      setIsWsConnected(false);
      setIsSpeaking(false);
      setCallPhase("connecting");
    };

    return () => {
      // Cleanup on flowState change / unmount
      if (micControllerRef.current) {
        micControllerRef.current.stop();
        micControllerRef.current = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
      ttsActiveRef.current = false;
      stopPlaybackImmediately();
    };
  }, [flowState, processBinaryChunk, stopPlaybackImmediately]);

  const handleStartTalking = () => setFlowState("auth");
  const handleSelectTime = (minutes: number) => setSelectedMinutes(minutes);

  const handlePayAndStart = () => {
    if (!selectedMinutes) return;
    setTimeLeft(selectedMinutes * 60);
    setFlowState("active");
  };

  const handleEndCall = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    // Stop mic streaming
    if (micControllerRef.current) {
      micControllerRef.current.stop();
      micControllerRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      wsRef.current.close();
      wsRef.current = null;
    }

    stopPlaybackImmediately();
    ttsActiveRef.current = false;

    setFlowState("idle");
    setTimeLeft(0);
    setSelectedMinutes(null);
    setIsWsConnected(false);
    setIsSpeaking(false);
    setCallPhase("connecting");
  }, [stopPlaybackImmediately]);

  /* ── Countdown timer ── */
  useEffect(() => {
    if (flowState !== "active" || timeLeft <= 0) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          handleEndCall();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [flowState, timeLeft, handleEndCall]);

  const callStatusLabel =
    callPhase === "speaking"
      ? "Speaking..."
      : callPhase === "listening"
        ? "Listening..."
        : "Connecting...";

  const timerMinutes = Math.floor(timeLeft / 60);
  const timerSeconds = timeLeft % 60;
  const timerAriaLabel = `${timerMinutes.toString().padStart(2, "0")}:${timerSeconds.toString().padStart(2, "0")}`;

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[#0F0F13] text-white font-sans selection:bg-rose-500/30">
      {/* ── Background Blobs ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute top-[-10%] left-[-10%] w-[70vw] h-[70vw] bg-rose-500/20 blur-[100px] animate-blob mix-blend-screen"
          style={{ borderRadius: "60% 40% 30% 70% / 60% 30% 70% 40%" }}
        />
        <div
          className="absolute bottom-[-10%] right-[-10%] w-[60vw] h-[60vw] bg-indigo-500/20 blur-[100px] animate-blob animation-delay-2000 mix-blend-screen"
          style={{ borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%" }}
        />
        <div
          className="absolute top-[30%] left-[40%] w-[50vw] h-[50vw] bg-purple-500/20 blur-[120px] animate-blob animation-delay-4000 mix-blend-screen"
          style={{ borderRadius: "50% 50% 20% 80% / 25% 80% 20% 75%" }}
        />
      </div>

      {/* ── Content ── */}
      <div
        className={`
          relative z-10 w-full min-h-screen flex flex-col items-center justify-center px-6 sm:px-10 py-16 sm:py-20
          transition-all duration-1000 ease-out
          ${isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}
        `}
      >
        {flowState === "active" ? (
          /* ── Active Call Interface (Minimal Redesign) ── */
          <div className="w-full h-screen fixed inset-0 z-40 bg-[#0F0F13] flex flex-col items-center justify-center">
            {/* Ambient Background Glow for Active Call */}
            <div
              className={`absolute inset-0 transition-opacity duration-1000 ${isSpeaking ? "opacity-100" : "opacity-40"}`}
            >
              <div className="absolute top-1/4 left-1/4 w-[50vw] h-[50vw] bg-rose-500/10 blur-[120px] rounded-full mix-blend-screen animate-pulse" />
              <div className="absolute bottom-1/4 right-1/4 w-[40vw] h-[40vw] bg-indigo-500/10 blur-[100px] rounded-full mix-blend-screen" />
            </div>

            {/* Absolute Top Right End Call Button (Page Corner) */}
            <button
              onClick={handleEndCall}
              className="group fixed top-6 right-6 sm:top-10 sm:right-10 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-rose-900/35 hover:border-rose-700/60 transition-colors duration-300 z-50 backdrop-blur-md"
              aria-label="End call"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-5 h-5 sm:w-6 sm:h-6 text-white/80 group-hover:text-rose-300 group-hover:rotate-90 transition-all duration-300 ease-out"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {/* Central Minimal Avatar */}
            <div className="relative z-10 flex flex-col items-center gap-4 sm:gap-6 animate-fade-in-up">
              {/* Subtle Breathing Avatar */}
              <div className="relative">
                {/* Voice reactive glow */}
                <div
                  className={`absolute inset-[-10px] rounded-full bg-white/20 blur-xl transition-all duration-300 ease-out
                    ${isSpeaking ? "scale-110 opacity-60" : "scale-90 opacity-0"}
                  `}
                />

                <div
                  ref={(el) => {
                    avatarRefs.current[0] = el;
                  }}
                  className={`relative w-[200px] h-[200px] sm:w-[280px] sm:h-[280px] rounded-full overflow-hidden shadow-2xl ring-1 ring-white/10 transition-transform duration-[2000ms]
                    ${isSpeaking ? "scale-105" : "scale-100"}
                  `}
                >
                  <Image
                    src={CREATOR.image}
                    alt={CREATOR.name}
                    fill
                    className="object-cover"
                    priority
                  />
                  <div className="absolute inset-0 bg-black/20" />
                </div>
              </div>

              {/* Minimal Text Status & Timer */}
              <div className="text-center flex flex-col items-center gap-2 sm:gap-3">
                <h3 className="text-2xl sm:text-3xl font-light text-white tracking-wide">
                  {CREATOR.name}
                </h3>

                <div className="inline-flex items-center justify-center gap-2">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${callPhase === "connecting" ? "bg-amber-300 animate-pulse" : callPhase === "speaking" ? "bg-green-400 animate-pulse" : "bg-cyan-300"}`}
                  />
                  <span className="text-[11px] sm:text-xs text-white/65 uppercase tracking-[0.18em] font-semibold">
                    {callStatusLabel}
                  </span>
                </div>

                {/* Enhanced Timer */}
                <div className="mt-1 sm:mt-2 inline-flex flex-col items-center min-w-[170px] sm:min-w-[190px] rounded-2xl border border-white/15 bg-black/35 backdrop-blur-xl px-5 py-2.5 sm:px-6 sm:py-3 shadow-[0_10px_28px_rgba(0,0,0,0.4)]">
                  <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.22em] text-white/55 font-semibold">
                    Time Left
                  </span>
                  <span className="countdown font-mono mt-1 text-[36px] sm:text-[42px] leading-none font-light tracking-[-0.03em] text-white">
                    <span
                      style={{ "--value": timerMinutes, "--digits": 2 } as CSSProperties}
                      aria-live="polite"
                      aria-label={timerAriaLabel}
                    >
                      {timerMinutes.toString().padStart(2, "0")}
                    </span>
                    :
                    <span
                      style={{ "--value": timerSeconds, "--digits": 2 } as CSSProperties}
                      aria-live="polite"
                      aria-label={timerAriaLabel}
                    >
                      {timerSeconds.toString().padStart(2, "0")}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Idle Hero ── */
          <div className="relative w-full max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-center md:justify-between gap-12 md:gap-20 px-2 sm:px-0">
            {/* Text Content */}
            <div className="relative z-20 flex flex-col items-center md:items-start text-center md:text-left gap-0">
              <h2 className="text-[11px] sm:text-sm md:text-base text-rose-300 font-bold tracking-[0.18em] sm:tracking-[0.22em] uppercase mb-5 sm:mb-6 animate-fade-in-up">
                • {CREATOR.role}
              </h2>

              <h1 className="text-[3.5rem] sm:text-7xl md:text-8xl font-black tracking-tighter leading-[0.88] mb-8 sm:mb-10 md:mb-12">
                <span className="block text-transparent bg-clip-text bg-gradient-to-r from-white to-white/50">
                  {CREATOR.name}.
                </span>
              </h1>

              {/* Desktop CTA */}
              <div className="animate-fade-in-up shrink-0 hidden md:block w-full sm:w-auto">
                <button
                  onClick={handleStartTalking}
                  className="group relative inline-flex items-center justify-center rounded-full bg-white text-black font-bold text-sm sm:text-base tracking-wide w-full sm:w-56 h-14 sm:h-[58px] shadow-[0_0_40px_rgba(255,255,255,0.25)] hover:shadow-[0_0_60px_rgba(255,255,255,0.45)] hover:scale-105 transition-all duration-300"
                >
                  <span className="flex items-center justify-center gap-3">
                    Start Session
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>

            {/* Image */}
            <div className="relative w-72 h-72 sm:w-[340px] sm:h-[380px] md:w-[480px] md:h-[580px] shrink-0">
              <div
                ref={(el) => {
                  avatarRefs.current[1] = el;
                }}
                className="relative w-full h-full overflow-hidden shadow-2xl hover:scale-[1.02] transition-transform duration-700 will-change-transform"
                style={{ borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%" }}
              >
                <Image
                  src={CREATOR.image}
                  alt={CREATOR.name}
                  fill
                  className="object-cover scale-110"
                  priority
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-60" />
              </div>

              {/* Floating Decorative Elements */}
              <div
                className="absolute -top-8 -right-8 sm:-top-12 sm:-right-12 w-16 h-16 sm:w-24 sm:h-24 bg-white/10 backdrop-blur-md border border-white/20 z-20 animate-float"
                style={{ borderRadius: "50% 50% 50% 50% / 50% 50% 50% 50%" }}
              />
              <div
                className="absolute bottom-20 -left-10 sm:-left-16 w-20 h-20 sm:w-32 sm:h-32 bg-rose-500/20 backdrop-blur-md border border-rose-500/20 z-20 animate-float animation-delay-2000"
                style={{ borderRadius: "60% 40% 30% 70% / 60% 30% 70% 40%" }}
              />
            </div>

            {/* Mobile CTA */}
            <div className="animate-fade-in-up md:hidden w-full flex justify-center z-30">
              <button
                onClick={handleStartTalking}
                className="group relative inline-flex items-center justify-center rounded-full bg-white text-black font-bold text-sm tracking-wide w-52 h-14 shadow-[0_0_40px_rgba(255,255,255,0.25)] hover:shadow-[0_0_60px_rgba(255,255,255,0.45)] hover:scale-105 transition-all duration-300"
              >
                <span className="flex items-center justify-center gap-3 w-full">
                  Start Session
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Auth / Payment Modal ── */}
      {(flowState === "auth" || flowState === "payment") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-xl transition-all duration-500"
            onClick={() => setFlowState("idle")}
          />

          {/* Modal Card */}
          <div className="relative w-[92vw] max-w-sm sm:w-full sm:max-w-md animate-fade-in-up">
            <div
              className={`
                relative bg-black/80 backdrop-blur-3xl border border-white/10 shadow-2xl
                flex flex-col overflow-hidden rounded-3xl
                ${flowState === "payment"
                  ? "px-7 pt-9 pb-8 sm:px-10 sm:pt-10 sm:pb-9"
                  : "px-7 py-10 sm:px-10 sm:py-12"
                }
              `}
            >
              {/* Modal Background Glow */}
              <div className="absolute top-0 right-0 w-64 h-64 bg-rose-600/20 blur-[80px] rounded-full pointer-events-none" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-600/20 blur-[80px] rounded-full pointer-events-none" />

              <div className="relative z-10 flex flex-col gap-0">
                {/* Header */}
                <h3 className="text-[28px] sm:text-[32px] font-black text-white tracking-tight leading-tight mb-2">
                  {flowState === "auth" ? "Identification." : "Duration."}
                </h3>
                <p className="text-[13px] sm:text-[14px] text-white/50 font-medium leading-snug mb-8 sm:mb-9">
                  {flowState === "auth"
                    ? "Choose how you would like to proceed."
                    : "Select your preferred session length."}
                </p>

                {/* Auth Step */}
                {flowState === "auth" && (
                  <button
                    onClick={() => setFlowState("payment")}
                    className="w-full h-14 sm:h-[58px] rounded-2xl bg-white text-black text-[15px] sm:text-[16px] font-extrabold shadow-xl hover:scale-[1.02] active:scale-100 transition-all duration-300"
                  >
                    Continue as Guest
                  </button>
                )}

                {/* Payment Step */}
                {flowState === "payment" && (
                  <div className="flex flex-col gap-3 sm:gap-4">
                    {/* Duration Grid */}
                    <div className="grid grid-cols-6 gap-2 sm:gap-2.5">
                      {TIME_OPTIONS.map((opt, index) => {
                        const isSelected = selectedMinutes === opt.minutes;
                        const colSpan = index < 3 ? "col-span-2" : "col-span-3";
                        return (
                          <button
                            key={opt.minutes}
                            onClick={() => handleSelectTime(opt.minutes)}
                            className={`
                              ${colSpan} h-16 sm:h-[68px] rounded-xl sm:rounded-2xl border transition-all duration-300
                              flex flex-col items-center justify-center gap-0.5
                              ${isSelected
                                ? "border-white bg-white/10 text-white shadow-lg"
                                : "border-white/20 bg-white/[0.02] text-white/60 hover:border-white/40 hover:text-white/80"
                              }
                            `}
                          >
                            <span className="text-[10px] sm:text-[11px] uppercase tracking-widest font-bold">
                              {opt.label}
                            </span>
                            <span className="text-[13px] sm:text-sm font-bold leading-none">
                              ₹{opt.price}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Begin Button */}
                    <button
                      onClick={handlePayAndStart}
                      disabled={!selectedMinutes}
                      className={`
                        w-full h-14 sm:h-[58px] rounded-2xl font-bold text-base sm:text-lg transition-all duration-500 mt-1
                        ${selectedMinutes
                          ? "bg-gradient-to-r from-pink-500 via-red-500 to-orange-500 text-white shadow-[0_8px_32px_rgba(255,80,80,0.35)] hover:scale-[1.02] active:scale-100"
                          : "bg-white/8 text-white/30 border border-white/10 cursor-not-allowed"
                        }
                      `}
                    >
                      Begin Session
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
