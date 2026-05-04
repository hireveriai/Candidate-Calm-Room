"use client";

import { useEffect, useRef } from "react";
import { Room, Track } from "livekit-client";
import type { RefObject } from "react";

type Props = {
  attemptId?: string;
  timeLeft?: number;
  onVideoReady?: (ref: RefObject<HTMLVideoElement | null>) => void;
};

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

export default function VideoPanel({ attemptId, timeLeft, onVideoReady }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const elapsedSeconds = timeLeft ?? 0;
  const minutes = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);

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
      } catch (err) {
        console.error("Camera error:", err);
      }
    }

    startCamera();

    return () => {
      if (videoElement) {
        videoElement.srcObject = null;
      }

      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!attemptId) {
      return;
    }

    const liveKitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

    if (!liveKitUrl) {
      console.error("NEXT_PUBLIC_LIVEKIT_URL is not configured");
      return;
    }

    let cancelled = false;
    const room = new Room();

    async function publishCamera() {
      try {
        const token = await fetchLiveKitPublisherToken(attemptId!);
        await room.connect(liveKitUrl!, token);

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
      } catch (error) {
        console.error("Unable to publish LiveKit camera feed:", error);
      }
    }

    void publishCamera();

    return () => {
      cancelled = true;
      room.disconnect();
    };
  }, [attemptId]);

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
