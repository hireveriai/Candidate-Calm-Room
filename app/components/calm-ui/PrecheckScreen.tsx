"use client";

export default function PrecheckScreen({ onStart }: { onStart: () => void }) {

  function handleStart() {
    const el = document.documentElement;

    try {
      if (el.requestFullscreen) {
        el.requestFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen failed:", err);
    }

    onStart(); // 🔥 AFTER fullscreen call
  }

  return (
    <div className="h-[100dvh] w-full bg-black text-white flex flex-col items-center justify-center">

      <div className="mb-12 text-center">
        <div className="text-sm tracking-[0.4em] text-white/60">
          V E R I S
        </div>
        <div className="text-xs text-white/40">
          Cognitive Interview Guide
        </div>
      </div>

      <div className="mb-6 text-sm text-white/50 text-center">
        This interview will enter fullscreen mode.
      </div>

      <button
        onClick={handleStart}
        className="
        px-10 py-4 rounded-full
        border border-cyan-400/40
        text-cyan-200 tracking-[0.3em]
        hover:bg-cyan-400/10 transition
        "
      >
        BEGIN INTERVIEW
      </button>

    </div>
  );
}