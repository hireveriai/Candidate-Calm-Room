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
    <div className="relative min-h-screen w-full overflow-y-auto bg-white px-5 py-10 text-slate-900 sm:px-6 sm:py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(90rem_45rem_at_50%_-20%,rgba(6,182,212,0.10),transparent_60%),radial-gradient(60rem_35rem_at_100%_110%,rgba(15,23,42,0.06),transparent_65%)]"
      />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col">
        <header className="flex flex-col items-center text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-700">
            {resumeAvailable ? "Session retained" : "Final step"}
          </p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            {resumeAvailable
              ? "Your interview is ready to resume"
              : "You are about to begin the interview"}
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-slate-500 sm:text-base">
            {resumeAvailable
              ? "Your current question is safely retained. Confirm your devices below to restore your camera, microphone, and interview session."
              : "Take a moment to set yourself up, then confirm your camera and microphone are working."}
          </p>
        </header>

        <section className="mt-10 grid grid-cols-1 items-start gap-6 lg:grid-cols-2 lg:gap-8">
          <div className="rounded-[26px] border border-slate-200/80 bg-white p-5 shadow-[0_30px_80px_-45px_rgba(15,23,42,0.45)] sm:p-6">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
              Device check
            </p>
            <DeviceCheck
              onVerifiedChange={setDevicesVerified}
              registerStreamRelease={registerStreamRelease}
            />
          </div>

          <div className="flex flex-col gap-6">
            {!resumeAvailable && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {PREPARATION_TIPS.map(({ icon: Icon, title, body }) => (
                  <div
                    key={title}
                    className="flex h-full flex-col rounded-2xl border border-slate-200 bg-slate-50/70 p-5 transition-colors hover:border-cyan-200 hover:bg-cyan-50/50"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-100 bg-white text-cyan-600 shadow-sm">
                      <Icon className="h-5 w-5" strokeWidth={1.75} />
                    </span>
                    <p className="mt-4 text-sm font-semibold text-slate-900">{title}</p>
                    <p className="mt-1 text-[13px] leading-6 text-slate-500">{body}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-[26px] border border-slate-200/80 bg-white p-6 text-center shadow-[0_30px_80px_-45px_rgba(15,23,42,0.45)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-400">
                {devicesVerified
                  ? resumeAvailable
                    ? "Resume securely"
                    : "When ready"
                  : "Complete the device check to continue"}
              </p>

              <button
                onClick={handleStart}
                disabled={!devicesVerified}
                className="mt-5 w-full rounded-xl bg-slate-900 px-7 py-3.5 text-sm font-semibold text-white shadow-[0_18px_40px_-20px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none sm:text-base"
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
