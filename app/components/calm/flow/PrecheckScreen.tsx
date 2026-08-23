"use client";

import { useCallback, useRef, useState } from "react";
import { Armchair, Camera, PersonStanding, Wind } from "lucide-react";

import DeviceCheck from "./DeviceCheck";

const PREPARATION_TIPS = [
  {
    icon: Armchair,
    title: "Get comfortable",
    body: "Settle into a seat you can hold for the whole conversation.",
  },
  {
    icon: PersonStanding,
    title: "Steady your posture",
    body: "Sit upright and centred so you stay in frame throughout.",
  },
  {
    icon: Camera,
    title: "Face the camera",
    body: "Look into the lens the way you would meet someone’s eyes.",
  },
  {
    icon: Wind,
    title: "Breathe steadily",
    body: "A slow breath before you begin keeps your pace calm.",
  },
];

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
    <div className="relative min-h-screen w-full bg-gradient-to-b from-sky-50 via-white to-cyan-50/70 px-4 py-6 text-slate-900 sm:px-6 lg:h-screen lg:overflow-hidden lg:py-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70rem_35rem_at_50%_-15%,rgba(14,165,233,0.16),transparent_60%),radial-gradient(55rem_30rem_at_100%_110%,rgba(20,184,166,0.14),transparent_65%)]"
      />

      <div className="relative mx-auto flex h-full w-full max-w-5xl flex-col justify-center">
        <header className="flex flex-col items-center text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-sky-700">
            {resumeAvailable ? "Session retained" : "Final step"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[32px]">
            {resumeAvailable
              ? "Your interview is ready to resume"
              : "You are about to begin the interview"}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
            {resumeAvailable
              ? "Your current question is safely retained. Confirm your devices below to restore your camera, microphone, and interview session."
              : "Take a moment to set yourself up, then confirm your camera and microphone are working."}
          </p>
        </header>

        <section className="mt-5 grid grid-cols-1 items-start gap-4 lg:grid-cols-2 lg:gap-6">
          <div className="rounded-[22px] border border-sky-100 bg-white/90 p-4 shadow-[0_24px_60px_-38px_rgba(12,74,110,0.55)] ring-1 ring-white/70 sm:p-5">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-700/80">
              Device check
            </p>
            <DeviceCheck
              onVerifiedChange={setDevicesVerified}
              registerStreamRelease={registerStreamRelease}
            />
          </div>

          <div className="flex flex-col gap-4">
            {!resumeAvailable && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PREPARATION_TIPS.map(({ icon: Icon, title, body }) => (
                  <div
                    key={title}
                    className="flex h-full flex-col rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50 to-cyan-50/60 p-4 shadow-[0_10px_24px_-20px_rgba(12,74,110,0.7)] transition hover:border-sky-200 hover:from-sky-100/80 hover:to-cyan-100/60"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-sky-600 shadow-sm ring-1 ring-sky-100">
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
                    <p className="mt-0.5 text-[13px] leading-5 text-slate-500">{body}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-[22px] border border-sky-100 bg-white/90 p-4 text-center shadow-[0_24px_60px_-38px_rgba(12,74,110,0.55)] ring-1 ring-white/70">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-sky-700/80">
                {devicesVerified
                  ? resumeAvailable
                    ? "Resume securely"
                    : "When ready"
                  : "Complete the device check to continue"}
              </p>

              <button
                onClick={handleStart}
                disabled={!devicesVerified}
                className="mt-3 w-full rounded-xl bg-gradient-to-r from-sky-600 to-teal-600 px-7 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-18px_rgba(2,132,199,0.95)] transition hover:from-sky-700 hover:to-teal-700 disabled:cursor-not-allowed disabled:bg-none disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none sm:text-base"
              >
                {resumeAvailable ? "Resume Interview" : "Begin Interview"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
