"use client";

import { useEffect, useRef } from "react";

export default function VideoPanel() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.style.filter = "brightness(0.85) contrast(1.1)";
        }
      } catch (err) {
        console.error(err);
      }
    }

    startCamera();
  }, []);

  return (
    <div className="w-full flex justify-center mt-10">
      <div className="w-[420px] h-[260px] rounded-2xl overflow-hidden bg-black border border-cyan-500/10 shadow-[0_0_40px_rgba(0,255,255,0.08)]">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />
      </div>
    </div>
  );
}