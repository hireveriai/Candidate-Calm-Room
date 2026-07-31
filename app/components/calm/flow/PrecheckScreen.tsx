"use client";

export default function PrecheckScreen({
  onStart,
  resumeAvailable = false,
}: {
  onStart: () => void;
  resumeAvailable?: boolean;
}) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
      <div className="max-w-xl text-center">
        <h1 className="mb-5 text-2xl font-medium tracking-[0.04em]">
          {resumeAvailable ? "Your interview is ready to resume" : "You are about to begin the interview"}
        </h1>

        <div className="mb-8 space-y-2 text-sm leading-7 text-white/72 md:text-base">
          {resumeAvailable ? (
            <p>
              Your current question is safely retained. Tap below to restore your camera,
              microphone, and interview session.
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

        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-cyan-300/70">
          {resumeAvailable ? "Resume securely" : "When ready"}
        </p>
      </div>

      <button
        onClick={onStart}
        className="rounded-lg bg-cyan-500 px-6 py-3 font-medium text-black transition-colors hover:bg-cyan-400"
      >
        {resumeAvailable ? "Resume Interview" : "Begin Interview"}
      </button>
    </div>
  );
}
