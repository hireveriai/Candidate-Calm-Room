"use client";

export default function PrecheckScreen({
  onStart,
}: {
  onStart: () => void;
}) {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
      <div className="max-w-xl text-center">
        <h1 className="mb-5 text-2xl font-medium tracking-[0.04em]">
          You are about to begin the interview
        </h1>

        <div className="mb-8 space-y-2 text-sm leading-7 text-white/72 md:text-base">
          <p>Ensure you are seated comfortably.</p>
          <p>Stabilize your posture.</p>
          <p>Focus on the camera.</p>
          <p>Breathe steadily.</p>
        </div>

        <p className="mb-4 text-xs uppercase tracking-[0.28em] text-cyan-300/70">
          When ready
        </p>
      </div>

      <button
        onClick={onStart}
        className="rounded-lg bg-cyan-500 px-6 py-3 font-medium text-black transition-colors hover:bg-cyan-400"
      >
        Begin Interview
      </button>
    </div>
  );
}
