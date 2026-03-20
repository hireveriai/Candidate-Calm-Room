"use client";

export default function InterviewHeader() {
  return (
    <div className="h-full flex items-center justify-between px-6">

      {/* LEFT */}
      <div>
        <div className="text-sm tracking-[0.4em] text-white/70">
          V E R I S
        </div>
        <div className="text-xs text-white/40">
          Cognitive Interview Guide
        </div>
      </div>

      {/* RIGHT */}
      <button
        className="
        px-4 py-2 rounded-full
        border border-red-400/40
        text-red-400 text-xs
        hover:bg-red-500/10
        transition
        "
      >
        Exit
      </button>

    </div>
  );
}