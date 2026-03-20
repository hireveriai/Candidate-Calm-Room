"use client";

export default function PrecheckScreen({
  onStart,
}: {
  onStart: () => void;
}) {
  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0B0F1A] text-white">
      <h1 className="text-xl mb-6">Ready to begin your interview?</h1>

      <button
        onClick={onStart}
        className="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 rounded-lg text-black font-medium"
      >
        Begin Interview
      </button>
    </div>
  );
}