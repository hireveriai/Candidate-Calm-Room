"use client";

export default function CalmHeader() {
  return (
    <div className="w-full px-8 py-4 flex items-center justify-between border-b border-white/10">

      {/* LEFT */}
      <div>
        <h1 className="text-sm tracking-[0.4em] text-white/80">
          V E R I S
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          Cognitive Interview Guide
        </p>
      </div>

      {/* RIGHT (empty, exit handled separately) */}
      <div />
    </div>
  );
}