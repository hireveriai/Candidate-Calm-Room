"use client";

import { useCallback, useRef, useState } from "react";

import DeviceCheck from "./DeviceCheck";

export default function PrecheckScreen({
  onStart,
  resumeAvailable = false,
}: {
  onStart: () => void;
  resumeAvailable?: boolean;
}) {
  const [devicesVerified, setDevicesVerified] = useState(false);
  const releaseStreamRef = useRef<(() => void) | null>(null);

  const registerStreamRelease = useCallback((release: () => void) => {
    releaseStreamRef.current = release;
  }, []);

  const handleStart = () => {
    // Hand the camera back before the interview claims it, otherwise the
    // session's own getUserMedia can hit NotReadableError on devices that do
    // not allow two concurrent captures. Kept synchronous so the click remains
    // a valid user-activation gesture for fullscreen and audio unlock.
    releaseStreamRef.current?.();
    onStart();
  };

  return (
    <div className="flex min-h-screen w-screen flex-col items-center justify-center gap-6 bg-[#0B0F1A] px-6 py-10 text-white">
      <div className="max-w-xl text-center">
        <h1 className="mb-5 text-2xl font-medium tracking-[0.04em]">
          {resumeAvailable
            ? "Your interview is ready to resume"
            : "You are about to begin the interview"}
        </h1>

        <div className="mb-2 space-y-2 text-sm leading-7 text-white/72 md:text-base">
          {resumeAvailable ? (
            <p>
              Your current question is safely retained. Tap below to restore your
              camera, microphone, and interview session.
            </p>
          ) : (
            <>
              <p>Ensure you are seated comfortably.</p>
              <p>Stabilize your posture.</p>
              <p>Focus on the camera.</p>
              <p>Breathe steadily.</p>
            </>
          )}
        </div>
      </div>

      <DeviceCheck
        onVerifiedChange={setDevicesVerified}
        registerStreamRelease={registerStreamRelease}
      />

      <div className="flex flex-col items-center">
        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-cyan-300/70">
          {devicesVerified
            ? resumeAvailable
              ? "Resume securely"
              : "When ready"
            : "Complete the device check to continue"}
        </p>

        <button
          onClick={handleStart}
          disabled={!devicesVerified}
          className="rounded-lg bg-cyan-500 px-6 py-3 font-medium text-black transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/40 disabled:hover:bg-white/15"
        >
          {resumeAvailable ? "Resume Interview" : "Begin Interview"}
        </button>
      </div>
    </div>
  );
}
