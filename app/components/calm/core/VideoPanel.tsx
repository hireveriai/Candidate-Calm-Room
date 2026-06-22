"use client";

import { useEffect, useRef } from "react";
import { Room, Track } from "livekit-client";
import type { RefObject } from "react";

type Props = {
  attemptId?: string;
  timeLeft?: number;
  reconnectKey?: number;
  sessionQuestionId?: string;
  questionText?: string;
  transcript?: string;
  verisState?: "idle" | "listening" | "thinking" | "speaking";
  onVideoReady?: (ref: RefObject<HTMLVideoElement | null>) => void;
  onCameraStatusChange?: (ready: boolean) => void;
  onRoomConnectionChange?: (
    state: "connected" | "reconnecting" | "disconnected"
  ) => void;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidAttemptId(value: string | null | undefined): value is string {
  return Boolean(value && uuidPattern.test(value.trim()));
}

async function fetchLiveKitPublisherToken(attemptId: string) {
  const searchParams = new URLSearchParams({
    room: attemptId,
    userId: `candidate-publisher-${attemptId}`,
    role: "publisher",
  });

  const response = await fetch(`/api/livekit/token?${searchParams.toString()}`);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    throw new Error(payload?.error ?? "Failed to fetch LiveKit token");
  }

  const payload = (await response.json()) as { token: string };
  return payload.token;
}

async function startServerRecording(attemptId: string) {
  const response = await fetch("/api/livekit/start-recording", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ attemptId }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    throw new Error(payload?.error ?? "Failed to start recording");
  }

  const payload = (await response.json()) as {
    egressId?: string;
    skipped?: boolean;
  };

  if (payload.skipped) {
    return null;
  }

  if (!payload.egressId) {
    throw new Error("Recording API did not return an egress id");
  }

  return payload.egressId;
}

async function stopServerRecording(egressId: string) {
  await fetch("/api/livekit/stop-recording", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ egressId }),
    keepalive: true,
  });
}

export default function VideoPanel({
  attemptId,
  timeLeft,
  reconnectKey = 0,
  sessionQuestionId = "",
  questionText = "",
  transcript = "",
  verisState = "idle",
  onVideoReady,
  onCameraStatusChange,
  onRoomConnectionChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const onCameraStatusChangeRef = useRef(onCameraStatusChange);
  const onRoomConnectionChangeRef = useRef(onRoomConnectionChange);
  const hasConnectedRoomRef = useRef(false);
  const roomRef = useRef<Room | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recordingEgressIdRef = useRef<string | null>(null);
  const recordingStartedRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const recordingContextRef = useRef({
    questionId: sessionQuestionId,
    questionText,
    transcript,
    verisState,
  });
  const elapsedSeconds = timeLeft ?? 0;
  const minutes = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  useEffect(() => {
    recordingContextRef.current = {
      questionId: sessionQuestionId,
      questionText,
      transcript,
      verisState,
    };

    const room = roomRef.current;
    if (!room || !hasConnectedRoomRef.current) {
      return;
    }

    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: "veris.interview_context",
        publishedAt: Date.now(),
        ...recordingContextRef.current,
      }),
    );

    void room.localParticipant
      .publishData(payload, {
        reliable: true,
        topic: "veris-interview-context",
      })
      .catch((error) => {
        console.warn("Unable to update recording context:", error);
      });
  }, [questionText, sessionQuestionId, transcript, verisState]);

  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);

  useEffect(() => {
    onCameraStatusChangeRef.current = onCameraStatusChange;
  }, [onCameraStatusChange]);

  useEffect(() => {
    onRoomConnectionChangeRef.current = onRoomConnectionChange;
  }, [onRoomConnectionChange]);

  useEffect(() => {
    const videoElement = videoRef.current;

    async function startCamera() {
      try {
        let stream: MediaStream;

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
        } catch (combinedMediaError) {
          console.warn(
            "Microphone was unavailable; retrying camera-only preview:",
            combinedMediaError,
          );
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        cameraStreamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.style.filter = "brightness(0.85) contrast(1.1)";

          videoRef.current.onloadedmetadata = () => {
            console.log("Video ready");

            if (onVideoReadyRef.current) {
              onVideoReadyRef.current(videoRef);
            }
          };
        }

        onCameraStatusChangeRef.current?.(true);
      } catch (err) {
        console.error("Camera error:", err);
        onCameraStatusChangeRef.current?.(false);
      }
    }

    startCamera();

    return () => {
      if (videoElement) {
        videoElement.srcObject = null;
      }

      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      onCameraStatusChangeRef.current?.(false);
    };
  }, [reconnectKey]);

  useEffect(() => {
    if (!isValidAttemptId(attemptId)) {
      return;
    }

    const liveKitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!liveKitUrl) {
      console.error("NEXT_PUBLIC_LIVEKIT_URL is not configured");
      return;
    }

    let cancelled = false;
    const room = new Room();
    roomRef.current = room;
    let contextTimer: ReturnType<typeof setInterval> | null = null;

    async function publishRecordingContext() {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "veris.interview_context",
          publishedAt: Date.now(),
          ...recordingContextRef.current,
        }),
      );

      await room.localParticipant.publishData(payload, {
        reliable: true,
        topic: "veris-interview-context",
      });
    }

    async function ensureRecordingStarted() {
      const safeAttemptId = attemptId?.trim();

      if (!isValidAttemptId(safeAttemptId) || recordingStartedRef.current) {
        return;
      }

      recordingStartedRef.current = true;
      stopRequestedRef.current = false;

      try {
        recordingEgressIdRef.current = await startServerRecording(safeAttemptId);
      } catch (error) {
        recordingStartedRef.current = false;
        console.error("Unable to start LiveKit recording:", error);
      }
    }

    async function ensureRecordingStopped() {
      const egressId = recordingEgressIdRef.current;

      if (!egressId || stopRequestedRef.current) {
        return;
      }

      stopRequestedRef.current = true;
      recordingEgressIdRef.current = null;

      try {
        await stopServerRecording(egressId);
      } catch (error) {
        console.error("Unable to stop LiveKit recording:", error);
      } finally {
        recordingStartedRef.current = false;
      }
    }

    async function publishCamera() {
      try {
        const safeAttemptId = attemptId?.trim();

        if (!isValidAttemptId(safeAttemptId)) {
          return;
        }

        const token = await fetchLiveKitPublisherToken(safeAttemptId);
        await room.connect(liveKitUrl!, token);
        hasConnectedRoomRef.current = true;
        onRoomConnectionChangeRef.current?.("connected");

        const stream =
          cameraStreamRef.current ??
          (await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          }));

        cameraStreamRef.current = stream;

        if (cancelled) {
          room.disconnect();
          return;
        }

        const [videoTrack] = stream.getVideoTracks();

        if (!videoTrack) {
          throw new Error("Camera track is not available");
        }

        await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.Camera,
        });

        const [audioTrack] = stream.getAudioTracks();
        if (audioTrack) {
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.Microphone,
          });
        } else {
          console.warn(
            "LiveKit recording started without a microphone track.",
          );
        }

        await publishRecordingContext();
        contextTimer = setInterval(() => {
          void publishRecordingContext().catch((error) => {
            console.warn("Unable to refresh recording context:", error);
          });
        }, 2_000);

        await ensureRecordingStarted();
      } catch (error) {
        console.error("Unable to publish LiveKit camera feed:", error);
        onRoomConnectionChangeRef.current?.("disconnected");
      }
    }

    room.on("reconnecting", () => {
      if (hasConnectedRoomRef.current) {
        onRoomConnectionChangeRef.current?.("reconnecting");
      }
    });
    room.on("reconnected", () => {
      hasConnectedRoomRef.current = true;
      onRoomConnectionChangeRef.current?.("connected");
    });
    room.on("disconnected", () => {
      if (hasConnectedRoomRef.current) {
        onRoomConnectionChangeRef.current?.("disconnected");
      }
    });

    void publishCamera();

    return () => {
      cancelled = true;
      if (contextTimer) {
        clearInterval(contextTimer);
      }
      void ensureRecordingStopped();
      room.disconnect();
      roomRef.current = null;
      hasConnectedRoomRef.current = false;
    };
  }, [attemptId, reconnectKey]);

  return (
    <section className="overflow-hidden rounded-[20px] border border-white/[0.11] bg-[#0c121d] shadow-[0_24px_70px_rgba(0,0,0,0.3)]">
      <div className="flex h-12 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.45)]" />
          <span className="text-xs font-medium text-slate-200">Candidate camera</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Live preview
        </span>
      </div>

      <div className="relative aspect-video w-full overflow-hidden bg-[#05080d]">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/10 bg-[#080b10]/80 px-2.5 py-1.5 backdrop-blur-md">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400/60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-400" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-slate-300">
            Recording
          </span>
          <span className="border-l border-white/10 pl-2 font-mono text-[11px] tabular-nums text-white/75">
            {minutes}:{seconds}
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/55 to-transparent px-4 pb-3 pt-12">
          <span className="text-[11px] text-white/65">
            Keep your face centered and well lit
          </span>
          <span className="rounded bg-black/35 px-2 py-1 text-[10px] text-white/55 backdrop-blur-sm">
            You
          </span>
        </div>
      </div>
    </section>
  );
}
