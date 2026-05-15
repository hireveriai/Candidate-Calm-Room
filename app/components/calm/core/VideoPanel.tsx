"use client";

import { useEffect, useRef } from "react";
import { Room, Track } from "livekit-client";
import type { RefObject } from "react";

type Props = {
  attemptId?: string;
  timeLeft?: number;
  reconnectKey?: number;
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
  onVideoReady,
  onCameraStatusChange,
  onRoomConnectionChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const onCameraStatusChangeRef = useRef(onCameraStatusChange);
  const onRoomConnectionChangeRef = useRef(onRoomConnectionChange);
  const hasConnectedRoomRef = useRef(false);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recordingEgressIdRef = useRef<string | null>(null);
  const recordingStartedRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const elapsedSeconds = timeLeft ?? 0;
  const minutes = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
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
            audio: false,
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
      void ensureRecordingStopped();
      room.disconnect();
      hasConnectedRoomRef.current = false;
    };
  }, [attemptId, reconnectKey]);

  return (
    <div className="mt-10 flex w-full justify-center">
      <div className="relative h-[260px] w-[420px] overflow-hidden rounded-2xl border border-cyan-500/10 bg-black shadow-[0_0_40px_rgba(0,255,255,0.08)]">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full border border-red-500/35 bg-black/55 px-3 py-1.5 shadow-[0_0_18px_rgba(239,68,68,0.22)] backdrop-blur-sm">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="text-[10px] font-semibold tracking-[0.22em] text-red-400">
            REC
          </span>
          <span className="text-sm font-semibold tabular-nums text-red-300">
            {minutes}:{seconds}
          </span>
        </div>
      </div>
    </div>
  );
}
