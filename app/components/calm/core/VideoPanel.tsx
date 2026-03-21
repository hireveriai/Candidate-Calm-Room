"use client";

import { useEffect, useRef } from "react";

type Props = {
  timeLeft?: number;
  onVideoReady?: (ref: any) => void;
};

export default function VideoPanel({ timeLeft, onVideoReady }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);

  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        activeStream = stream;

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
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      activeStream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
            {timeLeft}s
          </span>
        </div>
      </div>
    </div>
  );
}
