"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  classifyMediaError,
  describeFailure,
  hasLiveAudio,
  hasLiveVideo,
  isMediaCaptureSupported,
  type FrameStat,
  type MediaFailureKind,
} from "@/app/lib/deviceCheckPolicy";

type Phase = "idle" | "requesting" | "verifying" | "passed" | "failed";

const VIDEO_SAMPLE_INTERVAL_MS = 250;
const AUDIO_SAMPLE_INTERVAL_MS = 100;
/** Long enough to speak a short phrase; past this we stop waiting and fail. */
const VERIFY_TIMEOUT_MS = 25_000;

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 48;

/**
 * Blocks interview entry until the camera actually produces a picture and the
 * microphone actually produces sound. Runs before any attempt row exists, so a
 * candidate whose hardware fails here loses nothing and can retry on the same
 * link.
 */
export default function DeviceCheck({
  onVerifiedChange,
  registerStreamRelease,
}: {
  onVerifiedChange: (verified: boolean) => void;
  registerStreamRelease: (release: () => void) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<MediaFailureKind>("unknown");
  const [cameraOk, setCameraOk] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const [level, setLevel] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timersRef = useRef<number[]>([]);
  const deadlineRef = useRef<number | null>(null);

  const frameStatsRef = useRef<FrameStat[]>([]);
  const rmsSamplesRef = useRef<number[]>([]);
  const cameraOkRef = useRef(false);
  const micOkRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearInterval(id);
    timersRef.current = [];
    if (deadlineRef.current !== null) {
      window.clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    clearTimers();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
  }, [clearTimers]);

  // The parent releases the camera at the moment the candidate starts, so the
  // interview's own getUserMedia does not race this one for the device.
  useEffect(() => {
    registerStreamRelease(releaseStream);
  }, [registerStreamRelease, releaseStream]);

  useEffect(() => releaseStream, [releaseStream]);

  const fail = useCallback(
    (kind: MediaFailureKind) => {
      releaseStream();
      setFailure(kind);
      setPhase("failed");
      onVerifiedChange(false);
    },
    [onVerifiedChange, releaseStream]
  );

  const settleIfComplete = useCallback(() => {
    if (!cameraOkRef.current || !micOkRef.current) return;
    clearTimers();
    setPhase("passed");
    onVerifiedChange(true);
  }, [clearTimers, onVerifiedChange]);

  const sampleVideoFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    context.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

    let total = 0;
    let totalSquares = 0;
    const pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      // Rec. 601 luma; good enough to tell a picture from a blank feed.
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      total += luma;
      totalSquares += luma * luma;
    }

    const meanLuma = total / pixelCount;
    const lumaVariance = totalSquares / pixelCount - meanLuma * meanLuma;

    frameStatsRef.current = [...frameStatsRef.current.slice(-40), { meanLuma, lumaVariance }];

    if (!cameraOkRef.current && hasLiveVideo(frameStatsRef.current)) {
      cameraOkRef.current = true;
      setCameraOk(true);
      settleIfComplete();
    }
  }, [settleIfComplete]);

  const startCheck = useCallback(async () => {
    if (!isMediaCaptureSupported()) {
      fail("unsupported_browser");
      return;
    }

    setPhase("requesting");
    setCameraOk(false);
    setMicOk(false);
    cameraOkRef.current = false;
    micOkRef.current = false;
    frameStatsRef.current = [];
    rmsSamplesRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
    } catch (error) {
      fail(classifyMediaError(error));
      return;
    }

    streamRef.current = stream;
    setPhase("verifying");

    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay rejection is not fatal; frame sampling reads the element
        // directly and the preview is decorative.
      }
    }

    // --- microphone ---
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") await audioContext.resume();

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);

      timersRef.current.push(
        window.setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          let sumSquares = 0;
          for (const sample of buffer) sumSquares += sample * sample;
          const rms = Math.sqrt(sumSquares / buffer.length);

          setLevel(rms);
          rmsSamplesRef.current = [...rmsSamplesRef.current.slice(-200), rms];

          if (!micOkRef.current && hasLiveAudio(rmsSamplesRef.current)) {
            micOkRef.current = true;
            setMicOk(true);
            settleIfComplete();
          }
        }, AUDIO_SAMPLE_INTERVAL_MS)
      );
    } catch {
      fail("silent_microphone");
      return;
    }

    // --- camera ---
    timersRef.current.push(
      window.setInterval(sampleVideoFrame, VIDEO_SAMPLE_INTERVAL_MS)
    );

    // Whichever device never proved itself is the one we name.
    deadlineRef.current = window.setTimeout(() => {
      if (cameraOkRef.current && micOkRef.current) return;
      fail(cameraOkRef.current ? "silent_microphone" : "blank_video");
    }, VERIFY_TIMEOUT_MS);
  }, [clearTimers, fail, sampleVideoFrame, settleIfComplete]);

  const failureCopy = describeFailure(failure);
  const meterWidth = Math.min(100, Math.round((level / 0.15) * 100));

  return (
    <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className={`mb-4 w-full rounded-xl bg-black/60 ${
          phase === "verifying" || phase === "passed" ? "block" : "hidden"
        }`}
        style={{ aspectRatio: "4 / 3", objectFit: "cover", transform: "scaleX(-1)" }}
      />
      <canvas
        ref={canvasRef}
        width={SAMPLE_WIDTH}
        height={SAMPLE_HEIGHT}
        className="hidden"
      />

      {phase === "idle" && (
        <>
          <p className="mb-4 text-sm leading-6 text-white/70">
            We need to confirm your camera and microphone are working before you
            begin. This does not use up your interview attempt.
          </p>
          <button
            onClick={startCheck}
            className="w-full rounded-lg bg-cyan-500 px-6 py-3 font-medium text-black transition-colors hover:bg-cyan-400"
          >
            Check camera &amp; microphone
          </button>
        </>
      )}

      {phase === "requesting" && (
        <p className="text-sm text-white/70">
          Waiting for you to allow camera and microphone access&hellip;
        </p>
      )}

      {(phase === "verifying" || phase === "passed") && (
        <div className="space-y-3">
          <StatusRow label="Camera" ok={cameraOk} pendingText="Looking for a picture&hellip;" />
          <StatusRow
            label="Microphone"
            ok={micOk}
            pendingText="Say &ldquo;I am ready&rdquo; out loud&hellip;"
          />

          {!micOk && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-cyan-400 transition-[width] duration-100"
                style={{ width: `${meterWidth}%` }}
              />
            </div>
          )}

          {phase === "passed" && (
            <p className="pt-1 text-sm text-emerald-300">
              Camera and microphone confirmed. You can begin.
            </p>
          )}
        </div>
      )}

      {phase === "failed" && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-amber-300">{failureCopy.title}</p>
          <p className="text-sm leading-6 text-white/70">{failureCopy.instruction}</p>
          <p className="text-xs text-white/45">
            Your interview attempt has not been used. You can fix this and run the
            check again on this same link.
          </p>
          <button
            onClick={startCheck}
            className="w-full rounded-lg border border-white/20 px-6 py-3 font-medium text-white transition-colors hover:bg-white/10"
          >
            Run the check again
          </button>
        </div>
      )}
    </div>
  );
}

function StatusRow({
  label,
  ok,
  pendingText,
}: {
  label: string;
  ok: boolean;
  pendingText: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-white/80">{label}</span>
      <span className={ok ? "text-emerald-300" : "text-white/50"}>
        {ok ? "Working" : pendingText}
      </span>
    </div>
  );
}
