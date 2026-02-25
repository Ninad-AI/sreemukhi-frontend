/**
 * Audio utility functions for recording, VAD, and streaming.
 */


/* ── Module-level state for simple record/stop API ── */
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

/* ────────────────────────────────────────────────────
 *  Basic Recording
 * ──────────────────────────────────────────────────── */

export interface RecordingHandle {
  mediaRecorder: MediaRecorder;
  audioContext: AudioContext;
  analyser: AnalyserNode;
}

/**
 * Start recording audio from the user's microphone.
 */
export const startRecording = async (): Promise<RecordingHandle> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  mediaRecorder = new MediaRecorder(stream);
  audioChunks = [];

  mediaRecorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.start();

  return { mediaRecorder, audioContext, analyser };
};

/**
 * Stop recording and return the audio blob.
 */
export const stopRecording = (
  recorder: MediaRecorder | null,
  audioContext: AudioContext | null,
): Promise<Blob | null> => {
  return new Promise((resolve) => {
    if (!recorder) {
      resolve(null);
      return;
    }

    recorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      audioChunks = [];

      recorder.stream.getTracks().forEach((track) => track.stop());

      if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
      }

      resolve(audioBlob);
    };

    recorder.stop();
  });
};

/* ────────────────────────────────────────────────────
 *  Conversion helpers
 * ──────────────────────────────────────────────────── */

/**
 * Convert audio blob to base64 data-URL string.
 */
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = (err) => {
      reject(err);
    };
    reader.readAsDataURL(blob);
  });
};

/* ────────────────────────────────────────────────────
 *  Audio-level analysis
 * ──────────────────────────────────────────────────── */

/**
 * Analyze audio level from analyser node.
 * @returns Normalized audio level 0 – 1.
 */
export const getAudioLevel = (analyser: AnalyserNode | null): number => {
  if (!analyser) return 0;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
  return Math.min(average / 128, 1);
};

/* ────────────────────────────────────────────────────
 *  VAD-based single-utterance recording
 * ──────────────────────────────────────────────────── */

export interface VADOptions {
  maxDurationMs?: number;
  energyThreshold?: number;
  silenceAfterSpeechMs?: number;
  noInputTimeoutMs?: number;
  onAudioLevel?: (level: number) => void;
}

/**
 * Record a single utterance using simple energy-based VAD.
 *
 * - Starts listening immediately
 * - If user speaks → record until trailing silence, then return Blob
 * - If user never speaks for `noInputTimeoutMs` → return null
 */
export const recordUtteranceWithVAD = async ({
  maxDurationMs = 30000,
  energyThreshold = 0.01,
  silenceAfterSpeechMs = 600,
  noInputTimeoutMs = 5000,
  onAudioLevel,
}: VADOptions = {}): Promise<Blob | null> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  // Small timeslice so we flush data regularly
  recorder.start(100);

  const dataArray = new Uint8Array(analyser.fftSize);
  const startTime = performance.now();

  let speechStarted = false;
  let lastSpeechTime: number | null = null;

  let noiseSum = 0;
  let noiseCount = 0;

  return new Promise<Blob | null>((resolve, reject) => {
    const cleanup = () => {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (_) {
        /* ignore */
      }
      if (audioContext && audioContext.state !== "closed") {
        audioContext.close();
      }
    };

    const finishWithBlob = () => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        cleanup();
        resolve(blob);
      };
      try {
        recorder.stop();
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    const finishNoSpeech = () => {
      try {
        recorder.stop();
      } catch (_) {
        /* ignore */
      }
      cleanup();
      resolve(null);
    };

    const tick = () => {
      const now = performance.now();
      const elapsed = now - startTime;

      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128; // –1 … 1
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length); // 0 … ~1

      if (typeof onAudioLevel === "function") {
        const normalized = Math.min(rms * 8, 1); // boost into 0..1
        onAudioLevel(normalized);
      }

      // Dynamic threshold from first 0.5 s of noise
      if (!speechStarted && elapsed < 500) {
        noiseSum += rms;
        noiseCount += 1;
      }

      let threshold = energyThreshold;
      if (!speechStarted && noiseCount > 0) {
        const estNoise = noiseSum / noiseCount;
        threshold = Math.max(threshold, estNoise * 3.0);
      }

      if (rms >= threshold) {
        speechStarted = true;
        lastSpeechTime = now;
      }

      // Global "no speech at all" timeout
      if (!speechStarted && elapsed >= noInputTimeoutMs) {
        finishNoSpeech();
        return;
      }

      if (speechStarted) {
        if (rms >= threshold) {
          lastSpeechTime = now;
        }

        const silenceElapsed = now - (lastSpeechTime ?? now);
        if (silenceElapsed >= silenceAfterSpeechMs) {
          finishWithBlob();
          return;
        }
        if (elapsed >= maxDurationMs) {
          finishWithBlob();
          return;
        }
      }

      requestAnimationFrame(tick);
    };

    tick();
  });
};

/* ────────────────────────────────────────────────────
 *  Continuous PCM16 streaming over WebSocket
 * ──────────────────────────────────────────────────── */

export interface StreamingMicHandle {
  stop: () => void;
}

export interface StreamingMicOptions {
  /** RMS energy floor before dynamic calibration (default 0.01) */
  energyThreshold?: number;
  /** Trailing silence in ms before emitting speech_end (default 600) */
  silenceMs?: number;
  /** Called when VAD detects the user started speaking */
  onSpeechStart?: () => void;
  /** Called when VAD detects the user stopped speaking */
  onSpeechEnd?: () => void;
}

/**
 * Start streaming raw PCM16 audio to a WebSocket at 16 kHz in 20 ms frames
 * (320 samples per frame — required for server-side VAD).
 *
 * Built-in energy-based VAD automatically sends JSON
 * `{ "type": "speech_start" }` and `{ "type": "speech_end" }` messages
 * bracketing each utterance. PCM16 frames are streamed continuously.
 */
export const startStreamingMic = async (
  ws: WebSocket,
  onAudioLevel?: (level: number) => void,
  options: StreamingMicOptions = {},
): Promise<StreamingMicHandle> => {
  const {
    energyThreshold = 0.01,
    silenceMs = 600,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor({ sampleRate: 48000 });

  // MUST resume after user gesture
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(1024, 1, 1);

  // Connect the graph
  source.connect(processor);
  processor.connect(audioContext.destination);

  /* ── VAD state ── */
  let framesSent = 0;
  let isSpeaking = false;
  let lastSpeechTs = 0;         // ms timestamp of last above-threshold frame
  let noiseSum = 0;
  let noiseCount = 0;
  const calibrationMs = 500;    // first 0.5 s used for noise-floor estimation
  const streamStartTime = performance.now();

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);

    // ── Downsample to 16 kHz ──
    const targetSampleRate = 16000;
    const ratio = audioContext.sampleRate / targetSampleRate;
    const newLength = Math.floor(input.length / ratio);
    const downsampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      downsampled[i] = input[Math.floor(i * ratio)];
    }

    // ── Compute RMS energy on downsampled buffer ──
    let energySum = 0;
    for (let i = 0; i < downsampled.length; i++) {
      energySum += downsampled[i] * downsampled[i];
    }
    const rms = Math.sqrt(energySum / downsampled.length);

    // ── Dynamic noise-floor calibration (first 0.5 s) ──
    const elapsed = performance.now() - streamStartTime;
    if (elapsed < calibrationMs) {
      noiseSum += rms;
      noiseCount += 1;
    }

    let threshold = energyThreshold;
    if (noiseCount > 0) {
      const estNoise = noiseSum / noiseCount;
      threshold = Math.max(energyThreshold, estNoise * 3.0);
    }

    // ── VAD decision ──
    const now = performance.now();

    if (rms >= threshold) {
      lastSpeechTs = now;

      if (!isSpeaking) {
        isSpeaking = true;
        ws.send(JSON.stringify({ type: "speech_start" }));
        if (typeof onSpeechStart === "function") onSpeechStart();
      }
    } else if (isSpeaking) {
      const silenceElapsed = now - lastSpeechTs;
      if (silenceElapsed >= silenceMs) {
        isSpeaking = false;
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
    }

    // ── Float32 → PCM16 ──
    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // ── 20 ms frame chunking (REQUIRED FOR VAD) ──
    const FRAME_SIZE = 320; // 20 ms @ 16 kHz

    for (let i = 0; i < pcm16.length; i += FRAME_SIZE) {
      const frame = pcm16.slice(i, i + FRAME_SIZE);
      if (frame.length === FRAME_SIZE) {
        ws.send(frame.buffer);
        framesSent++;
      }
    }

    // ── Optional audio level callback ──
    if (typeof onAudioLevel === "function") {
      onAudioLevel(Math.min(rms * 8, 1));
    }
  };

  return {
    stop: () => {
      // If still speaking when stopped, send a final speech_end
      if (isSpeaking && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      audioContext.close();
    },
  };
};
